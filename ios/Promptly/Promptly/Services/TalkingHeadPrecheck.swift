import AVFoundation
import Vision
import Foundation
import CoreMedia

/// On-device "is this a talking head?" pre-check that runs in <1s
/// before any upload starts. Samples 8 evenly-spaced frames and runs
/// Apple's Vision face detector on each; if fewer than 30% of the
/// sampled frames contain a sufficiently-large face the video gets
/// rejected and the user is prompted to pick a different clip.
///
/// **Why this matters:** the previous flow uploaded the entire source
/// (10-100 MB) and ran a backend pipeline before the user discovered
/// the clip wasn't compatible. That ~60-second feedback loop is the
/// single biggest "looks broken" failure mode users hit. This check
/// gives them an answer before any bytes leave the device.
///
/// **Why only local files:** for iCloud-only assets, sampling 8 frames
/// would require a per-frame iCloud download (single-second per frame),
/// which defeats the "instant feedback" promise. iCloud-only assets
/// skip Layer 1 and rely on Layer 2 (backend /validate) for the same
/// signal at a slightly higher latency.
enum TalkingHeadPrecheck {

    /// Minimum / maximum source length Promptly can edit. The max mirrors the
    /// server's CLIP_TOO_LONG (3 min, the 2026-07 lockstep); the min filters
    /// clips too short to yield a watchable edit.
    static let minDurationSec = 3
    static let maxDurationSec = 180

    /// Deterministic, near-instant AV prechecks that run BEFORE the face check
    /// and before any upload. Each is a HARD block (no "try anyway") because the
    /// pipeline cannot succeed: no audio → nothing to caption/cut to; too short →
    /// no watchable edit; too long → over the render ceiling. Fail-open on any
    /// load error (let the backend make the call). `.ok` proceeds to the face check.
    enum Preflight: Equatable {
        case ok
        case noAudio
        case tooShort(minSeconds: Int)
        case tooLong(maxSeconds: Int)
    }

    static func preflight(videoURL: URL) async -> Preflight {
        let asset = AVURLAsset(url: videoURL)
        // Duration bounds (only when we can actually read the duration).
        if let duration = try? await asset.load(.duration), duration.seconds > 0 {
            let secs = duration.seconds
            if secs < Double(minDurationSec) { return .tooShort(minSeconds: minDurationSec) }
            if secs > Double(maxDurationSec) { return .tooLong(maxSeconds: maxDurationSec) }
        }
        // Audio track present? Empty (successfully-loaded) audio-track list = no
        // sound. A load error falls through to .ok (fail-open, backend catches).
        if let audioTracks = try? await asset.loadTracks(withMediaType: .audio), audioTracks.isEmpty {
            return .noAudio
        }
        return .ok
    }

    /// The measured signal behind the talking-head verdict. `pass` is the gate
    /// (faceRatio >= 0.30); the rest exist so a REJECTION is inspectable even
    /// though it produces no upload/artifact to look at:
    ///   - faceRatio:    fraction of sampled frames with a face WIDER than 10% of
    ///                   the frame (the gated detection rate — what the bar uses).
    ///   - anyFaceRatio: fraction of frames with ANY face detected regardless of
    ///                   width. anyFaceRatio ≫ faceRatio ⇒ the 10%-width SIZE
    ///                   FLOOR is doing the rejecting (a real person at medium
    ///                   distance in a wide shot), NOT the detector — a second
    ///                   over-rejection axis independent of Vision accuracy.
    ///   - maxFaceWidth: largest face width seen (fraction of frame), 0 if none.
    ///   - samples:      frames actually analysed (≤8).
    struct FaceCheckResult {
        let pass: Bool
        let faceRatio: Double
        let anyFaceRatio: Double
        let maxFaceWidth: Double
        let samples: Int
        /// Fail-open sentinel (pass:true, -1 measurements) for the cases where we
        /// couldn't analyse the clip — carried but never logged, since pass:true
        /// emits no rejection event.
        static let failOpen = FaceCheckResult(pass: true, faceRatio: -1, anyFaceRatio: -1, maxFaceWidth: -1, samples: 0)
    }

    /// Sample 8 evenly-spaced frames; pass if ≥30% contain a face wider than 10%
    /// of the frame. Fail-OPEN (pass:true) when the asset can't be sampled — we'd
    /// rather upload a borderline clip than reject something we can't analyze.
    /// Returns the full FaceCheckResult so a rejection's faceRatio + width
    /// distribution are logged (a precheck reject leaves no artifact to inspect).
    static func quickCheck(videoURL: URL) async -> FaceCheckResult {
        let asset = AVURLAsset(url: videoURL)

        // Get duration. If asset metadata can't load (corrupt, weird
        // container), let it through and let the backend make the call.
        guard let duration = try? await asset.load(.duration),
              duration.seconds > 0 else {
            return .failOpen
        }

        let totalSeconds = duration.seconds
        // Skip the leading/trailing 5% — opening credits / fade-out are
        // common and can show no face even on a valid talking-head clip.
        let startSec = totalSeconds * 0.05
        let endSec = totalSeconds * 0.95
        let stride = (endSec - startSec) / 8.0
        let timestamps: [CMTime] = (0..<8).map { i in
            CMTime(seconds: startSec + Double(i) * stride,
                   preferredTimescale: 600)
        }

        let generator = AVAssetImageGenerator(asset: asset)
        // Apply the source's preferred transform so the face detector
        // sees the video right-side up; otherwise portrait clips shot
        // in landscape orientation get analyzed sideways and the face
        // bounding boxes come out wrong.
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.1, preferredTimescale: 600)

        var faceHits = 0
        var anyFaceFrames = 0
        var maxFaceWidth = 0.0
        var samples = 0
        let t0 = Date()

        for ts in timestamps {
            do {
                let cgImage = try await generator.image(at: ts).image
                samples += 1

                let request = VNDetectFaceRectanglesRequest()
                let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
                try handler.perform([request])

                guard let results = request.results, !results.isEmpty else { continue }
                // Largest face wins. The 10% width threshold filters out tiny
                // background bystanders (someone walking past in a street vlog)
                // without rejecting normal medium-shots — but it is ALSO a
                // potential over-rejection: a real person at medium distance in a
                // wide shot can fall under it even with an accurate detector. So we
                // track anyFaceFrames + maxFaceWidth alongside the gated hit count
                // to tell "no face" apart from "face present but under the floor."
                let largest = results.max { $0.boundingBox.width < $1.boundingBox.width }
                if let face = largest {
                    anyFaceFrames += 1
                    maxFaceWidth = max(maxFaceWidth, face.boundingBox.width)
                    if face.boundingBox.width > 0.10 {
                        faceHits += 1
                    }
                }
            } catch {
                // Skip unreadable frames silently — they don't count as
                // either hits or misses, but they reduce confidence.
                continue
            }
        }

        let elapsed = Date().timeIntervalSince(t0)

        // Confidence floor: if we couldn't sample at least 4 frames the
        // verdict isn't trustworthy. Let the upload through and rely on
        // backend validation rather than rejecting on weak signal.
        guard samples >= 4 else {
            print(String(format: "[precheck] inconclusive (%d/8 samples) in %.2fs — letting through",
                         samples, elapsed))
            return .failOpen
        }

        let faceRatio = Double(faceHits) / Double(samples)
        let anyFaceRatio = Double(anyFaceFrames) / Double(samples)
        let pass = faceRatio >= 0.30
        print(String(format: "[precheck] %d/%d faces>10%% (anyFace %d, maxW %.2f) %.0f%% in %.2fs → %@",
                     faceHits, samples, anyFaceFrames, maxFaceWidth, faceRatio * 100, elapsed,
                     pass ? "PASS" : "REJECT"))
        return FaceCheckResult(pass: pass, faceRatio: faceRatio, anyFaceRatio: anyFaceRatio,
                               maxFaceWidth: maxFaceWidth, samples: samples)
    }
}

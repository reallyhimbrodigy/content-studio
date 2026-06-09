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

    /// Sample 8 evenly-spaced frames; return true if ≥30% contain a
    /// face wider than 10% of the frame. Returns true (not false) when
    /// the asset can't be sampled at all — we'd rather upload a
    /// borderline clip than reject something we can't analyze.
    static func quickCheck(videoURL: URL) async -> Bool {
        let asset = AVURLAsset(url: videoURL)

        // Get duration. If asset metadata can't load (corrupt, weird
        // container), let it through and let the backend make the call.
        guard let duration = try? await asset.load(.duration),
              duration.seconds > 0 else {
            return true
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
                // Largest face wins. The 10% width threshold filters out
                // tiny background bystanders (someone walking past in a
                // street vlog) without rejecting normal medium-shots.
                let largest = results.max { $0.boundingBox.width < $1.boundingBox.width }
                if let face = largest, face.boundingBox.width > 0.10 {
                    faceHits += 1
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
            return true
        }

        let faceRatio = Double(faceHits) / Double(samples)
        let pass = faceRatio >= 0.30
        print(String(format: "[precheck] %d/%d faces (%.0f%%) in %.2fs → %@",
                     faceHits, samples, faceRatio * 100, elapsed,
                     pass ? "PASS" : "REJECT"))
        return pass
    }
}

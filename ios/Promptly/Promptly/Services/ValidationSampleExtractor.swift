import AVFoundation
import Foundation
import CoreMedia

/// Extracts a short representative sample from the source video for
/// the backend /validate round-trip. Used as part of Layer 2 of the
/// three-layer pick-then-validate flow: after Layer 1's on-device
/// Vision precheck passes (or the user taps "Try Anyway"), the
/// client extracts ~5s of footage starting 20% into the clip,
/// uploads it to S3, and POSTs the URL to the Modal /validate
/// endpoint. Modal runs a higher-confidence content check on the
/// sample and returns is_talking_head plus a user-facing message
/// describing the reason if it rejects.
///
/// Why 5s starting at 20%: gets past any cold open / pre-roll, lands
/// on representative middle-of-the-clip content, and keeps the upload
/// + analysis under ~7s total wall-clock.
///
/// Why AVAssetExportPresetMediumQuality: extraction speed matters
/// more than absolute fidelity here — the backend is doing face
/// detection on it, not pixel-peeping. Medium quality is the fastest
/// preset that still produces a clean H.264 MP4 the backend can read.
@MainActor
enum ValidationSampleExtractor {

    enum ExtractError: Error, LocalizedError {
        case sessionInitFailed
        case exportFailed(String)
        case durationUnreadable

        var errorDescription: String? {
            switch self {
            case .sessionInitFailed: return "Couldn't initialize sample exporter"
            case .exportFailed(let s): return "Sample extraction failed: \(s)"
            case .durationUnreadable: return "Source video duration is unreadable"
            }
        }
    }

    /// Extract a ~5-second validation sample to the app's temp directory.
    /// Caller is responsible for cleanup after upload completes.
    static func extract(from sourceUrl: URL) async throws -> URL {
        let asset = AVURLAsset(url: sourceUrl)

        guard let duration = try? await asset.load(.duration), duration.seconds > 0 else {
            throw ExtractError.durationUnreadable
        }
        let totalSeconds = duration.seconds

        // Start at 20% into the source, take up to 5 seconds. Clamps
        // the sample to whatever remains for very short clips so
        // sub-5-second sources still get analyzed.
        let startSec = totalSeconds * 0.20
        let sampleSec = min(5.0, max(1.0, totalSeconds - startSec))
        let startTime = CMTime(seconds: startSec, preferredTimescale: 600)
        let sampleDuration = CMTime(seconds: sampleSec, preferredTimescale: 600)
        let timeRange = CMTimeRange(start: startTime, duration: sampleDuration)

        let outUrl = FileManager.default.temporaryDirectory
            .appendingPathComponent("validate-\(UUID().uuidString).mp4")
        try? FileManager.default.removeItem(at: outUrl)

        guard let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetMediumQuality) else {
            throw ExtractError.sessionInitFailed
        }
        exporter.outputURL = outUrl
        exporter.outputFileType = .mp4
        exporter.timeRange = timeRange
        exporter.shouldOptimizeForNetworkUse = true

        do {
            try await exporter.export(to: outUrl, as: .mp4)
        } catch {
            throw ExtractError.exportFailed(error.localizedDescription)
        }

        let size = (try? FileManager.default.attributesOfItem(atPath: outUrl.path)[.size] as? Int64) ?? 0
        let kb = Double(size) / 1024.0
        print(String(format: "[validate] sample extracted %.1fKB (start=%.1fs dur=%.1fs)",
                     kb, startSec, sampleSec))

        return outUrl
    }
}

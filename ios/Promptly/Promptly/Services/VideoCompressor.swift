import AVFoundation
import UIKit

enum VideoCompressor {
    /// Prepare a video for upload with ZERO quality loss whenever possible.
    ///
    /// Two-tier strategy:
    ///   1. Passthrough (lossless) — tries AVAssetExportPresetPassthrough first.
    ///      This COPIES the original encoded video/audio streams into an MP4
    ///      container without re-encoding. Original pixels preserved byte-
    ///      identical. Typical cost: <1s (just container remux).
    ///      Works on ~85% of Photos-library videos (already H.264/HEVC MP4).
    ///
    ///   2. HEVC re-encode (lossy fallback) — only when passthrough can't
    ///      handle the source (Dolby Vision HDR, slow-mo VFR, ProRes, some
    ///      legacy codecs). Uses AVAssetExportPresetHEVCHighestQuality which
    ///      is the highest-fidelity re-encode available on-device. Typical
    ///      cost: 2-10s.
    static func compress(sourceUrl: URL) async throws -> URL {
        let asset = AVURLAsset(url: sourceUrl)

        let outputUrl = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString + ".mp4")
        try? FileManager.default.removeItem(at: outputUrl)

        // ── Tier 1: lossless passthrough ─────────────────────────────────
        if let passthroughSession = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) {
            passthroughSession.outputURL = outputUrl
            passthroughSession.outputFileType = .mp4
            passthroughSession.shouldOptimizeForNetworkUse = true

            let started = Date()
            await passthroughSession.export()
            if passthroughSession.status == .completed {
                let elapsed = Date().timeIntervalSince(started)
                let sizeMB = fileSizeMB(outputUrl)
                print("[compress] passthrough OK in \(String(format: "%.2f", elapsed))s → \(String(format: "%.1f", sizeMB))MB (lossless remux)")
                return outputUrl
            }
            let errMsg = passthroughSession.error?.localizedDescription ?? "unknown"
            print("[compress] passthrough not applicable (\(errMsg)) — falling back to HEVC re-encode")
            try? FileManager.default.removeItem(at: outputUrl)
        }

        // ── Tier 2: HEVC highest-quality re-encode (fallback) ────────────
        let preset: String = {
            let compatible = AVAssetExportSession.allExportPresets()
            if compatible.contains(AVAssetExportPresetHEVCHighestQuality) {
                return AVAssetExportPresetHEVCHighestQuality
            }
            return AVAssetExportPresetHighestQuality
        }()

        guard let session = AVAssetExportSession(asset: asset, presetName: preset) else {
            throw CompressorError.sessionFailed
        }
        session.outputURL = outputUrl
        session.outputFileType = .mp4
        session.shouldOptimizeForNetworkUse = true

        let started = Date()
        await session.export()
        guard session.status == .completed else {
            throw CompressorError.exportFailed(session.error?.localizedDescription ?? "Unknown error")
        }
        let elapsed = Date().timeIntervalSince(started)
        let sizeMB = fileSizeMB(outputUrl)
        print("[compress] \(preset) re-encode in \(String(format: "%.2f", elapsed))s → \(String(format: "%.1f", sizeMB))MB")
        return outputUrl
    }

    /// Get file size in MB for logging
    static func fileSizeMB(_ url: URL) -> Double {
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
        return Double(size) / (1024 * 1024)
    }
}

enum CompressorError: LocalizedError {
    case sessionFailed
    case exportFailed(String)

    var errorDescription: String? {
        switch self {
        case .sessionFailed: return "Could not create export session"
        case .exportFailed(let msg): return "Export failed: \(msg)"
        }
    }
}

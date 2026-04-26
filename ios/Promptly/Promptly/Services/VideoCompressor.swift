import AVFoundation
import UIKit

enum VideoCompressor {
    /// Lossless container remux only — passthrough export. No fallback
    /// to HEVC re-encode. If the source isn't compatible with passthrough
    /// (Dolby Vision HDR, slow-mo VFR, ProRes, exotic codecs), we throw
    /// rather than silently re-encoding to a different codec and losing
    /// pixel fidelity. Caller decides whether to surface or skip.
    static func compress(sourceUrl: URL) async throws -> URL {
        let asset = AVURLAsset(url: sourceUrl)

        let outputUrl = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString + ".mp4")
        try? FileManager.default.removeItem(at: outputUrl)

        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else {
            throw CompressorError.sessionFailed
        }
        session.outputURL = outputUrl
        session.outputFileType = .mp4
        session.shouldOptimizeForNetworkUse = true

        let started = Date()
        await session.export()
        guard session.status == .completed else {
            let errMsg = session.error?.localizedDescription ?? "unknown"
            throw CompressorError.exportFailed(errMsg)
        }
        let elapsed = Date().timeIntervalSince(started)
        let sizeMB = fileSizeMB(outputUrl)
        print("[compress] passthrough OK in \(String(format: "%.2f", elapsed))s → \(String(format: "%.1f", sizeMB))MB (lossless remux)")
        return outputUrl
    }

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

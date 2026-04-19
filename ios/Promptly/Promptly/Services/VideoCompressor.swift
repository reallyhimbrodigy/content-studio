import AVFoundation
import UIKit

enum VideoCompressor {
    /// Compress video for upload — hardware-accelerated, ~2 seconds
    /// Reduces 100MB+ camera videos to ~15-20MB
    static func compress(sourceUrl: URL) async throws -> URL {
        let asset = AVURLAsset(url: sourceUrl)

        let outputUrl = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString + ".mp4")

        // Remove existing file if any
        try? FileManager.default.removeItem(at: outputUrl)

        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetMediumQuality) else {
            throw CompressorError.sessionFailed
        }

        session.outputURL = outputUrl
        session.outputFileType = .mp4
        session.shouldOptimizeForNetworkUse = true

        await session.export()

        guard session.status == .completed else {
            throw CompressorError.exportFailed(session.error?.localizedDescription ?? "Unknown error")
        }

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

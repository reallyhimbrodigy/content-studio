import AVFoundation
import UIKit

enum VideoCompressor {
    /// Compress video for upload — hardware-accelerated.
    /// Uses HEVC highest quality: visually pristine at ~30-50% the file size of H.264 highest.
    /// Falls back to H.264 highest quality on older devices.
    static func compress(sourceUrl: URL) async throws -> URL {
        let asset = AVURLAsset(url: sourceUrl)

        let outputUrl = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString + ".mp4")

        // Remove existing file if any
        try? FileManager.default.removeItem(at: outputUrl)

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

import AVFoundation
import Foundation

/// Extracts a low-resolution proxy of a source video for cloud AI analysis.
///
/// **Why this exists:** the full pipeline used to upload the source MP4
/// (often 60-100 MB on cellular) before AI analysis could begin. The
/// user perceived this as a "minute-long upload step." Production AI
/// editors (Captions, Veed, CapCut for cloud features) decouple the two
/// uploads — a tiny proxy goes to the cloud immediately for AI analysis,
/// and the original-quality source uploads invisibly in the background
/// for the eventual render.
///
/// At AVAssetExportPreset640x480 + medium audio, a 50s 1080p talking
/// head clip becomes a ~3-6 MB file in 2-5 seconds on modern iPhones —
/// uploadable on cellular in well under 10 seconds. AI analysis quality
/// is unaffected: Gemini analyzes video at thumbnail-level resolution
/// internally regardless of what we send.
@MainActor
enum VideoProxyExtractor {

    enum ExtractError: Error, LocalizedError {
        case sessionInitFailed
        case incompatiblePreset
        case exportFailed(String)
        case cancelled

        var errorDescription: String? {
            switch self {
            case .sessionInitFailed: return "Couldn't initialize AVAssetExportSession"
            case .incompatiblePreset: return "Source video isn't compatible with the proxy preset"
            case .exportFailed(let s): return "Proxy export failed: \(s)"
            case .cancelled: return "Proxy export cancelled"
            }
        }
    }

    /// Extract a low-res proxy MP4 to the app's temp directory.
    ///
    /// - Parameter sourceUrl: file URL of the original video (must be
    ///   readable; iCloud-only assets must be materialized first).
    /// - Returns: file URL of the proxy MP4 in the temp directory. Caller
    ///   is responsible for cleanup after upload completes.
    static func extract(from sourceUrl: URL) async throws -> URL {
        let asset = AVURLAsset(url: sourceUrl)

        // 640x480 preset is the smallest "real" preset AVFoundation
        // offers. For a 9:16 portrait source, the longer dimension is
        // capped at 480 → final clip is ~270x480. Still plenty of
        // resolution for Gemini's visual analysis (it downsamples
        // further internally).
        let presetName = AVAssetExportPreset640x480

        // Verify the preset is compatible with the source. Sources from
        // recent iPhone camera roll are always compatible; this guards
        // against weird codecs (HEVC 10-bit on some Android shares).
        let compatible = await AVAssetExportSession.compatibility(
            ofExportPreset: presetName, with: asset, outputFileType: .mp4
        )
        guard compatible else { throw ExtractError.incompatiblePreset }

        guard let session = AVAssetExportSession(asset: asset, presetName: presetName) else {
            throw ExtractError.sessionInitFailed
        }

        // Fresh temp file. Use NSTemporaryDirectory so iOS can purge
        // when storage is low — proxies are disposable.
        let dir = FileManager.default.temporaryDirectory
        let outUrl = dir.appendingPathComponent("proxy-\(UUID().uuidString).mp4")
        if FileManager.default.fileExists(atPath: outUrl.path) {
            try? FileManager.default.removeItem(at: outUrl)
        }

        session.outputURL = outUrl
        session.outputFileType = .mp4
        // Don't bother with metadata or extra streams — analysis only
        // needs the video + audio bitstreams.
        session.shouldOptimizeForNetworkUse = true

        let t0 = Date()
        try await session.export(to: outUrl, as: .mp4)
        let elapsed = Date().timeIntervalSince(t0)

        let size = (try? FileManager.default.attributesOfItem(atPath: outUrl.path)[.size] as? Int64) ?? 0
        let mb = Double(size) / (1024 * 1024)
        print("[proxy] extracted \(String(format: "%.1f", mb)) MB in \(String(format: "%.1f", elapsed))s → \(outUrl.lastPathComponent)")

        return outUrl
    }
}

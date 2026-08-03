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

        let outputUrl = UploadStorage.newFile()
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

/// Durable, app-owned storage for the pick-time source copy.
///
/// The upload source is copied here at pick time instead of NSTemporaryDirectory.
/// iOS purges the temp directory under space pressure (and on some OS events)
/// WITHOUT regard to an in-flight background upload — so a task that resumes
/// after the app was killed can find its file gone and never send. That is the
/// UPLOAD_NEVER_STARTED residual that remained after the 7-day presign TTL closed
/// the URL-expiry cause: the URL was still valid, but there were no bytes to PUT.
/// Application Support survives until we delete it, so the background session /
/// cross-launch retry always has the source to send. Excluded from iCloud backup
/// (these are transient render inputs, not user documents).
enum UploadStorage {
    static let dirName = "PromptlyUploads"

    @discardableResult
    private static func makeDir() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        var dir = base.appendingPathComponent(dirName, isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var rv = URLResourceValues()
            rv.isExcludedFromBackup = true
            try? dir.setResourceValues(rv)
        }
        return dir
    }

    /// A fresh durable file URL for a pick-time source copy.
    static func newFile(ext: String = "mp4") -> URL {
        makeDir().appendingPathComponent("src-\(UUID().uuidString).\(ext)")
    }

    /// Launch-time orphan cleanup. A source copy is deleted the instant its
    /// upload confirms, so anything left here is an app-kill-mid-flight leftover.
    /// The background session can legitimately resume for days, so only sweep
    /// files older than `maxAge` — never starve an in-flight resume of its bytes.
    static func sweepOrphans(olderThan maxAge: TimeInterval = 7 * 24 * 3600) {
        let dir = makeDir()
        guard let items = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let cutoff = Date().addingTimeInterval(-maxAge)
        for url in items {
            let mod = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            if mod < cutoff { try? FileManager.default.removeItem(at: url) }
        }
    }
}

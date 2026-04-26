import UIKit

/// Persistent disk cache for chat-message thumbnails.
///
/// Why this exists: a `ChatMessage` has a `videoAttachment.thumbnail`
/// of type `UIImage?`. UIImage doesn't survive JSON serialization, so
/// when we persist a chat to Supabase the thumbnail is dropped, and
/// the user-side bubble re-renders with no image after a chat reload.
///
/// This cache writes the JPEG to `~/Library/Caches/promptly-thumbs/`
/// keyed by message id. ChatStore writes on save, reads on restore.
/// Memory tier in front of the disk to keep scrolling cheap.
@MainActor
final class ThumbnailCache {
    static let shared = ThumbnailCache()

    private let cacheDir: URL
    private var memory: [String: UIImage] = [:]

    private init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        cacheDir = caches.appendingPathComponent("promptly-thumbs", isDirectory: true)
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
    }

    /// Persist a thumbnail keyed by the message's UUID string.
    func save(_ image: UIImage, for messageId: String) {
        memory[messageId] = image
        let url = cacheDir.appendingPathComponent("\(messageId).jpg")
        // 0.85 — visible quality, ~30-60KB per tile thumb.
        if let data = image.jpegData(compressionQuality: 0.85) {
            try? data.write(to: url, options: .atomic)
        }
    }

    /// Look up a cached thumbnail. Tries memory first, then falls back
    /// to disk and warms the memory tier on a hit.
    func load(for messageId: String) -> UIImage? {
        if let cached = memory[messageId] { return cached }
        let url = cacheDir.appendingPathComponent("\(messageId).jpg")
        guard let data = try? Data(contentsOf: url),
              let image = UIImage(data: data) else { return nil }
        memory[messageId] = image
        return image
    }

    /// Delete the cached thumbnail for a single message.
    func delete(for messageId: String) {
        memory.removeValue(forKey: messageId)
        let url = cacheDir.appendingPathComponent("\(messageId).jpg")
        try? FileManager.default.removeItem(at: url)
    }

    /// Bulk-delete every cached thumbnail for the given message ids.
    /// Called when a chat is deleted.
    func delete(forMessageIds ids: [String]) {
        for id in ids { delete(for: id) }
    }

    /// Reset the cache. Not currently called — included for completeness
    /// (sign-out cleanup, future "free up storage" UX, etc.).
    func clear() {
        memory.removeAll()
        try? FileManager.default.removeItem(at: cacheDir)
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
    }
}

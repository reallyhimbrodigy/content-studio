import Foundation

/// On-disk cache for rendered videos. Trades a few hundred MB of disk
/// for Apple-Photos-grade playback smoothness — once a video is cached,
/// AVPlayer plays it from local storage with zero network involvement,
/// no buffering latency, no mid-playback stalls.
///
/// Lifecycle:
///   - Render-complete (EditorView SSE handler) eagerly downloads the
///     fresh video so the user's *next* tap is instant.
///   - Library / chat replay first checks `localUrl(forJobId:)` — if hit,
///     the player gets a `file://` URL and plays from disk. On miss, the
///     player streams while we trigger a background download in parallel,
///     so subsequent taps land in the cache.
///   - Eviction runs on launch: anything older than 30 days is deleted,
///     then the oldest files are pruned until total bytes fit under 1 GB.
@MainActor
final class VideoCache {
    static let shared = VideoCache()

    /// Hard ceiling. ~125 typical 8Mbps × 60s clips. Eviction kicks in
    /// before this is reached so the device doesn't surprise-fill.
    private let maxBytes: Int64 = 1_073_741_824  // 1 GB

    /// Files older than this haven't been touched recently — evict.
    private let maxAgeDays: Double = 30

    private let cacheDir: URL
    private let queue = DispatchQueue(label: "promptly.videoCache.io")

    /// Active download tasks keyed by jobId, so concurrent
    /// `downloadIfNeeded(jobId:)` calls coalesce into one network request.
    private var inflight: [String: Task<URL?, Never>] = [:]

    private init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        cacheDir = caches.appendingPathComponent("promptly-videos", isDirectory: true)
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        Task { [weak self] in
            await self?.evictIfNeeded()
        }
    }

    // MARK: - Public API

    /// Synchronously check whether a job's video is already on disk.
    /// Touches the modification date so LRU eviction sees this as a
    /// recently-used entry.
    func localUrl(forJobId jobId: String) -> URL? {
        let url = fileUrl(forJobId: jobId)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return url
    }

    /// Download the video to disk if not already cached. Idempotent —
    /// repeated calls return the same in-flight task. Returns the local
    /// file URL on success, or nil if the download failed (caller falls
    /// back to streaming).
    @discardableResult
    func downloadIfNeeded(jobId: String, from remoteUrlString: String) async -> URL? {
        if let cached = localUrl(forJobId: jobId) { return cached }
        if let existing = inflight[jobId] { return await existing.value }

        guard let remoteUrl = URL(string: remoteUrlString) else { return nil }
        let dest = fileUrl(forJobId: jobId)
        let staging = cacheDir.appendingPathComponent("\(jobId).downloading")

        // Detached so file I/O doesn't run on MainActor — these moves can
        // touch hundreds of MB and would briefly stall the UI otherwise.
        let task = Task.detached(priority: .utility) { () -> URL? in
            do {
                let (tmpFile, response) = try await URLSession.shared.download(from: remoteUrl)
                guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                    print("[VideoCache] HTTP \((response as? HTTPURLResponse)?.statusCode ?? -1) for \(jobId)")
                    try? FileManager.default.removeItem(at: tmpFile)
                    return nil
                }
                // Atomic move via staging path. Avoids partially-written
                // files at the canonical path if the process dies mid-move.
                try? FileManager.default.removeItem(at: staging)
                try FileManager.default.moveItem(at: tmpFile, to: staging)
                try? FileManager.default.removeItem(at: dest)
                try FileManager.default.moveItem(at: staging, to: dest)
                print("[VideoCache] cached \(jobId)")
                return dest
            } catch {
                print("[VideoCache] download failed for \(jobId): \(error.localizedDescription)")
                return nil
            }
        }

        let trackingTask = Task<URL?, Never> { await task.value }
        inflight[jobId] = trackingTask
        let result = await trackingTask.value
        inflight[jobId] = nil
        return result
    }

    /// Delete a single cached file. Called on chat-deletion + sign-out
    /// so user-deleted content actually leaves the device.
    func remove(jobId: String) {
        try? FileManager.default.removeItem(at: fileUrl(forJobId: jobId))
    }

    /// Wipe the entire cache. Called on sign-out so the next user on the
    /// device doesn't see the previous user's content.
    func purgeAll() {
        try? FileManager.default.removeItem(at: cacheDir)
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
    }

    // MARK: - Internals

    private func fileUrl(forJobId jobId: String) -> URL {
        cacheDir.appendingPathComponent("\(jobId).mp4")
    }

    /// Run eviction: drop anything older than maxAgeDays, then prune
    /// oldest files until total size is under maxBytes. Idempotent — safe
    /// to run on every launch.
    private func evictIfNeeded() async {
        let cutoff = Date().addingTimeInterval(-maxAgeDays * 86400)

        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: cacheDir,
            includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        struct Entry { let url: URL; let date: Date; let size: Int64 }
        var entries: [Entry] = []
        for url in urls {
            // Skip leftover .downloading files older than 1 hour — those
            // are aborted writes, not real cache entries.
            if url.pathExtension == "downloading" {
                if let mod = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate,
                   Date().timeIntervalSince(mod) > 3600 {
                    try? FileManager.default.removeItem(at: url)
                }
                continue
            }
            guard let attrs = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey]),
                  let date = attrs.contentModificationDate,
                  let size = attrs.fileSize else { continue }
            entries.append(Entry(url: url, date: date, size: Int64(size)))
        }

        // Drop expired entries.
        var alive: [Entry] = []
        for entry in entries {
            if entry.date < cutoff {
                try? FileManager.default.removeItem(at: entry.url)
            } else {
                alive.append(entry)
            }
        }

        // Prune oldest until we're under the byte limit.
        alive.sort { $0.date < $1.date }
        var total = alive.reduce(Int64(0)) { $0 + $1.size }
        var idx = 0
        while total > maxBytes && idx < alive.count {
            try? FileManager.default.removeItem(at: alive[idx].url)
            total -= alive[idx].size
            idx += 1
        }
    }
}

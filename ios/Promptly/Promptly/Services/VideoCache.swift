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
/// True when a video URL points at a CDN-backed host (CloudFront
/// default `*.cloudfront.net`, a custom CloudFront alias domain, or
/// any other CDN we wire up later). Detection is by exclusion —
/// anything NOT served from S3 origin (`*.amazonaws.com`) is
/// assumed CDN-backed, which means AVPlayer can stream it directly
/// without rebuffering. Raw S3 throughput is bursty so origin URLs
/// keep the download-first playback path as a safety net.
func isStreamingReadyUrl(_ urlString: String) -> Bool {
    guard let host = URL(string: urlString)?.host?.lowercased() else { return false }
    if host.hasSuffix(".amazonaws.com") { return false }
    if host.hasSuffix("supabase.co") { return false } // legacy storage URLs
    return true
}

@MainActor
final class VideoCache: ObservableObject {
    static let shared = VideoCache()

    /// SwiftUI-observable set of cached job ids. Views bind their
    /// "is this thumbnail playable?" state to this so the UI flips
    /// from "downloading" → "ready to play" the instant the file
    /// lands on disk, without polling.
    @Published private(set) var cachedIds: Set<String> = []

    /// Hard ceiling. ~125 typical 8Mbps × 60s clips. Eviction kicks in
    /// before this is reached so the device doesn't surprise-fill.
    private let maxBytes: Int64 = 1_073_741_824  // 1 GB

    /// Files older than this haven't been touched recently — evict.
    private let maxAgeDays: Double = 30

    private let cacheDir: URL

    /// Active download tasks keyed by jobId, so concurrent
    /// `downloadIfNeeded(jobId:)` calls coalesce into one network request.
    private var inflight: [String: Task<URL?, Never>] = [:]

    /// Chained tail of the prefetch download queue. Each new prefetch
    /// `await`s the previous one before starting its network call, so at
    /// most ONE prefetch download runs at a time. Without this, 6+
    /// parallel prefetches saturated `URLSession.shared`'s connection
    /// pool and starved user uploads (build 96 regression).
    private var prefetchTail: Task<Void, Never>?

    /// Ref-counted gate. Each user-initiated upload increments on start
    /// and decrements on finish. Prefetch downloads await `userUploadActive`
    /// before starting, so background work never competes with the bytes
    /// the user is actively trying to send. The user-tier path (cache
    /// miss on tap) bypasses this. Ref-counted so an early activate at
    /// pick-time + the per-upload activate inside APIService both work,
    /// and concurrent multi-video uploads each maintain their own slot.
    private var uploadActiveCount = 0
    private var userUploadActive: Bool { uploadActiveCount > 0 }
    private var uploadGateWaiters: [CheckedContinuation<Void, Never>] = []

    /// Caller-facing priority hint. `.userInitiated` skips the upload
    /// gate AND the prefetch queue — used when the user has tapped a
    /// thumbnail and is staring at a loading spinner. `.prefetch`
    /// queues serially behind any in-flight prefetches and waits out
    /// the upload gate.
    enum Priority { case userInitiated, prefetch }

    private init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        cacheDir = caches.appendingPathComponent("promptly-videos", isDirectory: true)
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        // Seed cachedIds from disk so views know which videos are
        // already playable on first render (e.g., relaunch).
        if let urls = try? FileManager.default.contentsOfDirectory(at: cacheDir, includingPropertiesForKeys: nil) {
            for url in urls where url.pathExtension == "mp4" {
                let jobId = url.deletingPathExtension().lastPathComponent
                cachedIds.insert(jobId)
            }
        }
        Task { [weak self] in
            await self?.evictIfNeeded()
        }
    }

    /// Called at the start (`true`) and end (`false`) of any user-initiated
    /// upload. While the count is non-zero, prefetch downloads pause — the
    /// user's outbound bytes own the connection. Safe to call multiple
    /// times: ref-counted so concurrent uploads + early-activation patterns
    /// don't release the gate until everyone is done.
    func setUserUploadActive(_ active: Bool) {
        if active {
            uploadActiveCount += 1
            return
        }
        uploadActiveCount = max(0, uploadActiveCount - 1)
        if uploadActiveCount == 0 {
            let waiters = uploadGateWaiters
            uploadGateWaiters.removeAll()
            for cont in waiters { cont.resume() }
        }
    }

    private func waitForUploadGate() async {
        while userUploadActive {
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                uploadGateWaiters.append(cont)
            }
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
    func downloadIfNeeded(
        jobId: String,
        from remoteUrlString: String,
        priority: Priority = .prefetch
    ) async -> URL? {
        if let cached = localUrl(forJobId: jobId) { return cached }
        if let existing = inflight[jobId] { return await existing.value }

        guard let remoteUrl = URL(string: remoteUrlString) else { return nil }

        // Prefetch path: wait for any prior prefetch to finish (single-
        // file serialization) AND for any active user upload (don't
        // compete for outbound bandwidth). User-initiated path skips
        // both — the user is waiting on a spinner, get them their bytes.
        let isPrefetch = priority == .prefetch
        let predecessor = isPrefetch ? prefetchTail : nil
        let downloadTask = Task<URL?, Never> { [weak self] in
            if isPrefetch {
                await predecessor?.value
                await self?.waitForUploadGate()
            }
            return await self?.performDownload(jobId: jobId, remoteUrl: remoteUrl)
        }

        if isPrefetch {
            // The tail is a dependency-chain anchor — voids the URL
            // result so subsequent waits don't unnecessarily hold a
            // strong reference to the download return.
            prefetchTail = Task { _ = await downloadTask.value }
        }

        inflight[jobId] = downloadTask
        let result = await downloadTask.value
        inflight[jobId] = nil
        // Publish the cache-state change so observing views (chat
        // thumbnails, library rows) flip from loading → playable
        // without any polling or manual refresh.
        if result != nil {
            cachedIds.insert(jobId)
        }
        return result
    }

    private func performDownload(jobId: String, remoteUrl: URL) async -> URL? {
        let dest = fileUrl(forJobId: jobId)
        let staging = cacheDir.appendingPathComponent("\(jobId).downloading")

        // Detached so file I/O doesn't run on MainActor — these moves can
        // touch hundreds of MB and would briefly stall the UI otherwise.
        let work = Task.detached(priority: .utility) { () -> URL? in
            do {
                let (tmpFile, response) = try await URLSession.shared.download(from: remoteUrl)
                guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                    print("[VideoCache] HTTP \((response as? HTTPURLResponse)?.statusCode ?? -1) for \(jobId)")
                    try? FileManager.default.removeItem(at: tmpFile)
                    return nil
                }
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
        return await work.value
    }

    /// Delete a single cached file. Called on chat-deletion + sign-out
    /// so user-deleted content actually leaves the device.
    func remove(jobId: String) {
        try? FileManager.default.removeItem(at: fileUrl(forJobId: jobId))
        cachedIds.remove(jobId)
    }

    /// Wipe the entire cache. Called on sign-out so the next user on the
    /// device doesn't see the previous user's content.
    func purgeAll() {
        try? FileManager.default.removeItem(at: cacheDir)
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        cachedIds.removeAll()
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
                cachedIds.remove(entry.url.deletingPathExtension().lastPathComponent)
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
            cachedIds.remove(alive[idx].url.deletingPathExtension().lastPathComponent)
            total -= alive[idx].size
            idx += 1
        }
    }
}

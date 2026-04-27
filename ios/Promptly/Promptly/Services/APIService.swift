import Foundation
import Photos

class APIService {
    static let shared = APIService()
    private let baseUrl = "https://usepromptly.app"

    private init() {}

    /// Single long-lived URLSession shared across ALL S3 uploads — single
    /// PUT and every multipart part. One warm connection pool, no per-request
    /// TLS handshake, no per-request TCP slow-start. HTTP/2 multiplexing +
    /// connection reuse here beats spraying ephemeral sessions across parts
    /// (which was build 62's regression — each fresh session paid its own
    /// handshake + slow-start tax, tanking aggregate throughput).
    lazy var s3UploadSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 600
        config.waitsForConnectivity = true
        config.allowsCellularAccess = true
        config.allowsExpensiveNetworkAccess = true
        config.httpMaximumConnectionsPerHost = 6  // iOS default; lets parallel parts open new TCPs when beneficial
        return URLSession(configuration: config)
    }()

    /// Dedicated session for our own API server (everything not S3).
    /// `waitsForConnectivity = true` means a request fired during a
    /// momentary blip queues until the network is back instead of
    /// failing fast — which is what URLSession.shared would do.
    /// Combined with `requestData()` retry-on-transient, server calls
    /// survive connection drops, brief Wi-Fi-to-cellular handoffs,
    /// and stale HTTP/2 connections that the server has already closed.
    lazy var apiSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 120
        config.waitsForConnectivity = true
        config.allowsCellularAccess = true
        config.allowsExpensiveNetworkAccess = true
        return URLSession(configuration: config)
    }()

    /// Send a request with retry on transient network errors. Retries
    /// up to twice with backoff (1s, 3s) on:
    ///   -1001 NSURLErrorTimedOut         — request didn't complete in time
    ///   -1005 NSURLErrorNetworkConnectionLost — established TCP dropped
    ///   -1009 NSURLErrorNotConnectedToInternet — momentary offline
    /// All three are recoverable: -1005 most often happens because the
    /// server closed an idle HTTP/2 connection that URLSession was about
    /// to reuse — the next attempt opens a fresh connection and works.
    /// Non-transient errors (4xx response, malformed URL) throw immediately.
    func requestData(_ request: URLRequest, retries: Int = 2) async throws -> (Data, URLResponse) {
        let transientCodes: Set<Int> = [
            NSURLErrorTimedOut,
            NSURLErrorNetworkConnectionLost,
            NSURLErrorNotConnectedToInternet,
        ]
        var attempt = 0
        while true {
            do {
                return try await apiSession.data(for: request)
            } catch let error as URLError where transientCodes.contains(error.code.rawValue) {
                attempt += 1
                if attempt > retries {
                    print("[apiSession] giving up after \(attempt) attempts: \(error.code.rawValue)")
                    throw error
                }
                let delaySec: UInt64 = attempt == 1 ? 1 : 3
                print("[apiSession] transient error \(error.code.rawValue), retrying in \(delaySec)s (attempt \(attempt + 1))")
                try? await Task.sleep(nanoseconds: delaySec * 1_000_000_000)
            }
        }
    }

    /// Get a valid token, auto-refreshing if expired
    private func validToken() async -> String? {
        await AuthService.shared.getValidToken()
    }

    private func authorizedRequest(_ path: String, method: String = "GET") async -> URLRequest {
        var request = URLRequest(url: URL(string: "\(baseUrl)\(path)")!)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = await validToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    // MARK: - Video Jobs

    func createVideoJob(videoUrl: String, vibe: String) async throws -> String {
        var request = await authorizedRequest("/api/video-jobs", method: "POST")
        request.httpBody = try JSONEncoder().encode([
            "video_url": videoUrl,
            "vibe_input": vibe
        ])

        let (data, response) = try await requestData(request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let body = try? JSONDecoder().decode(JobCreateResponse.self, from: data)
            throw APIError.jobCreationFailed(body?.error ?? "Unknown error")
        }

        let result = try JSONDecoder().decode(JobCreateResponse.self, from: data)
        guard let jobId = result.resolvedJobId else {
            throw APIError.jobCreationFailed("No job ID returned")
        }
        return jobId
    }

    /// Fire-and-forget: tell the backend a video has been uploaded and ready
    /// for pre-processing. The server forwards to Modal's /prewarm endpoint
    /// which downloads the source into its persistent cache volume — so when
    /// the real render job fires later, the "Loading your footage" step is
    /// a no-op cache hit. Non-blocking: errors are logged and swallowed.
    ///
    /// Retries once after 2s on transient network failure. Cellular upload
    /// paths drop requests silently more often than people realize, and
    /// losing the prewarm silently means the user gets the slow path with
    /// no trace. Server-side idempotency via the in-flight registry handles
    /// duplicate firing if both succeed.
    func prewarmRender(videoUrl: String) async {
        var lastError: Error?
        for attempt in 0..<2 {
            do {
                var request = await authorizedRequest("/api/prewarm", method: "POST")
                request.httpBody = try JSONEncoder().encode(["video_url": videoUrl])
                request.timeoutInterval = 5
                let (_, response) = try await requestData(request)
                if let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) {
                    print("[prewarm] dispatched (attempt \(attempt + 1))")
                    return
                }
                // Non-2xx — treat as failure, retry once
                lastError = NSError(domain: "prewarm", code: (response as? HTTPURLResponse)?.statusCode ?? -1)
            } catch {
                lastError = error
            }
            if attempt == 0 {
                try? await Task.sleep(nanoseconds: 2_000_000_000)  // 2s backoff
            }
        }
        print("[prewarm] dispatch failed after retry (non-fatal): \(lastError?.localizedDescription ?? "unknown")")
    }

    /// Kick off a re-edit derived from an existing completed job. Server loads
    /// the original job's saved edit_recipe + transcript + analysis + resolved
    /// B-roll and routes through Modal in either tweak or reinterpret mode.
    /// Returns the new job id; progress is watched via SSE just like a fresh edit.
    func reeditFromJob(originalJobId: String, changeRequest: String) async throws -> String {
        var request = await authorizedRequest("/api/video-jobs/re-edit", method: "POST")
        request.httpBody = try JSONEncoder().encode([
            "original_job_id": originalJobId,
            "change_request": changeRequest,
        ])

        let (data, response) = try await requestData(request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let body = try? JSONDecoder().decode(JobCreateResponse.self, from: data)
            throw APIError.jobCreationFailed(body?.error ?? "Re-edit failed")
        }

        let result = try JSONDecoder().decode(JobCreateResponse.self, from: data)
        guard let jobId = result.resolvedJobId else {
            throw APIError.jobCreationFailed("No job ID returned")
        }
        return jobId
    }

    /// Ask the server for fresh signed URLs for a job. Used when the
    /// client detects a 403/expired video or thumbnail URL — the server
    /// has the underlying S3 keys and can re-sign for another 7 days.
    /// Returns nil on auth/permission/network failure; the caller is
    /// expected to leave the existing (broken) URL in place and just
    /// show the placeholder.
    struct RefreshUrlsResponse: Codable {
        let videoUrl: String?
        let thumbnailUrl: String?
    }

    func refreshUrls(jobId: String) async -> RefreshUrlsResponse? {
        do {
            let request = await authorizedRequest("/api/video-jobs/\(jobId)/refresh-urls", method: "POST")
            let (data, resp) = try await requestData(request)
            guard let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                print("[refresh] failed status=\((resp as? HTTPURLResponse)?.statusCode ?? -1)")
                return nil
            }
            return try JSONDecoder().decode(RefreshUrlsResponse.self, from: data)
        } catch {
            print("[refresh] error: \(error.localizedDescription)")
            return nil
        }
    }

    func getUserEdits() async throws -> [VideoJob] {
        guard let userId = AuthService.shared.currentUser?.id,
              let token = await validToken() else { throw APIError.notAuthenticated }

        let supabaseUrl = "https://ejxkzsfruykvgeouymfy.supabase.co"
        let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqeGt6c2ZydXlrdmdlb3V5bWZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjE5ODgsImV4cCI6MjA3ODg5Nzk4OH0.KSH6xO3bPv9aK36zGZKCtnNCa1z7xI_H-VKx5ZRaTOE"

        let urlStr = "\(supabaseUrl)/rest/v1/video_jobs?user_id=eq.\(userId)&status=in.(completed,processing,queued,failed)&order=created_at.desc&select=id,status,vibe_input,rendered_video_url,thumbnail_url,created_at,error_message"
        var request = URLRequest(url: URL(string: urlStr)!)
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, _) = try await requestData(request)
        return try JSONDecoder().decode([VideoJob].self, from: data)
    }

    func deleteEdit(id: String) async throws {
        guard let userId = AuthService.shared.currentUser?.id,
              let token = await validToken() else { throw APIError.notAuthenticated }

        let supabaseUrl = "https://ejxkzsfruykvgeouymfy.supabase.co"
        let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqeGt6c2ZydXlrdmdlb3V5bWZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjE5ODgsImV4cCI6MjA3ODg5Nzk4OH0.KSH6xO3bPv9aK36zGZKCtnNCa1z7xI_H-VKx5ZRaTOE"

        let urlStr = "\(supabaseUrl)/rest/v1/video_jobs?id=eq.\(id)&user_id=eq.\(userId)"
        var request = URLRequest(url: URL(string: urlStr)!)
        request.httpMethod = "DELETE"
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (_, response) = try await requestData(request)
        guard let http = response as? HTTPURLResponse, http.statusCode < 300 else {
            throw APIError.deleteFailed
        }
    }

    // MARK: - Upload

    func getUploadUrl(fileName: String) async throws -> UploadUrlResponse {
        var request = await authorizedRequest("/api/upload-url", method: "POST")
        request.httpBody = try JSONEncoder().encode(["fileName": fileName])

        let (data, _) = try await requestData(request)
        return try JSONDecoder().decode(UploadUrlResponse.self, from: data)
    }

    func uploadToS3(url: String, data videoData: Data, mimeType: String) async throws {
        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = "PUT"
        request.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        request.httpBody = videoData

        let (_, response) = try await requestData(request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw APIError.uploadFailed
        }
    }

    /// Upload directly from a file URL with progress tracking and retry.
    ///
    /// `messageId` / `chatId` / `publicUrl` are accepted for source-call
    /// compatibility but currently unused — the background URLSession
    /// path that consumed them was reverted in build 94 after immediate
    /// upload-failures shipped in build 90–93. Re-introduce only after
    /// a real-device test confirms `nsurlsessiond` accepts our file URLs.
    func uploadFileToS3(
        url: String,
        fileUrl: URL,
        mimeType: String,
        messageId: String? = nil,
        chatId: String? = nil,
        publicUrl: String? = nil,
        onProgress: ((Double) -> Void)? = nil
    ) async throws {
        let size = (try? FileManager.default.attributesOfItem(atPath: fileUrl.path)[.size] as? Int64) ?? 0
        let host = URL(string: url)?.host ?? "unknown"
        print("[perf] upload path=single fileSize=\(size) endpoint=\(host)")

        // Tell VideoCache to pause prefetches — they'd otherwise saturate
        // the connection pool and starve this user-initiated upload.
        await MainActor.run { VideoCache.shared.setUserUploadActive(true) }
        defer {
            Task { @MainActor in VideoCache.shared.setUserUploadActive(false) }
        }

        let uploadStart = Date()

        guard let remoteUrl = URL(string: url) else { throw APIError.uploadFailed }
        var request = URLRequest(url: remoteUrl)
        request.httpMethod = "PUT"
        request.setValue(mimeType, forHTTPHeaderField: "Content-Type")

        // Shared session — reuses warm TCP + HTTP/2 multiplexing. No per-call
        // handshake tax. `fromFile:` streams directly off disk without
        // loading the whole file into RAM.
        let delegate = UploadProgressDelegate(onProgress: onProgress)

        // Retry up to 2 times on failure
        var lastError: Error?
        for attempt in 1...2 {
            do {
                let (_, response) = try await s3UploadSession.upload(for: request, fromFile: fileUrl, delegate: delegate)
                guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                    throw APIError.uploadFailed
                }
                let elapsed = Date().timeIntervalSince(uploadStart)
                let mbps = (Double(size) / 1_048_576.0) / max(elapsed, 0.001) * 8
                print(String(format: "[perf] upload single success elapsed=%.2fs throughput=%.1fMbps", elapsed, mbps))
                return // Success
            } catch {
                lastError = error
                if attempt < 2 {
                    try? await Task.sleep(for: .seconds(2))
                    onProgress?(0) // Reset progress for retry
                }
            }
        }
        throw lastError ?? APIError.uploadFailed
    }

    // MARK: - Multipart Upload (parallel chunks, lossless)
    //
    // Splits the file into 8MB chunks and uploads them in parallel against
    // presigned URLs served by the server. 2-3× throughput of single-stream
    // PUT on any multi-path network. Bytes are byte-identical — multipart
    // is a TRANSPORT optimization, pixels are not touched.
    //
    // Flow:
    //   1. POST /api/upload-multipart-init { fileName, partCount } →
    //      { uploadId, partUrls[], key, publicUrl }
    //   2. Upload each part to its presigned URL in parallel (max 4 at once)
    //   3. POST /api/upload-multipart-complete { key, uploadId, parts[] } →
    //      { publicUrl }
    // On any unrecoverable error, POST /api/upload-multipart-abort so the
    // S3-side in-progress parts don't sit around billing.

    private static let multipartChunkSize: Int64 = 16 * 1024 * 1024   // 16MB chunks — bigger chunks amortize per-part overhead
    private static let multipartConcurrency = 6                        // matches httpMaximumConnectionsPerHost — saturates the connection pool
    // Lower threshold (30MB) so typical 1080p iPhone clips (40-90MB) get
    // the parallel-upload speedup. Multipart adds ~700ms of init+complete
    // roundtrips, which is paid back as soon as parallel-stream throughput
    // beats single-stream. On a 20Mbps wifi a 60MB video goes from 24s
    // (single PUT) to ~7s (6-way multipart). Threshold below 30MB isn't
    // worth the roundtrip overhead.
    private static let multipartThreshold: Int64 = 30 * 1024 * 1024

    struct MultipartInitResponse: Codable {
        let uploadId: String
        let partUrls: [String]
        let key: String
        let publicUrl: String
    }

    struct MultipartCompleteResponse: Codable {
        let publicUrl: String
        let key: String
    }

    struct MultipartPart: Codable {
        let PartNumber: Int
        let ETag: String
    }

    /// Upload a file using S3 multipart + Transfer Acceleration. Returns the
    /// public URL on success. Falls back internally to nothing — caller is
    /// responsible for falling back to `uploadFileToS3` on thrown errors.
    ///
    /// `onPublicUrlKnown` fires as soon as multipart-init returns (well
    /// before the actual byte transfer finishes) so the caller can kick
    /// off downstream work like prewarm in parallel with the upload.
    func uploadFileToS3Multipart(
        fileName: String,
        fileUrl: URL,
        onPublicUrlKnown: ((String) -> Void)? = nil,
        onProgress: ((Double) -> Void)? = nil
    ) async throws -> String {
        let attrs = try FileManager.default.attributesOfItem(atPath: fileUrl.path)
        let fileSize = (attrs[.size] as? Int64) ?? 0
        guard fileSize > 0 else { throw APIError.uploadFailed }

        // Pause prefetches for the duration — multipart uploads run 4
        // parallel parts already, and prefetch contention here is even
        // more painful than for single PUT.
        await MainActor.run { VideoCache.shared.setUserUploadActive(true) }
        defer {
            Task { @MainActor in VideoCache.shared.setUserUploadActive(false) }
        }

        let chunkSize = Self.multipartChunkSize
        let partCount = Int((fileSize + chunkSize - 1) / chunkSize)
        let uploadStart = Date()
        print("[perf] upload path=multipart fileSize=\(fileSize) parts=\(partCount) chunkSize=\(chunkSize)")

        // 1. Init: get presigned part URLs
        let initStart = Date()
        var initRequest = await authorizedRequest("/api/upload-multipart-init", method: "POST")
        initRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        initRequest.httpBody = try JSONSerialization.data(withJSONObject: [
            "fileName": fileName,
            "partCount": partCount,
        ])
        let (initData, initResp) = try await requestData(initRequest)
        guard let initHttp = initResp as? HTTPURLResponse, (200...299).contains(initHttp.statusCode) else {
            throw APIError.uploadFailed
        }
        let initResponse = try JSONDecoder().decode(MultipartInitResponse.self, from: initData)
        guard initResponse.partUrls.count == partCount else {
            throw APIError.uploadFailed
        }
        print(String(format: "[perf] multipart init %.2fs", Date().timeIntervalSince(initStart)))
        // Eagerly share the public URL with the caller so prewarm can fire
        // in parallel with the actual byte transfer. The S3 object doesn't
        // exist until multipart-complete lands, but the prewarm handler on
        // Modal polls for it.
        onPublicUrlKnown?(initResponse.publicUrl)
        if let host = URL(string: initResponse.partUrls.first ?? "")?.host {
            print("[perf] endpoint=\(host)")
        }

        let uploadedBytes = MultipartProgressTracker()
        let totalBytes = fileSize
        let netStart = Date()

        do {
            let parts: [MultipartPart] = try await withThrowingTaskGroup(of: MultipartPart.self) { group in
                var next = 0
                var collected: [MultipartPart] = []
                collected.reserveCapacity(partCount)

                func scheduleNext() {
                    guard next < partCount else { return }
                    let partIndex = next
                    next += 1
                    let start = Int64(partIndex) * chunkSize
                    let end = min(start + chunkSize, fileSize)
                    let partSize = end - start
                    let partUrlStr = initResponse.partUrls[partIndex]
                    group.addTask {
                        // All parts share the process-wide s3UploadSession.
                        // HTTP/2 multiplexes concurrent part PUTs over a warm
                        // connection pool — handshake cost amortized once,
                        // slow-start paid once, and iOS's connection manager
                        // opens additional TCPs when it detects bandwidth
                        // benefits. Build 62's per-part ephemeral sessions
                        // forced 8 cold handshakes + 8 slow-starts, which
                        // tanked throughput.
                        return try await Self.uploadOnePart(
                            fileUrl: fileUrl,
                            offset: start,
                            length: partSize,
                            partNumber: partIndex + 1,
                            url: partUrlStr,
                            session: APIService.shared.s3UploadSession,
                            tracker: uploadedBytes,
                            totalBytes: totalBytes,
                            onProgress: onProgress
                        )
                    }
                }

                // Seed with concurrency slots
                for _ in 0..<min(Self.multipartConcurrency, partCount) {
                    scheduleNext()
                }
                // Drain + schedule replacements
                for try await part in group {
                    collected.append(part)
                    scheduleNext()
                }
                return collected
            }

            let netElapsed = Date().timeIntervalSince(netStart)
            let netMbps = (Double(fileSize) / 1_048_576.0) / max(netElapsed, 0.001) * 8
            print(String(format: "[perf] multipart parts-only elapsed=%.2fs throughput=%.1fMbps", netElapsed, netMbps))

            // 3. Complete
            let completeStart = Date()
            var completeRequest = await authorizedRequest("/api/upload-multipart-complete", method: "POST")
            completeRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            completeRequest.httpBody = try JSONSerialization.data(withJSONObject: [
                "key": initResponse.key,
                "uploadId": initResponse.uploadId,
                "parts": parts.map { ["PartNumber": $0.PartNumber, "ETag": $0.ETag] },
            ])
            let (completeData, completeResp) = try await requestData(completeRequest)
            guard let http = completeResp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                throw APIError.uploadFailed
            }
            let completeResponse = try JSONDecoder().decode(MultipartCompleteResponse.self, from: completeData)
            print(String(format: "[perf] multipart complete %.2fs", Date().timeIntervalSince(completeStart)))
            let elapsed = Date().timeIntervalSince(uploadStart)
            let mbps = (Double(fileSize) / 1_048_576.0) / max(elapsed, 0.001) * 8
            print(String(format: "[perf] upload multipart TOTAL elapsed=%.2fs throughput=%.1fMbps", elapsed, mbps))
            return completeResponse.publicUrl
        } catch {
            // Abort the in-progress multipart so parts don't orphan-bill.
            Task.detached(priority: .utility) { [initResponse] in
                var abortRequest = await APIService.shared.authorizedRequest("/api/upload-multipart-abort", method: "POST")
                abortRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
                abortRequest.httpBody = try? JSONSerialization.data(withJSONObject: [
                    "key": initResponse.key,
                    "uploadId": initResponse.uploadId,
                ])
                _ = try? await URLSession.shared.data(for: abortRequest)
            }
            throw error
        }
    }

    private static func uploadOnePart(
        fileUrl: URL,
        offset: Int64,
        length: Int64,
        partNumber: Int,
        url: String,
        session: URLSession,
        tracker: MultipartProgressTracker,
        totalBytes: Int64,
        onProgress: ((Double) -> Void)?
    ) async throws -> MultipartPart {
        // Read just this chunk off disk into Data. For 16MB chunks this is
        // 16MB of RAM transient per in-flight part (64MB total at 4 parallel)
        // — trivial on modern iPhones. The previous temp-file-per-chunk
        // approach cost 60MB+ of extra sequential disk write per upload for
        // no measurable network-throughput gain.
        let handle = try FileHandle(forReadingFrom: fileUrl)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        guard let data = try handle.read(upToCount: Int(length)), data.count == Int(length) else {
            throw APIError.uploadFailed
        }
        return try await uploadOnePartData(
            data: data,
            partNumber: partNumber,
            url: url,
            session: session,
            tracker: tracker,
            totalBytes: totalBytes,
            onProgress: onProgress
        )
    }

    /// Upload a single pre-prepared chunk of Data to its presigned URL.
    /// Shared between the file-based multipart path (reads a byte range off
    /// disk) and the iCloud-streaming path (chunks arrive directly from
    /// PHAssetResourceManager). Signed URLs don't take a Content-Type, so
    /// the request omits it.
    static func uploadOnePartData(
        data: Data,
        partNumber: Int,
        url: String,
        session: URLSession,
        tracker: MultipartProgressTracker,
        totalBytes: Int64,
        onProgress: ((Double) -> Void)?
    ) async throws -> MultipartPart {
        guard let u = URL(string: url) else { throw APIError.uploadFailed }
        let partStart = Date()
        let length = Int64(data.count)

        var request = URLRequest(url: u)
        request.httpMethod = "PUT"
        // No Content-Type header — presigned URL was signed without it.

        var attemptsRemaining = 2
        var lastError: Error?
        while attemptsRemaining > 0 {
            do {
                let (_, resp) = try await session.upload(for: request, from: data)
                guard let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                    throw APIError.uploadFailed
                }
                guard let etag = http.value(forHTTPHeaderField: "ETag") ?? http.value(forHTTPHeaderField: "Etag") else {
                    throw APIError.uploadFailed
                }
                await tracker.add(length)
                let progress = min(1.0, Double(await tracker.total()) / Double(totalBytes))
                await MainActor.run { onProgress?(progress) }
                let partElapsed = Date().timeIntervalSince(partStart)
                let partMbps = (Double(length) / 1_048_576.0) / max(partElapsed, 0.001) * 8
                print(String(format: "[perf] part %d done elapsed=%.2fs throughput=%.1fMbps", partNumber, partElapsed, partMbps))
                return MultipartPart(PartNumber: partNumber, ETag: etag.replacingOccurrences(of: "\"", with: ""))
            } catch {
                lastError = error
                attemptsRemaining -= 1
                if attemptsRemaining > 0 {
                    try? await Task.sleep(for: .seconds(1))
                }
            }
        }
        throw lastError ?? APIError.uploadFailed
    }

    /// Decide whether a file should use multipart based on size. Caller uses
    /// single PUT for tiny files where multipart overhead isn't worth it.
    static func shouldUseMultipart(fileUrl: URL) -> Bool {
        guard let size = (try? FileManager.default.attributesOfItem(atPath: fileUrl.path)[.size] as? Int64) else {
            return false
        }
        return size >= multipartThreshold
    }

    // MARK: - iCloud Streaming Upload (pipeline iCloud download → S3 PUT)
    //
    // For iCloud-only assets the "download then upload" serial path burns
    // the download time entirely before any byte hits S3. Streaming lets
    // the two transfers overlap: as PhotoKit delivers each chunk from
    // iCloud, we fire a part-upload to S3. Total wall-clock time collapses
    // from (dl + ul) to ~max(dl, ul) + small tail, often cutting user-
    // visible latency in half.
    //
    // Implementation:
    //   1. Read the original-bytes file size off the PHAssetResource via
    //      KVC — needed upfront to compute part count and request the
    //      presigned part URLs.
    //   2. Init multipart on the server like the file-based path.
    //   3. PHAssetResourceManager.requestData streams the asset bytes. Its
    //      `dataReceivedHandler` is called on a serial queue with chunks
    //      as they arrive. Accumulate into a buffer; every time the
    //      buffer reaches 16MB, slice a part and fire a detached task
    //      that uploads it to its presigned URL.
    //   4. When iCloud delivery finishes, upload whatever remains as the
    //      final (possibly short) part. S3 allows the last part to be
    //      smaller than the 5MB minimum.
    //   5. Await all part tasks, then POST /api/upload-multipart-complete.

    /// Stream an iCloud video directly into an S3 multipart upload.
    /// Returns the public URL of the finalized object.
    ///
    /// `onPublicUrlKnown` fires as soon as multipart-init returns so the
    /// caller can kick off prewarm in parallel with the iCloud → S3 pipe.
    func streamUploadFromICloud(
        resource: PHAssetResource,
        fileSize: Int64,
        fileName: String,
        onPublicUrlKnown: ((String) -> Void)? = nil,
        onProgress: ((Double) -> Void)? = nil
    ) async throws -> String {
        await MainActor.run { VideoCache.shared.setUserUploadActive(true) }
        defer {
            Task { @MainActor in VideoCache.shared.setUserUploadActive(false) }
        }
        let t0 = Date()
        // 5MB parts — S3's non-final minimum. Smaller parts = first part
        // ships after just 5MB of iCloud bytes have arrived (vs 16MB),
        // starting the pipeline overlap 3× sooner. Tradeoff: more server
        // roundtrips on init, more part-complete overhead. Worth it for
        // the faster pipeline warmup on iCloud-sourced uploads.
        let partSize: Int64 = 5 * 1024 * 1024
        let partCount = Int((fileSize + partSize - 1) / partSize)
        print("[perf] stream upload fileSize=\(fileSize) parts=\(partCount) chunkSize=\(partSize)")

        // 1. Init: request presigned URLs for every part upfront. Fired
        //    as a background task so the first PhotoKit bytes don't wait
        //    on this HTTPS roundtrip.
        let initStart = Date()
        let initTask = Task { () -> MultipartInitResponse in
            var initRequest = await self.authorizedRequest("/api/upload-multipart-init", method: "POST")
            initRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            initRequest.httpBody = try JSONSerialization.data(withJSONObject: [
                "fileName": fileName,
                "partCount": partCount,
            ])
            let (initData, initResp) = try await requestData(initRequest)
            guard let initHttp = initResp as? HTTPURLResponse, (200...299).contains(initHttp.statusCode) else {
                throw APIError.uploadFailed
            }
            let r = try JSONDecoder().decode(MultipartInitResponse.self, from: initData)
            guard r.partUrls.count == partCount else { throw APIError.uploadFailed }
            print(String(format: "[perf] stream init %.2fs", Date().timeIntervalSince(initStart)))
            // Hand the public URL back immediately — caller can fire
            // prewarm now instead of after every part has landed.
            onPublicUrlKnown?(r.publicUrl)
            return r
        }

        let tracker = MultipartProgressTracker()
        let netStart = Date()

        do {
            // 2. Drive PhotoKit streaming. Keep incoming chunks as a list
            //    of Data refs (NOT a concatenated buffer with removeFirst,
            //    which is O(N) per chunk and blocks the serial PhotoKit
            //    delivery queue). When we have >= partSize bytes queued,
            //    slice out the next part's chunks and detach a Task that
            //    assembles + uploads them. The assembly happens OFF the
            //    PhotoKit queue so delivery never stalls.
            var partTasks: [Task<MultipartPart, Error>] = []
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                let options = PHAssetResourceRequestOptions()
                options.isNetworkAccessAllowed = true
                var queue: [Data] = []
                var queuedBytes: Int64 = 0
                var nextPartIndex = 0
                var resumed = false

                options.progressHandler = { progress in
                    if progress > 0 && progress < 1 {
                        print(String(format: "[perf] stream iCloud dl=%.0f%%", progress * 100))
                    }
                }

                /// Pull `size` bytes off the head of the chunk queue as a
                /// list of Data slices. Splits the head chunk if needed.
                /// Keeps O(1) work on the PhotoKit queue — no large
                /// memcpy, no buffer reallocation.
                func sliceFront(size: Int64) -> [Data] {
                    var remaining = size
                    var out: [Data] = []
                    while remaining > 0 && !queue.isEmpty {
                        let head = queue[0]
                        if Int64(head.count) <= remaining {
                            out.append(head)
                            remaining -= Int64(head.count)
                            queue.removeFirst()
                        } else {
                            let take = Int(remaining)
                            out.append(head.prefix(take))
                            queue[0] = head.suffix(head.count - take)
                            remaining = 0
                        }
                    }
                    queuedBytes -= size
                    return out
                }

                PHAssetResourceManager.default().requestData(
                    for: resource,
                    options: options,
                    dataReceivedHandler: { chunk in
                        queue.append(chunk)
                        queuedBytes += Int64(chunk.count)
                        // Ship every complete 5MB boundary. Leave the
                        // final part for completionHandler since S3
                        // allows the last part to be any size but non-
                        // final parts must be >= 5MB.
                        while queuedBytes >= partSize && nextPartIndex < partCount - 1 {
                            let partChunks = sliceFront(size: partSize)
                            let partNumber = nextPartIndex + 1
                            nextPartIndex += 1
                            let task = Task.detached(priority: .userInitiated) {
                                // Assemble the part Data HERE, off the
                                // PhotoKit delivery queue.
                                var partData = Data(capacity: Int(partSize))
                                for c in partChunks { partData.append(c) }
                                let partUrl = try await initTask.value.partUrls[partNumber - 1]
                                return try await APIService.uploadOnePartData(
                                    data: partData,
                                    partNumber: partNumber,
                                    url: partUrl,
                                    session: APIService.shared.s3UploadSession,
                                    tracker: tracker,
                                    totalBytes: fileSize,
                                    onProgress: onProgress
                                )
                            }
                            partTasks.append(task)
                        }
                    },
                    completionHandler: { error in
                        if let error = error {
                            if !resumed { resumed = true; cont.resume(throwing: error) }
                            return
                        }
                        // Flush anything left as the final part.
                        if queuedBytes > 0 && nextPartIndex < partCount {
                            let partChunks = sliceFront(size: queuedBytes)
                            let partNumber = nextPartIndex + 1
                            nextPartIndex += 1
                            let task = Task.detached(priority: .userInitiated) {
                                var partData = Data()
                                for c in partChunks { partData.append(c) }
                                let partUrl = try await initTask.value.partUrls[partNumber - 1]
                                return try await APIService.uploadOnePartData(
                                    data: partData,
                                    partNumber: partNumber,
                                    url: partUrl,
                                    session: APIService.shared.s3UploadSession,
                                    tracker: tracker,
                                    totalBytes: fileSize,
                                    onProgress: onProgress
                                )
                            }
                            partTasks.append(task)
                        }
                        if !resumed { resumed = true; cont.resume() }
                    }
                )
            }

            let initResponse = try await initTask.value

            // 3. Wait for every part upload to finish.
            var parts: [MultipartPart] = []
            for task in partTasks {
                parts.append(try await task.value)
            }
            let netElapsed = Date().timeIntervalSince(netStart)
            let netMbps = (Double(fileSize) / 1_048_576.0) / max(netElapsed, 0.001) * 8
            print(String(format: "[perf] stream parts-done elapsed=%.2fs throughput=%.1fMbps", netElapsed, netMbps))

            // 4. Complete the multipart upload.
            let completeStart = Date()
            var completeRequest = await authorizedRequest("/api/upload-multipart-complete", method: "POST")
            completeRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            completeRequest.httpBody = try JSONSerialization.data(withJSONObject: [
                "key": initResponse.key,
                "uploadId": initResponse.uploadId,
                "parts": parts
                    .sorted { $0.PartNumber < $1.PartNumber }
                    .map { ["PartNumber": $0.PartNumber, "ETag": $0.ETag] },
            ])
            let (completeData, completeResp) = try await requestData(completeRequest)
            guard let http = completeResp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                throw APIError.uploadFailed
            }
            let completeResponse = try JSONDecoder().decode(MultipartCompleteResponse.self, from: completeData)
            print(String(format: "[perf] stream complete %.2fs", Date().timeIntervalSince(completeStart)))
            let total = Date().timeIntervalSince(t0)
            let totalMbps = (Double(fileSize) / 1_048_576.0) / max(total, 0.001) * 8
            print(String(format: "[perf] stream TOTAL elapsed=%.2fs throughput=%.1fMbps", total, totalMbps))
            return completeResponse.publicUrl
        } catch {
            // Abort so S3 doesn't orphan-bill the in-progress parts. Need
            // to recover the init response — it may have succeeded even
            // if a part failed later.
            Task.detached(priority: .utility) {
                guard let init_ = try? await initTask.value else { return }
                var abortRequest = await APIService.shared.authorizedRequest("/api/upload-multipart-abort", method: "POST")
                abortRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
                abortRequest.httpBody = try? JSONSerialization.data(withJSONObject: [
                    "key": init_.key,
                    "uploadId": init_.uploadId,
                ])
                _ = try? await URLSession.shared.data(for: abortRequest)
            }
            throw error
        }
    }

    func uploadVideo(data: Data, fileName: String) async throws -> String {
        var request = await authorizedRequest("/api/upload", method: "POST")

        let boundary = UUID().uuidString
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"video\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: video/mp4\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"userId\"\r\n\r\n".data(using: .utf8)!)
        body.append((AuthService.shared.currentUser?.id ?? "").data(using: .utf8)!)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body

        let (responseData, _) = try await requestData(request)
        let result = try JSONDecoder().decode(UploadResponse.self, from: responseData)
        guard let videoUrl = result.videoUrl else {
            throw APIError.uploadFailed
        }
        return videoUrl
    }

    // MARK: - Fresh Video URL

    /// Get a fresh signed URL for a video that might have an expired S3 URL
    func getFreshVideoUrl(originalUrl: String) -> String {
        // S3 presigned URLs contain X-Amz-Expires — if the URL has query params, it's presigned
        // For now, return the original URL — the server generates 30-day URLs
        // If URLs start expiring, add a /api/refresh-url endpoint server-side
        return originalUrl
    }

    // MARK: - Chat

    func chat(message: String, history: [[String: String]]) async throws -> String {
        var request = await authorizedRequest("/api/chat", method: "POST")
        let payload: [String: Any] = ["message": message, "history": history]
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, _) = try await requestData(request)
        let result = try JSONDecoder().decode(ChatResponse.self, from: data)
        return result.reply ?? "No response"
    }
}

enum APIError: LocalizedError {
    case notAuthenticated
    case jobCreationFailed(String)
    case uploadFailed
    case deleteFailed

    var errorDescription: String? {
        switch self {
        case .notAuthenticated: return "Please sign in"
        case .jobCreationFailed(let msg): return msg
        case .uploadFailed: return "Upload failed"
        case .deleteFailed: return "Delete failed"
        }
    }
}

// Thread-safe counter for multipart upload progress aggregation across
// parallel part uploads. Swift actors give us race-free increment + read.
actor MultipartProgressTracker {
    private var bytesUploaded: Int64 = 0
    func add(_ delta: Int64) { bytesUploaded += delta }
    func total() -> Int64 { bytesUploaded }
}

class UploadProgressDelegate: NSObject, URLSessionTaskDelegate {
    let onProgress: ((Double) -> Void)?

    init(onProgress: ((Double) -> Void)?) {
        self.onProgress = onProgress
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        let progress = Double(totalBytesSent) / Double(totalBytesExpectedToSend)
        DispatchQueue.main.async { [self] in
            onProgress?(progress)
        }
    }
}

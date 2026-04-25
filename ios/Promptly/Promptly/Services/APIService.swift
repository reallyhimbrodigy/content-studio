import Foundation

class APIService {
    static let shared = APIService()
    private let baseUrl = "https://usepromptly.app"

    private init() {}

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

        let (data, response) = try await URLSession.shared.data(for: request)
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
                let (_, response) = try await URLSession.shared.data(for: request)
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

        let (data, response) = try await URLSession.shared.data(for: request)
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

    func getUserEdits() async throws -> [VideoJob] {
        guard let userId = AuthService.shared.currentUser?.id,
              let token = await validToken() else { throw APIError.notAuthenticated }

        let supabaseUrl = "https://ejxkzsfruykvgeouymfy.supabase.co"
        let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqeGt6c2ZydXlrdmdlb3V5bWZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjE5ODgsImV4cCI6MjA3ODg5Nzk4OH0.KSH6xO3bPv9aK36zGZKCtnNCa1z7xI_H-VKx5ZRaTOE"

        let urlStr = "\(supabaseUrl)/rest/v1/video_jobs?user_id=eq.\(userId)&status=in.(completed,processing,queued,failed)&order=created_at.desc&select=id,status,vibe_input,rendered_video_url,thumbnail_url,created_at,error_message"
        var request = URLRequest(url: URL(string: urlStr)!)
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, _) = try await URLSession.shared.data(for: request)
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

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode < 300 else {
            throw APIError.deleteFailed
        }
    }

    // MARK: - Upload

    func getUploadUrl(fileName: String) async throws -> UploadUrlResponse {
        var request = await authorizedRequest("/api/upload-url", method: "POST")
        request.httpBody = try JSONEncoder().encode(["fileName": fileName])

        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONDecoder().decode(UploadUrlResponse.self, from: data)
    }

    func uploadToS3(url: String, data videoData: Data, mimeType: String) async throws {
        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = "PUT"
        request.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        request.httpBody = videoData

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw APIError.uploadFailed
        }
    }

    /// Upload directly from a file URL with progress tracking and retry
    func uploadFileToS3(url: String, fileUrl: URL, mimeType: String, onProgress: ((Double) -> Void)? = nil) async throws {
        let size = (try? FileManager.default.attributesOfItem(atPath: fileUrl.path)[.size] as? Int64) ?? 0
        let host = URL(string: url)?.host ?? "unknown"
        print("[upload] path=single fileSize=\(size) endpoint=\(host)")
        // Configure session with generous timeouts for cellular
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 300
        config.waitsForConnectivity = true
        config.allowsCellularAccess = true
        config.allowsExpensiveNetworkAccess = true

        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = "PUT"
        request.setValue(mimeType, forHTTPHeaderField: "Content-Type")

        let delegate = UploadProgressDelegate(onProgress: onProgress)
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)

        // Retry up to 2 times on failure
        var lastError: Error?
        for attempt in 1...2 {
            do {
                let (_, response) = try await session.upload(for: request, fromFile: fileUrl, delegate: delegate)
                guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                    throw APIError.uploadFailed
                }
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

    private static let multipartChunkSize: Int64 = 8 * 1024 * 1024    // 8MB — S3 min for a non-final part is 5MB
    private static let multipartConcurrency = 4                        // parallel part uploads
    private static let multipartThreshold: Int64 = 16 * 1024 * 1024    // <16MB stays on single PUT path

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
    func uploadFileToS3Multipart(
        fileName: String,
        fileUrl: URL,
        onProgress: ((Double) -> Void)? = nil
    ) async throws -> String {
        let attrs = try FileManager.default.attributesOfItem(atPath: fileUrl.path)
        let fileSize = (attrs[.size] as? Int64) ?? 0
        guard fileSize > 0 else { throw APIError.uploadFailed }

        let chunkSize = Self.multipartChunkSize
        let partCount = Int((fileSize + chunkSize - 1) / chunkSize)
        let uploadStart = Date()
        print("[upload] path=multipart fileSize=\(fileSize) parts=\(partCount) chunkSize=\(chunkSize)")

        // 1. Init: get presigned part URLs
        var initRequest = await authorizedRequest("/api/upload-multipart-init", method: "POST")
        initRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        initRequest.httpBody = try JSONSerialization.data(withJSONObject: [
            "fileName": fileName,
            "partCount": partCount,
        ])
        let (initData, initResp) = try await URLSession.shared.data(for: initRequest)
        guard let initHttp = initResp as? HTTPURLResponse, (200...299).contains(initHttp.statusCode) else {
            throw APIError.uploadFailed
        }
        let initResponse = try JSONDecoder().decode(MultipartInitResponse.self, from: initData)
        guard initResponse.partUrls.count == partCount else {
            throw APIError.uploadFailed
        }
        if let host = URL(string: initResponse.partUrls.first ?? "")?.host {
            print("[upload] endpoint=\(host)")
        }

        let uploadedBytes = MultipartProgressTracker()
        let totalBytes = fileSize

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
                        // Each part gets its OWN URLSession. Without this, the
                        // parallel TaskGroup collapses onto a single HTTP/2
                        // multiplexed TCP connection to s3-accelerate — one
                        // socket, no parallel bandwidth. A dedicated session
                        // per part guarantees separate TCP connections and
                        // actual wire-level concurrency.
                        return try await Self.uploadOnePart(
                            fileUrl: fileUrl,
                            offset: start,
                            length: partSize,
                            partNumber: partIndex + 1,
                            url: partUrlStr,
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

            // 3. Complete
            var completeRequest = await authorizedRequest("/api/upload-multipart-complete", method: "POST")
            completeRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            completeRequest.httpBody = try JSONSerialization.data(withJSONObject: [
                "key": initResponse.key,
                "uploadId": initResponse.uploadId,
                "parts": parts.map { ["PartNumber": $0.PartNumber, "ETag": $0.ETag] },
            ])
            let (completeData, completeResp) = try await URLSession.shared.data(for: completeRequest)
            guard let http = completeResp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                throw APIError.uploadFailed
            }
            let completeResponse = try JSONDecoder().decode(MultipartCompleteResponse.self, from: completeData)
            let elapsed = Date().timeIntervalSince(uploadStart)
            let mbps = (Double(fileSize) / 1_048_576.0) / max(elapsed, 0.001) * 8
            print(String(format: "[upload] multipart success elapsed=%.1fs throughput=%.1fMbps", elapsed, mbps))
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
        tracker: MultipartProgressTracker,
        totalBytes: Int64,
        onProgress: ((Double) -> Void)?
    ) async throws -> MultipartPart {
        guard let u = URL(string: url) else { throw APIError.uploadFailed }

        // Slice this chunk to its own temp file on disk. Two reasons:
        //   1. `URLSession.upload(for:fromFile:)` streams from disk without
        //      loading the whole body into RAM — Apple's guidance for large
        //      uploads. `upload(for:from: Data)` copies the Data into an
        //      internal buffer and has measurably worse throughput.
        //   2. Lets us use fromFile even though each part is a disjoint
        //      byte range of the source — presigned URLs can't use Range.
        let chunkUrl = FileManager.default.temporaryDirectory
            .appendingPathComponent("part-\(partNumber)-\(UUID().uuidString).bin")
        do {
            let handle = try FileHandle(forReadingFrom: fileUrl)
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(offset))
            guard let data = try handle.read(upToCount: Int(length)), data.count == Int(length) else {
                throw APIError.uploadFailed
            }
            try data.write(to: chunkUrl)
        }
        defer { try? FileManager.default.removeItem(at: chunkUrl) }

        var request = URLRequest(url: u)
        request.httpMethod = "PUT"
        // No Content-Type header — presigned URL was signed without it.

        // Dedicated URLSession per part. Prevents HTTP/2 from multiplexing all
        // parallel part uploads onto a single TCP connection to the
        // s3-accelerate endpoint, which would defeat the whole point of
        // parallel multipart. Each session gets its own connection pool →
        // genuine parallel wire-level bandwidth.
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 600
        config.waitsForConnectivity = true
        config.allowsCellularAccess = true
        config.allowsExpensiveNetworkAccess = true
        config.httpMaximumConnectionsPerHost = 1
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }

        var attemptsRemaining = 2
        var lastError: Error?
        while attemptsRemaining > 0 {
            do {
                let (_, resp) = try await session.upload(for: request, fromFile: chunkUrl)
                guard let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                    throw APIError.uploadFailed
                }
                guard let etag = http.value(forHTTPHeaderField: "ETag") ?? http.value(forHTTPHeaderField: "Etag") else {
                    throw APIError.uploadFailed
                }
                await tracker.add(length)
                let progress = min(1.0, Double(await tracker.total()) / Double(totalBytes))
                await MainActor.run { onProgress?(progress) }
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

        let (responseData, _) = try await URLSession.shared.data(for: request)
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

        let (data, _) = try await URLSession.shared.data(for: request)
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

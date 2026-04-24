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

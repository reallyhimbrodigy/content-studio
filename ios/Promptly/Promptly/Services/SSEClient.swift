import Foundation

class SSEClient {
    private var task: URLSessionDataTask?
    private let url: URL
    private let jobId: String
    var onEvent: ((SSEEvent) -> Void)?
    var onError: ((String) -> Void)?
    private var lastEventTime = Date()
    private var timeoutTimer: Timer?

    /// Whether the caller has explicitly disconnected. We don't auto-
    /// reconnect after a deliberate disconnect (job complete, view dismissed).
    private var isClosed = false

    /// Exponential-backoff state for transparent reconnect.
    private var reconnectAttempts = 0
    private let maxReconnectAttempts = 6
    private var reconnectTask: Task<Void, Never>?

    /// Set to true once the server has sent a terminal event
    /// (completed/failed/needs_clarification). Suppresses reconnects.
    private var receivedFinalEvent = false

    init(jobId: String) {
        self.jobId = jobId
        self.url = URL(string: "https://usepromptly.app/api/video-jobs/\(jobId)/stream")!
    }

    func connect() {
        guard !isClosed else { return }
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300
        config.timeoutIntervalForResource = 600

        let delegate = SSEDelegate(
            onData: { [weak self] data in self?.handleData(data) },
            onComplete: { [weak self] error in self?.handleConnectionEnd(error: error) }
        )

        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)

        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let token = AuthService.shared.accessToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        task = session.dataTask(with: request)
        task?.resume()
        lastEventTime = Date()

        // Start a timeout checker — if no events for 45s, poll the job status
        startTimeoutChecker()
    }

    func disconnect() {
        isClosed = true
        timeoutTimer?.invalidate()
        timeoutTimer = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        task?.cancel()
        task = nil
    }

    private func handleData(_ data: Data) {
        lastEventTime = Date()
        // Any successful data resets the reconnect counter — we're back
        // in business, future drops should also be retried from scratch.
        reconnectAttempts = 0

        guard let text = String(data: data, encoding: .utf8) else { return }
        let lines = text.components(separatedBy: "\n")
        for line in lines {
            if line.hasPrefix("data: ") {
                let jsonStr = String(line.dropFirst(6))
                if let jsonData = jsonStr.data(using: .utf8),
                   let event = try? JSONDecoder().decode(SSEEvent.self, from: jsonData) {
                    if event.final == true { receivedFinalEvent = true }
                    DispatchQueue.main.async { [weak self] in
                        self?.onEvent?(event)
                    }
                }
            }
        }
    }

    private func handleConnectionEnd(error: Error?) {
        // Caller closed us (job completed, view dismissed) — no reconnect.
        if isClosed { return }

        // Server told us this was the last event. Don't reconnect just to
        // immediately get told it's done. Poll once for safety.
        if receivedFinalEvent {
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(2))
                await self?.pollJobStatus()
            }
            return
        }

        // Try to reconnect with exponential backoff. Each attempt waits
        // 2s, 4s, 8s, 16s, 32s, 60s. Total ~2 minutes of recovery before
        // we fall back to one-shot DB poll. During the backoff window
        // the periodic timeout check still polls every 45s of silence,
        // so the user isn't completely blind.
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        if isClosed { return }
        if reconnectAttempts >= maxReconnectAttempts {
            // Give up reconnecting; fall back to a single poll.
            Task { [weak self] in await self?.pollJobStatus() }
            return
        }
        let attempt = reconnectAttempts
        reconnectAttempts += 1
        let backoffSeconds = min(pow(2.0, Double(attempt + 1)), 60.0)
        print("[sse] reconnect attempt=\(attempt + 1)/\(maxReconnectAttempts) in \(backoffSeconds)s")
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Int(backoffSeconds)))
            guard let self, !self.isClosed else { return }
            // Tear down stale task before reconnect.
            self.task?.cancel()
            self.task = nil
            self.connect()
        }
    }

    private func startTimeoutChecker() {
        timeoutTimer?.invalidate()
        // Check every 10s; poll the DB the moment no event has arrived for 45s.
        // The render phase legitimately sends periodic progress, so 45s of pure
        // silence means something went wrong (worker crashed, Modal container
        // lost, SSE connection dropped without us noticing). Polling the DB
        // surfaces the failure fast instead of leaving the UI frozen.
        timeoutTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let elapsed = Date().timeIntervalSince(self.lastEventTime)
            if elapsed > 45 {
                Task { await self.pollJobStatus() }
            }
        }
    }

    private func pollJobStatus() async {
        // Reset the staleness clock regardless of outcome so the 10s ticker
        // doesn't re-poll immediately on the next tick when the job is still
        // genuinely processing. Successful poll → we learned something; no-op
        // poll → we checked in, wait another 45s before checking again.
        lastEventTime = Date()

        guard let token = await AuthService.shared.getValidToken() else {
            DispatchQueue.main.async { [weak self] in
                self?.onError?("Session expired. Please sign in again.")
            }
            disconnect()
            return
        }

        let supabaseUrl = "https://ejxkzsfruykvgeouymfy.supabase.co"
        let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqeGt6c2ZydXlrdmdlb3V5bWZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjE5ODgsImV4cCI6MjA3ODg5Nzk4OH0.KSH6xO3bPv9aK36zGZKCtnNCa1z7xI_H-VKx5ZRaTOE"

        var request = URLRequest(url: URL(string: "\(supabaseUrl)/rest/v1/video_jobs?id=eq.\(jobId)&select=status,rendered_video_url,thumbnail_url,error_message")!)
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        do {
            let (data, _) = try await URLSession.shared.data(for: request)

            struct JobStatus: Codable {
                let status: String?
                let rendered_video_url: String?
                let thumbnail_url: String?
                let error_message: String?
            }

            let jobs = try JSONDecoder().decode([JobStatus].self, from: data)
            guard let job = jobs.first else {
                DispatchQueue.main.async { [weak self] in
                    self?.onError?("Job not found")
                }
                disconnect()
                return
            }

            DispatchQueue.main.async { [weak self] in
                if job.status == "completed" || job.status == "complete" {
                    self?.onEvent?(SSEEvent(
                        status: "completed", progress: 100, step: "complete",
                        message: "Your video is ready!", videoUrl: job.rendered_video_url,
                        thumbnailUrl: job.thumbnail_url, error: nil, final: true
                    ))
                } else if job.status == "failed" {
                    self?.onEvent?(SSEEvent(
                        status: "failed", progress: nil, step: nil,
                        message: nil, videoUrl: nil, thumbnailUrl: nil,
                        error: job.error_message ?? "Something went wrong. Please try again.", final: true
                    ))
                }
                // If still processing, do nothing — wait for more SSE events or next timeout check
            }
        } catch {
            DispatchQueue.main.async { [weak self] in
                self?.onError?("Connection lost. Please try again.")
            }
            disconnect()
        }
    }
}

struct SSEEvent: Codable {
    let status: String?
    let progress: Int?
    let step: String?
    let message: String?
    let videoUrl: String?
    let thumbnailUrl: String?
    let error: String?
    let final: Bool? // swiftlint:disable:this identifier_name
}

private class SSEDelegate: NSObject, URLSessionDataDelegate {
    let onData: (Data) -> Void
    let onComplete: (Error?) -> Void

    init(onData: @escaping (Data) -> Void, onComplete: @escaping (Error?) -> Void) {
        self.onData = onData
        self.onComplete = onComplete
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        onData(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        onComplete(error)
    }
}

import Foundation

class SSEClient {
    private var task: URLSessionDataTask?
    /// Retain the URLSession. Previously connect() created it in a local var —
    /// each reconnect leaked a session (never invalidated → its delegate is
    /// retained forever) and left orphaned transports that could reopen /stream.
    private var session: URLSession?
    /// Reopen throttle. A belt-and-suspenders floor so no path (caller re-entry,
    /// scene churn, a stale forceReconnect) can reopen /stream faster than this,
    /// independent of the 2s backoff. The server-side sse-stream rate-limit exists
    /// because this was missing; this removes the cause, not just the symptom.
    private var lastConnectAt = Date.distantPast
    private static let minReconnectInterval: TimeInterval = 1.0
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
        // Reopen throttle: never open /stream faster than minReconnectInterval.
        // Cheap guard against any caller/scene re-entry that would otherwise churn
        // the endpoint (the 429-storm). The legitimate paths (2s backoff, an
        // infrequent foreground forceReconnect) clear this easily.
        let sinceLast = Date().timeIntervalSince(lastConnectAt)
        guard sinceLast >= Self.minReconnectInterval else { return }
        lastConnectAt = Date()

        // Tear down any prior transport before opening a new one — otherwise the
        // old session/task leaks and its socket can keep delivering/reconnecting.
        task?.cancel()
        session?.invalidateAndCancel()

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300
        config.timeoutIntervalForResource = 600

        let delegate = SSEDelegate(
            onData: { [weak self] data in self?.handleData(data) },
            onComplete: { [weak self] error in self?.handleConnectionEnd(error: error) }
        )

        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        self.session = session   // retain — was a local var that leaked every reconnect

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
        // Invalidate the session so its delegate is released and the transport
        // is fully torn down — not just the task cancelled.
        session?.invalidateAndCancel()
        session = nil
    }

    /// Foreground-recovery hook. iOS suspends the app aggressively; the
    /// SSE socket dies on suspension and the exponential backoff Task
    /// .sleep is paused along with the rest of the app. On resume the
    /// sleep continues from wherever it was — up to a full 60s — and
    /// the progress UI sits frozen the whole time even though the
    /// render is still streaming server-side.
    ///
    /// Calling this on scenePhase=.active cancels the pending backoff,
    /// resets the attempt counter, tears down the stale URLSessionTask,
    /// and reconnects immediately. Safe to call any time — no-ops after
    /// disconnect() or once the server has sent a terminal event.
    func forceReconnectIfNeeded() {
        if isClosed { return }
        if receivedFinalEvent { return }
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectAttempts = 0
        task?.cancel()
        task = nil
        lastEventTime = Date()
        connect()
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

        var request = URLRequest(url: URL(string: "\(supabaseUrl)/rest/v1/video_jobs?id=eq.\(jobId)&select=status,rendered_video_url,hls_manifest_url,thumbnail_url,error_message")!)
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        do {
            let (data, _) = try await URLSession.shared.data(for: request)

            struct JobStatus: Codable {
                let status: String?
                let rendered_video_url: String?
                let hls_manifest_url: String?
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
                // Success — canonical 'completed' (worker v193 + app both write it).
                if job.status == "completed" {
                    self?.onEvent?(SSEEvent(
                        status: "completed", progress: 100, step: "complete",
                        message: "Your video is ready!", videoUrl: job.rendered_video_url,
                        hlsManifestUrl: job.hls_manifest_url,
                        thumbnailUrl: job.thumbnail_url, error: nil, final: true,
                        errorCode: nil, userMessage: nil, retryable: nil,
                        requiresNewVideo: nil, requiresVibeChange: nil
                    ))
                } else if JobLifecycle.isTerminal(job.status) {
                    // ANY other terminal status — failed/error, canceled/cancelled,
                    // needs_input/needs_clarification. Emit a final event so the
                    // spinner stops no matter which vocab the worker used. Pass the
                    // status through (the UI branches on it) and carry the stored
                    // reason as the error message for the failure cases.
                    let isFailure = job.status == "failed" || job.status == "error"
                    self?.onEvent?(SSEEvent(
                        status: job.status, progress: nil, step: nil,
                        message: job.error_message, videoUrl: nil,
                        hlsManifestUrl: nil,
                        thumbnailUrl: nil,
                        error: isFailure
                            ? (job.error_message ?? "Something went wrong. Please try again.")
                            : nil,
                        final: true,
                        errorCode: nil, userMessage: nil, retryable: nil,
                        requiresNewVideo: nil, requiresVibeChange: nil
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
    let hlsManifestUrl: String?
    let thumbnailUrl: String?
    let error: String?
    let final: Bool? // swiftlint:disable:this identifier_name

    // Structured-error forward-compat. The worker currently sends
    // only a string `error` for SSE failures, but the render-dispatch
    // endpoint returns the structured envelope (error_code,
    // user_message, retryable, requires_new_video, requires_vibe_change)
    // for failures during dispatch. If the worker is ever upgraded to
    // emit the same shape in SSE error events, EditorView's SSE
    // handler will pick these up automatically and route to the same
    // Retry / "Try a different vibe" UX as dispatch failures — no
    // iOS update required.
    let errorCode: String?
    let userMessage: String?
    let retryable: Bool?
    let requiresNewVideo: Bool?
    let requiresVibeChange: Bool?

    enum CodingKeys: String, CodingKey {
        case status, progress, step, message
        case videoUrl, hlsManifestUrl, thumbnailUrl
        case error, final
        case errorCode = "error_code"
        case userMessage = "user_message"
        case retryable
        case requiresNewVideo = "requires_new_video"
        case requiresVibeChange = "requires_vibe_change"
    }
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

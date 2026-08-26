import Foundation
import UIKit

/// Background-eligible upload coordinator.
///
/// Wraps a `URLSessionConfiguration.background` session so uploads
/// continue running while the app is suspended OR fully terminated.
/// The OS finishes the transfer in the background and re-launches the
/// app to deliver the completion event via
/// `application(_:handleEventsForBackgroundURLSession:completionHandler:)`.
///
/// Constraints (Apple-imposed):
///   - Background sessions only support `uploadTask(with:fromFile:)`,
///     not the async/await Data variants.
///   - The session must be re-created with the same identifier on
///     every app launch so pending tasks reconnect to their delegate.
///
/// State model:
///   - `contexts[taskId]` records what each in-flight upload is for.
///     Persisted to UserDefaults so app-kill recovery works.
///   - `continuations[taskId]` is the suspended caller awaiting
///     the result. Lost across app kill — orphans fall through to
///     `onOrphanCompletion`.
///
/// Multipart uploads stay on the foreground session because their
/// per-chunk `Data` body isn't compatible with background sessions.
/// The 100MB single-PUT threshold means most uploads benefit here.
@MainActor
/// Best-effort snapshot of the last TRANSPORT-LEVEL upload error (the real
/// NSError from URLSession) — same doctrine as ReachabilityMonitor's static
/// conn snapshot. The alive-failure upload_failed emit happens UPSTREAM
/// (EditorView), where only a generic APIError survives — error_desc read
/// "Upload failed" on the DOMINANT enriched class and named nothing. Written
/// at every resume(throwing:) site in both upload managers; read+cleared at
/// emit. Racy by design: a telemetry tag, one active upload per message.
enum UploadDiagnostics {
    nonisolated(unsafe) static var lastTransportError: (domain: String, code: Int)?
}

final class BackgroundUploadManager: NSObject {
    static let shared = BackgroundUploadManager()

    /// AppDelegate stashes the OS completion handler here. When the
    /// session finishes draining its events, we call it back so iOS
    /// can mark the background task complete.
    var savedCompletionHandler: (() -> Void)?

    /// Fired for tasks that completed while the app was killed. The
    /// caller (ChatStore) uses messageId to update the right message.
    var onOrphanCompletion: ((_ messageId: String, _ chatId: String?, _ publicUrl: String?, _ errorMessage: String?) -> Void)?

    private struct UploadContext: Codable {
        let taskId: Int
        let messageId: String
        let chatId: String?
        let publicUrl: String
        let startedAt: Date
    }

    private let storeKey = "BackgroundUploadManager.contexts.v1"
    private let sessionId = "app.usepromptly.bg-upload-v1"
    private var contexts: [Int: UploadContext] = [:]
    private var continuations: [Int: CheckedContinuation<String, Error>] = [:]
    private var progressHandlers: [Int: (Double) -> Void] = [:]
    private let stateLock = NSLock()

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: sessionId)
        config.allowsCellularAccess = true
        config.allowsExpensiveNetworkAccess = true
        // Discretionary=false → upload runs ASAP. true would let the OS
        // wait for wifi + power, which is wrong for user-initiated uploads.
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        // Allow 30 minutes for a single PUT before iOS gives up.
        config.timeoutIntervalForResource = 30 * 60
        // Session creates and owns its own delegate queue.
        return URLSession(configuration: config, delegate: BackgroundUploadDelegate.shared, delegateQueue: nil)
    }()

    override init() {
        super.init()
        loadContexts()
        // Touch the lazy session so it reconnects on app launch and any
        // tasks that completed while we were killed deliver their
        // delegate callbacks. Without this, the session sits dormant
        // until the first new upload starts.
        _ = session
        // Reclaim durable source copies orphaned by an app-kill mid-upload.
        // Only sweeps files older than the resume window so an in-flight
        // background transfer never loses the bytes it's still sending.
        UploadStorage.sweepOrphans()
    }

    /// Submit an upload. Caller awaits and gets back the public URL.
    /// While the await is pending, the app may suspend or be killed —
    /// the OS continues the upload regardless.
    func upload(
        fileUrl: URL,
        toRemote remoteUrl: URL,
        mimeType: String,
        messageId: String,
        chatId: String?,
        publicUrl: String,
        onProgress: @escaping (Double) -> Void
    ) async throws -> String {
        var req = URLRequest(url: remoteUrl)
        req.httpMethod = "PUT"
        req.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        // P0 (PROMPTLY-IOS-2Y/2Z/31/37): uploadTask(with:fromFile:) raises an
        // NSInvalidArgumentException — uncatchable in Swift — when the file is
        // missing/unreadable at creation time, and that killed the app. Two
        // fences: (1) verify the file IMMEDIATELY before creation; (2) create
        // through the ObjC catcher so an exception can never propagate. Either
        // failure becomes a normal upload failure with its own fingerprint.
        let path = fileUrl.path
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        let size = (attrs?[.size] as? Int64) ?? 0
        guard FileManager.default.isReadableFile(atPath: path), size > 0 else {
            Analytics.track("upload_failed", props: [
                "mechanism": "source_file_missing_precreate",
                "path": "bg-single",
                "size_on_disk": size,
                "conn": ReachabilityMonitor.currentConnectionType,
            ], durable: true)
            throw APIError.uploadFailed
        }
        var createdTask: URLSessionUploadTask?
        let exception = ObjCExceptionCatcher.catchException {
            createdTask = self.session.uploadTask(with: req, fromFile: fileUrl)
        }
        guard exception == nil, let task = createdTask else {
            Analytics.track("upload_failed", props: [
                "mechanism": "task_create_exception",
                "path": "bg-single",
                "exception": String(exception?.name.rawValue ?? "unknown").prefix(60).description,
                "conn": ReachabilityMonitor.currentConnectionType,
            ], durable: true)
            throw APIError.uploadFailed
        }
        let taskId = task.taskIdentifier
        let ctx = UploadContext(
            taskId: taskId,
            messageId: messageId,
            chatId: chatId,
            publicUrl: publicUrl,
            startedAt: Date()
        )
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
            stateLock.lock()
            contexts[taskId] = ctx
            continuations[taskId] = cont
            progressHandlers[taskId] = onProgress
            persistContextsLocked()
            stateLock.unlock()
            task.resume()
        }
    }

    // MARK: - Delegate forwarding (called by BackgroundUploadDelegate)

    fileprivate func didReceiveProgress(taskId: Int, progress: Double) {
        stateLock.lock()
        let handler = progressHandlers[taskId]
        stateLock.unlock()
        if let handler {
            DispatchQueue.main.async { handler(progress) }
        }
    }

    fileprivate func didComplete(taskId: Int, response: URLResponse?, error: Error?) {
        stateLock.lock()
        let cont = continuations.removeValue(forKey: taskId)
        let ctx = contexts.removeValue(forKey: taskId)
        progressHandlers.removeValue(forKey: taskId)
        persistContextsLocked()
        stateLock.unlock()

        let httpStatus = (response as? HTTPURLResponse)?.statusCode ?? 0
        let success = error == nil && (200...299).contains(httpStatus)
        if !success {
            let nsErr = error as NSError?
            print("[BgUpload] task=\(taskId) FAILED status=\(httpStatus) " +
                  "domain=\(nsErr?.domain ?? "-") code=\(nsErr?.code ?? 0) " +
                  "desc=\(nsErr?.localizedDescription ?? "no error object")")
        }

        if let cont {
            // Caller is still alive — resume the await. The terminal analytics
            // fire on the caller; the HTTP status would be DISCARDED here, so
            // mirror it first (the HTTPClientError class Sentry captures
            // invisibly — same signal, queryable side).
            if !success {
                Analytics.track("upload_http_error", props: [
                    "path": "bg-single",
                    "status": httpStatus,
                    "conn": ReachabilityMonitor.currentConnectionType,
                ])
            }
            if let error {
                let ns = error as NSError
                UploadDiagnostics.lastTransportError = (ns.domain, ns.code)
                cont.resume(throwing: error)
            } else if !success {
                UploadDiagnostics.lastTransportError = ("HTTP", httpStatus)
                cont.resume(throwing: APIError.uploadFailed)
            } else if let ctx {
                cont.resume(returning: ctx.publicUrl)
            } else {
                cont.resume(throwing: APIError.uploadFailed)
            }
            return
        }

        // No continuation — task completed while app was killed.
        // Build 222: the normal analytics emit lives on the (now-dead) caller, so
        // an orphan success was UNDER-COUNTED (inflating apparent upload failure)
        // and an orphan failure was invisible. Re-emit here, tagged
        // path:"background_orphan", so the funnel counts app-killed uploads too.
        // Safe off-MainActor (Analytics.track dispatches its own task).
        if success {
            Analytics.track("upload_completed", props: ["path": "background_orphan"])
        } else {
            let code = (error as NSError?)?.code
            let mech: String
            switch code {
            case NSURLErrorTimedOut: mech = "timeout"
            case NSURLErrorNetworkConnectionLost: mech = "network_lost"
            case NSURLErrorNotConnectedToInternet: mech = "offline"
            case NSURLErrorCancelled: mech = "cancelled"
            default: mech = httpStatus > 0 ? "http_\(httpStatus)" : (code.map { "url_error_\($0)" } ?? "unknown")
            }
            Analytics.track("upload_failed", props: [
                "mechanism": mech,
                "path": "background_orphan",
                "http_status": httpStatus,
                "error_domain": (error as NSError?)?.domain ?? "",
                "error_code": (error as NSError?)?.code ?? 0,
                // src_key joins this app-killed failure to its upload_attempt (size/path)
                // and to the video_jobs row — the orphan class was the biggest silent
                // loser and was entirely keyless before this.
                "src_key": URL(string: ctx?.publicUrl ?? "")?.lastPathComponent ?? "",
                "conn": ReachabilityMonitor.currentConnectionType,
                // This branch fires only when the in-memory continuation is gone — the
                // process was terminated and relaunched to deliver the background
                // URLSession completion. That IS the relaunched-after-termination state.
                "lifecycle": "relaunched",
            ], durable: true)
            // Tell the user NOW — the process was relaunched in background to
            // learn this; without the notification they discover it whenever
            // they happen to return.
            UploadFailureNotifier.notifyUploadDied()
        }
        // Notify ChatStore so it can update the message in the
        // persisted chat record.
        if let ctx {
            DispatchQueue.main.async { [weak self] in
                self?.onOrphanCompletion?(
                    ctx.messageId,
                    ctx.chatId,
                    success ? ctx.publicUrl : nil,
                    success ? nil : (error?.localizedDescription ?? "Upload failed (HTTP \(httpStatus))")
                )
            }
        }
    }

    fileprivate func didFinishEvents() {
        DispatchQueue.main.async { [weak self] in
            self?.savedCompletionHandler?()
            self?.savedCompletionHandler = nil
        }
    }

    // MARK: - Persistence

    private func persistContextsLocked() {
        let arr = Array(contexts.values)
        if let data = try? JSONEncoder().encode(arr) {
            UserDefaults.standard.set(data, forKey: storeKey)
        }
    }

    private func loadContexts() {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard let data = UserDefaults.standard.data(forKey: storeKey),
              let arr = try? JSONDecoder().decode([UploadContext].self, from: data) else {
            return
        }
        for ctx in arr { contexts[ctx.taskId] = ctx }
    }
}

/// Plain NSObject delegate. Background URLSession requires its delegate
/// to conform to URLSessionTaskDelegate; we route all callbacks back to
/// the `@MainActor` coordinator above so its mutable state stays
/// MainActor-isolated.
private final class BackgroundUploadDelegate: NSObject, URLSessionTaskDelegate {
    static let shared = BackgroundUploadDelegate()

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        let progress = totalBytesExpectedToSend > 0
            ? Double(totalBytesSent) / Double(totalBytesExpectedToSend)
            : 0
        let taskId = task.taskIdentifier
        Task { @MainActor in
            BackgroundUploadManager.shared.didReceiveProgress(taskId: taskId, progress: progress)
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        let taskId = task.taskIdentifier
        let response = task.response
        Task { @MainActor in
            BackgroundUploadManager.shared.didComplete(taskId: taskId, response: response, error: error)
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        Task { @MainActor in
            BackgroundUploadManager.shared.didFinishEvents()
        }
    }
}

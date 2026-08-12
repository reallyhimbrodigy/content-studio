import Foundation

/// Owns the "from upload-complete to confirmed jobId" leg of the render
/// pipeline. Responsibilities:
///   1. Wait for source + proxy upload using a stagnation timer (the old
///      240s wall-clock falsely failed healthy uploads on slow cellular).
///   2. Pause when offline; resume when the network returns.
///   3. Call `createVideoJob` and classify the outcome.
///
/// Philosophy on errors: we DON'T silently retry worker-side failures.
/// If `EDITOR_TIMEOUT` or `RENDER_FFMPEG` keeps coming up, there's a real
/// bug behind it and wrapping it in retry would just delay the user's
/// pain. Surface it, log it, fix it. The only thing we retry here is a
/// `URLError` — a genuine physical connection blip on the client side.
/// (And `APIService.requestData` already retried twice before bubbling
/// it to us, so even that is rare.)
///
/// Hard outcomes (paywall, bad video, vibe rewrite, malformed) all flow
/// through `HardFailure` to keep the call site simple.
///
/// Cancellation: caller wraps `dispatch(...)` in a Task and calls
/// `cancel()`. The coordinator checks `Task.isCancelled` between every
/// step and returns `.cancelled` promptly.
@MainActor
final class JobDispatchCoordinator {
    static let shared = JobDispatchCoordinator()

    /// PROCESS-LEVEL live-dispatch registry (review fix): keyed by the
    /// client-minted job UUID. Unlike any message-transient flag, this
    /// survives chat switches and store reloads (the messages array is
    /// rebuilt; this singleton isn't) and correctly dies with the process
    /// (after a relaunch nothing is live, so a row-less bubble is a corpse).
    /// The reconciler consults it before terminalizing an empty-row job.
    private(set) var activeClientJobIds: Set<String> = []
    func isDispatchActive(_ clientJobId: String?) -> Bool {
        guard let id = clientJobId?.lowercased() else { return false }
        return activeClientJobIds.contains(id)
    }
    private init() {}

    enum Outcome {
        case success(jobId: String)
        case hardFailure(HardFailure)
        case cancelled
    }

    /// The only thing that escapes to the UI. Everything else is a
    /// silent retry. `isPaymentRequired` separates the paywall path
    /// (which isn't really a "failure" — it's a flow) from genuine
    /// hard fails like NOT_TALKING_HEAD.
    struct HardFailure {
        let errorCode: String?
        let userMessage: String
        let requiresNewVideo: Bool
        let requiresVibeChange: Bool
        let isPaymentRequired: Bool
        let paymentKind: String?
        let paymentLimit: Int?
    }

    /// Phase reports for the UI. Today the only consumer updates the
    /// progress bar from `.waitingForUpload`; the rest are logged for
    /// debugging.
    enum AttemptPhase {
        case waitingForUpload(progress: Double)
        case waitingForNetwork
        case dispatching(attempt: Int)
        case retrying(attempt: Int, after: TimeInterval, reason: String)
    }

    // Exponential backoff. Caps at 5 minutes once we're 6 attempts deep
    // (~12 minutes elapsed). Beyond that we keep trying at the cap rate
    // until the 24h ceiling.
    private static let backoff: [TimeInterval] = [5, 15, 45, 90, 180, 300]
    private static let maxBackoff: TimeInterval = 300

    /// Absolute give-up ceiling. A PROGRESSING upload never reaches this — the
    /// ceiling is only re-checked between retries (waitForUpload stays inside its
    /// own loop while bytes flow), so a genuinely slow-but-alive large upload
    /// completes normally. This bounds only a STUCK upload/dispatch: a dead socket
    /// or a repeatedly-failing createVideoJob now surfaces an honest error in ≤4
    /// min instead of spinning at ~11% for 20. (Was 20 min — the "frozen for ~9-20
    /// minutes then fails" hang.)
    private static let totalRetryCeiling: TimeInterval = 4 * 60

    /// Stagnation threshold for the upload-wait phase. If neither source nor proxy
    /// upload progress advances for this many seconds, the socket is dead — a
    /// healthy slow upload still makes SOME forward progress within 90s. Tuned down
    /// from 180s so a dead mid-upload connection is caught fast; still tolerates a
    /// 4G→3G handoff (brief, and it resumes progress well under 90s).
    private static let uploadStagnationSeconds: TimeInterval = 90

    /// Run the full upload-wait → createVideoJob loop with infinite soft
    /// retry. Returns when we have a jobId, a hard failure, or the
    /// caller cancelled.
    func dispatch(
        pendingVideo: PendingVideo,
        vibe: String,
        premiumPipeline: Bool = false,
        clientJobId: String? = nil,
        onPhase: @escaping (AttemptPhase) -> Void = { _ in }
    ) async -> Outcome {
        if let id = clientJobId?.lowercased() { activeClientJobIds.insert(id) }
        defer { if let id = clientJobId?.lowercased() { activeClientJobIds.remove(id) } }
        let startTime = Date()
        var attempt = 0

        while true {
            if Task.isCancelled { return .cancelled }
            if Date().timeIntervalSince(startTime) > Self.totalRetryCeiling {
                return .hardFailure(HardFailure(
                    errorCode: "DISPATCH_CEILING",
                    userMessage: "Upload didn't finish — the connection may be too slow for this clip. Your video is safe on your device. Try again on Wi-Fi, or trim it to a shorter highlight.",
                    requiresNewVideo: false,
                    requiresVibeChange: false,
                    isPaymentRequired: false,
                    paymentKind: nil,
                    paymentLimit: nil
                ))
            }

            // Don't burn battery polling the network from inside the
            // upload wait loop — gate at the top of every attempt instead.
            if !ReachabilityMonitor.shared.isOnline {
                onPhase(.waitingForNetwork)
                await ReachabilityMonitor.shared.waitForOnline()
            }

            switch await waitForUpload(pendingVideo: pendingVideo, onPhase: onPhase) {
            case .uploadComplete:
                break
            case .uploadHardFailure(let hf):
                return .hardFailure(hf)
            case .uploadStalled(let reason):
                let delay = backoffDelay(for: attempt)
                onPhase(.retrying(attempt: attempt, after: delay, reason: reason))
                print("[dispatch-coord] upload stalled — attempt=\(attempt) reason=\(reason) waiting \(Int(delay))s")
                try? await Task.sleep(for: .seconds(delay))
                attempt += 1
                continue
            case .cancelled:
                return .cancelled
            }

            guard let sourceUrl = pendingVideo.uploadedUrl else {
                let delay = backoffDelay(for: attempt)
                try? await Task.sleep(for: .seconds(delay))
                attempt += 1
                continue
            }

            attempt += 1
            onPhase(.dispatching(attempt: attempt))
            print("[dispatch-coord] createVideoJob attempt=\(attempt)")

            do {
                let jobId = try await APIService.shared.createVideoJob(
                    videoUrl: sourceUrl,
                    proxyVideoUrl: pendingVideo.proxyUploadedUrl,
                    vibe: vibe,
                    premiumPipeline: premiumPipeline,
                    clientJobId: clientJobId,
                    sourceType: pendingVideo.sourceType,
                    sourceDuration: pendingVideo.sourceDuration
                )
                print("[dispatch-coord] success jobId=\(jobId) attempt=\(attempt)")
                return .success(jobId: jobId)
            } catch {
                if Task.isCancelled { return .cancelled }
                switch classify(error: error) {
                case .hard(let hf):
                    print("[dispatch-coord] hard failure code=\(hf.errorCode ?? "?")")
                    return .hardFailure(hf)
                case .softRetry(let reason):
                    let delay = backoffDelay(for: attempt)
                    onPhase(.retrying(attempt: attempt, after: delay, reason: reason))
                    print("[dispatch-coord] soft retry attempt=\(attempt) reason=\(reason) waiting \(Int(delay))s")
                    try? await Task.sleep(for: .seconds(delay))
                }
            }
        }
    }

    // MARK: - Upload wait

    private enum UploadResult {
        case uploadComplete
        case uploadHardFailure(HardFailure)
        case uploadStalled(reason: String)
        case cancelled
    }

    /// Stagnation-based wait. Replaces the old 240s wall-clock — a
    /// large clip on a slow connection can legitimately take 10+ min.
    /// We only fail if forward progress stops for `uploadStagnationSeconds`.
    private func waitForUpload(
        pendingVideo: PendingVideo,
        onPhase: @escaping (AttemptPhase) -> Void
    ) async -> UploadResult {
        var lastProgressSnapshot = pendingVideo.uploadProgress + pendingVideo.proxyUploadProgress
        var lastProgressAt = Date()
        let pollNanos: UInt64 = 200_000_000  // 200ms — same cadence the old loop used

        while true {
            if Task.isCancelled { return .cancelled }

            if pendingVideo.uploadFailed {
                // The upload Task threw a terminal error (URLSession
                // background already does its own connectivity-wait, so
                // by the time we see this, the OS itself gave up). For
                // build 182 this surfaces as a hard failure — the UI
                // gets a "Tap to try again" button which re-runs the
                // upload Task. Restarting the upload from inside the
                // coordinator would require deeper coupling and isn't
                // worth it for the rare case where iOS itself gives up.
                return .uploadHardFailure(HardFailure(
                    errorCode: "UPLOAD_LOCAL_FAILED",
                    userMessage: "We couldn't upload your video. Tap to try again.",
                    requiresNewVideo: false,
                    requiresVibeChange: false,
                    isPaymentRequired: false,
                    paymentKind: nil,
                    paymentLimit: nil
                ))
            }

            if pendingVideo.sourceUploadCompleted && pendingVideo.proxyUploadFinished {
                return .uploadComplete
            }

            let now = pendingVideo.uploadProgress + pendingVideo.proxyUploadProgress
            if now > lastProgressSnapshot + 0.001 {
                lastProgressSnapshot = now
                lastProgressAt = Date()
            }

            onPhase(.waitingForUpload(progress: pendingVideo.uploadProgress))

            if Date().timeIntervalSince(lastProgressAt) > Self.uploadStagnationSeconds {
                return .uploadStalled(reason: "no upload progress for \(Int(Self.uploadStagnationSeconds))s")
            }

            try? await Task.sleep(nanoseconds: pollNanos)
        }
    }

    // MARK: - Error classification

    private enum Disposition {
        case hard(HardFailure)
        case softRetry(String)
    }

    /// Narrow classifier. The ONLY thing we silently retry is a real
    /// transient network error — those are physical connection blips,
    /// not bugs. Everything else surfaces immediately so it shows up
    /// in Sentry / user reports and we can root-cause it. Retrying a
    /// worker-side EDITOR_TIMEOUT or RENDER_FFMPEG is paper-over: there
    /// is a real bug behind it and silent retry just delays the user's
    /// pain. Fix the bug instead.
    ///
    /// (`requestData()` in APIService already retries URLError -1001 /
    /// -1005 / -1009 twice on its own. By the time one of those bubbles
    /// to us, the connection was actually dead for several seconds — we
    /// wait for `ReachabilityMonitor` and try once more, then surface
    /// if it still fails.)
    private func classify(error: Error) -> Disposition {
        if let urlError = error as? URLError {
            return .softRetry("URLError \(urlError.code.rawValue)")
        }

        guard let apiError = error as? APIError else {
            // Unclassified — surface so we see what it is.
            return .hard(HardFailure(
                errorCode: "UNCLASSIFIED",
                userMessage: "Something went wrong. We're looking into it.",
                requiresNewVideo: false,
                requiresVibeChange: false,
                isPaymentRequired: false,
                paymentKind: nil,
                paymentLimit: nil
            ))
        }

        switch apiError {
        case .paymentRequired(let kind, let limit, let msg):
            return .hard(HardFailure(
                errorCode: "PAYMENT_REQUIRED",
                userMessage: msg,
                requiresNewVideo: false,
                requiresVibeChange: false,
                isPaymentRequired: true,
                paymentKind: kind,
                paymentLimit: limit
            ))

        case .structuredFailure(let code, let userMessage, _, let requiresNewVideo, let requiresVibeChange):
            // Surface every structured failure verbatim. The worker
            // tells us what went wrong + what the user should do; we
            // just route to the right UX. If a code keeps appearing in
            // production, that's the signal to fix the underlying bug
            // — not to wrap it in retry.
            return .hard(HardFailure(
                errorCode: code,
                userMessage: userMessage,
                requiresNewVideo: requiresNewVideo,
                requiresVibeChange: requiresVibeChange,
                isPaymentRequired: false,
                paymentKind: nil,
                paymentLimit: nil
            ))

        case .validationRejected(let userMessage, _, _):
            return .hard(HardFailure(
                errorCode: "VALIDATION_REJECTED",
                userMessage: userMessage,
                requiresNewVideo: true,
                requiresVibeChange: false,
                isPaymentRequired: false,
                paymentKind: nil,
                paymentLimit: nil
            ))

        case .wallRequired(let message):
            // Enforced `.none` hit a gated door (post-flip; dark today). Treat
            // as a payment-class terminal so the dispatch surfaces it; the UI
            // routes to the trial wall via APIError.wallRequired at the call
            // site. paymentKind "wall" distinguishes it from the upgrade paywall.
            return .hard(HardFailure(
                errorCode: "WALL_REQUIRED",
                userMessage: message,
                requiresNewVideo: false,
                requiresVibeChange: false,
                isPaymentRequired: true,
                paymentKind: "wall",
                paymentLimit: nil
            ))

        case .uploadFailed:
            return .hard(HardFailure(
                errorCode: "UPLOAD_LOCAL_FAILED",
                userMessage: "We couldn't upload your video. Tap to try again.",
                requiresNewVideo: false,
                requiresVibeChange: false,
                isPaymentRequired: false,
                paymentKind: nil,
                paymentLimit: nil
            ))

        case .jobCreationFailed(let msg):
            return .hard(HardFailure(
                errorCode: "JOB_CREATE_FAILED",
                userMessage: msg.isEmpty ? "Something went wrong starting your render." : msg,
                requiresNewVideo: false,
                requiresVibeChange: false,
                isPaymentRequired: false,
                paymentKind: nil,
                paymentLimit: nil
            ))

        case .notAuthenticated:
            return .hard(HardFailure(
                errorCode: "NOT_AUTHENTICATED",
                userMessage: "Please sign in to continue.",
                requiresNewVideo: false,
                requiresVibeChange: false,
                isPaymentRequired: false,
                paymentKind: nil,
                paymentLimit: nil
            ))

        case .deleteFailed:
            return .hard(HardFailure(
                errorCode: "DELETE_FAILED",
                userMessage: "Something went wrong.",
                requiresNewVideo: false,
                requiresVibeChange: false,
                isPaymentRequired: false,
                paymentKind: nil,
                paymentLimit: nil
            ))
        }
    }

    private func backoffDelay(for attempt: Int) -> TimeInterval {
        if attempt < Self.backoff.count {
            return Self.backoff[attempt]
        }
        return Self.maxBackoff
    }
}

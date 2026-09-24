import Foundation

/// AN OUTAGE WE CAUSED MUST NOT COST THE USER THEIR CLIP.
///
/// WHAT THIS IS FOR, measured during the 2026-09-24 database outage: five
/// distinct users started an upload while the backend was unreachable. Three
/// got an honest failure. Two got NOTHING — they picked a clip, waited, and the
/// app said nothing at all. Every one of them would have had to find the clip
/// in their library and pick it again, for a fault entirely on our side.
///
/// The fix is not a better error message. It is to keep the clip and retry,
/// because the user has already done the only part that was theirs to do.
///
/// THE CLASSIFICATION IS THE WHOLE THING. Retrying the wrong failure is worse
/// than not retrying: a payment wall or a duration rejection retried for three
/// minutes is three minutes of the app pretending something might change, ending
/// in the same refusal. So the default is NOT to retry, and only causes that are
/// demonstrably ours and demonstrably transient are opted in by name.
enum PresignResilience {

    /// Backoff schedule in seconds. Totals ~3 minutes across six attempts —
    /// long enough to ride out a restart, short enough that a user watching the
    /// screen is not left wondering. Jittered by the caller is unnecessary here:
    /// one device retrying its own upload is not a thundering herd.
    static let backoff: [UInt64] = [2, 5, 15, 30, 60, 60]

    /// Is this failure OURS and TRANSIENT — worth waiting out?
    ///
    /// Deliberately a closed list. Anything unrecognised returns false and
    /// surfaces immediately, because a failure we cannot name is a failure we
    /// cannot promise will pass.
    static func isRetryableInfrastructure(_ error: Error) -> Bool {
        // The two shapes the outage actually produced. No session could be
        // minted because the auth backend was down — nothing about the user's
        // clip or account is wrong, and it fixes itself when the backend does.
        if let api = error as? APIError {
            switch api {
            case .notAuthenticated:
                return true
            case .uploadURLRefused(let status, _):
                // 5xx and 429 are ours; a 4xx is a decision about this request
                // and will be the same decision in three minutes.
                return status >= 500 || status == 429
            case .paymentRequired, .insufficientCredits, .freeExportSpent,
                 .wallRequired, .validationRejected, .reeditInFlight,
                 .paymentBlocked:
                // Refusals. Retrying them is pretending.
                return false
            case .uploadFailed, .deleteFailed, .jobCreationFailed, .structuredFailure:
                return false
            }
        }
        // Transport-level: the connection, not the request.
        let ns = error as NSError
        guard ns.domain == NSURLErrorDomain else { return false }
        switch ns.code {
        case NSURLErrorTimedOut,
             NSURLErrorCannotConnectToHost,
             NSURLErrorNetworkConnectionLost,
             NSURLErrorNotConnectedToInternet,
             NSURLErrorDNSLookupFailed,
             NSURLErrorResourceUnavailable,
             NSURLErrorBadServerResponse:
            return true
        case NSURLErrorCancelled:
            // The user or the system stopped it. Not ours to resume.
            return false
        default:
            return false
        }
    }

    /// Run `attempt` until it succeeds, until the failure is not ours, or until
    /// the schedule is exhausted.
    ///
    /// `onWaiting` reports the delay before each retry so the surface can say
    /// what is happening rather than spinning silently — the same reason the
    /// upload shows a real percent instead of "Getting started...".
    static func withRetry<T>(
        _ attempt: () async throws -> T,
        onWaiting: (Int, UInt64) -> Void = { _, _ in }
    ) async throws -> T {
        var lastError: Error?
        for (i, delay) in backoff.enumerated() {
            do {
                return try await attempt()
            } catch {
                lastError = error
                // NOT OURS: surface it now. Waiting would only delay the same answer.
                guard isRetryableInfrastructure(error) else { throw error }
                onWaiting(i + 1, delay)
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
                // A cancelled task must stop retrying — otherwise a user who
                // removed the clip keeps a loop alive behind them.
                if Task.isCancelled { throw error }
            }
        }
        // One last try after the final wait, so the schedule's last delay is
        // not spent for nothing.
        do { return try await attempt() }
        catch { throw error }
        _ = lastError
    }
}

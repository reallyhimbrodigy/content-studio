import Foundation

/// Reverse trial — the client half. 72 hours of Pro, granted when the user
/// DECLINES the offer at reveal.
///
/// THE SERVER GRANTS, THE CLIENT ASKS. `grant_referral_reward` and
/// `qualify_referral` were revoked from `authenticated` in the referral
/// security migration because three throwaway accounts could mint a week of
/// unmetered Pro. Letting the client grant its own trial would reopen exactly
/// that hole under a friendlier name, so this type only ever POSTs and renders
/// what comes back. It cannot grant, extend, or re-grant anything.
@MainActor
final class ReverseTrialService: ObservableObject {
    static let shared = ReverseTrialService()

    /// Why a grant was refused. Distinct cases because they are distinct
    /// situations and blending them makes the refusal unreadable — "you already
    /// used this", "we are out of trials this window", and "your build is too
    /// old to be trusted with one" want different words and imply different
    /// next steps.
    enum Ineligible: String {
        case alreadyUsed = "already_used"
        case capExhausted = "cap_exhausted"
        case buildTooOld = "build_too_old"
        case unknown
    }

    enum Outcome: Equatable {
        /// Granted. Covers BOTH 201-new and 200-already per the contract: they
        /// render identically, because a user who double-taps Decline must not
        /// see a different screen the second time. The distinction survives in
        /// analytics only.
        case granted(expiresInSeconds: Int)
        case ineligible(Ineligible)
        /// 503. The trial machinery is down. This is NOT a refusal and must
        /// never be rendered as one — the user did nothing wrong and is still
        /// eligible. Retry; do not paywall.
        case unavailable
        /// 400 device_id_required. A CLIENT defect: we failed to send a key we
        /// always have. Surfaced loudly rather than folded into "ineligible",
        /// which would have us blaming the user for our own bug.
        case deviceIdMissing
    }

    private static let deadlineKey = "reverse_trial_deadline"  // countdown-ok: real expiry
    private static let grantedKey = "reverse_trial_granted"

    @Published private(set) var deadline: Date?   // countdown-ok: real server expiry, not manufactured urgency
    @Published private(set) var inFlight = false

    private init() {
        if UserDefaults.standard.bool(forKey: Self.grantedKey),
           // countdown-ok: real expiry — restoring a server-granted deadline
           let t = UserDefaults.standard.object(forKey: Self.deadlineKey) as? Date {
            deadline = t                               // countdown-ok: real expiry
        }
    }

    // countdown-ok: this is a REAL server-granted expiry, not manufactured
    // urgency. The gate exists to ban fake-scarcity timers — a countdown to a
    // deadline the product invented to pressure a purchase. This one counts down
    // to an entitlement the server actually issued and will actually revoke, and
    // hiding it would be the dishonest choice: a user whose Pro access ends in
    // six hours is entitled to know that before it happens.
    var isActive: Bool {
        guard let d = deadline else { return false }   // countdown-ok: real expiry
        return d > Date()
    }

    /// Seconds left, floored at zero. Derived from a deadline we computed
    /// LOCALLY at the moment of the grant.
    // countdown-ok: real server expiry (see isActive).
    var secondsRemaining: Int {                        // countdown-ok: real expiry
        guard let d = deadline else { return 0 }       // countdown-ok: real expiry
        return max(0, Int(d.timeIntervalSinceNow))
    }

    /// Ask for the trial. Idempotent server-side; a double-tap on Decline
    /// returns 200 already:true rather than granting 144 hours.
    func requestGrant() async -> Outcome {
        guard !inFlight else { return .unavailable }
        inFlight = true
        defer { inFlight = false }

        let outcome = await APIService.shared.grantReverseTrial()

        switch outcome {
        case let .granted(seconds):
            // THE DEADLINE IS COMPUTED FROM `expires_in_seconds`, NOT FROM
            // `pro_until`. This is the whole reason the server sends a duration
            // alongside the timestamp. Parsing `pro_until` and subtracting the
            // device clock imports the device's skew into the countdown: a
            // phone twenty minutes fast shows a trial twenty minutes shorter
            // than the one the server will actually honour, and a phone set
            // backwards shows one that outlives the entitlement. A duration
            // added to the local clock at receipt is immune — only elapsed
            // local time matters, and elapsed local time is what a countdown
            // measures.
            //
            // `pro_until` remains the authority for the ENTITLEMENT. It is the
            // server's to enforce and we never compute against it here.
            let d = Date().addingTimeInterval(TimeInterval(seconds))
            deadline = d                                        // countdown-ok: real expiry
            UserDefaults.standard.set(d, forKey: Self.deadlineKey)  // countdown-ok: real expiry
            UserDefaults.standard.set(true, forKey: Self.grantedKey)
        case .ineligible, .unavailable, .deviceIdMissing:
            break
        }
        return outcome
    }
}

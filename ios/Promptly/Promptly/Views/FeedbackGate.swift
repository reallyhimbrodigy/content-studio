import Foundation

// MARK: - FeedbackGate
//
// Pure, clock-free decision math for the in-app feedback prompt cadence. No
// SwiftUI, no Combine, no timers, and crucially NO internal `Date()` — every
// function takes `now: Date` and an immutable `State` value as inputs, exactly
// like TricklePacing takes `elapsed`/`backendBar`. Kept dependency-free on
// purpose so it can be unit-tested with `swiftc` directly (see
// ios/Promptly/Tests). The stateful manager that owns UserDefaults persistence,
// network calls, and the StoreKit review request lives elsewhere
// (FeedbackManager); this struct only *decides* whether a prompt is due.
//
// Design (per the feedback-loop contract):
//   - We never pester a fresh user: a prompt is only ever eligible once the
//     user has actually had `MIN_RENDERS` successful renders. One good render
//     isn't enough signal — wait for the second so we ask someone who has seen
//     the product work more than once.
//   - After we show a prompt we go quiet for a cooldown. The cooldown GROWS
//     with how many times the user has ignored us in a row (`ignoreStreak`):
//     14 days the first time, 30 the next, 60 thereafter. Someone who keeps
//     dismissing us gets asked exponentially less often; someone who engages
//     resets their streak (the manager zeroes `ignoreStreak` on an answer) and
//     falls back to the short cadence.
//   - The native App Store review sheet is a scarce, Apple-rate-limited
//     resource, so it has its own independent floor: at most once per
//     `APPSTORE_MIN_INTERVAL_DAYS`. `appStoreReviewEligible` is the gate the
//     manager checks before ever calling SKStoreReviewController.
//
// All three thresholds are exposed as tunable constants so cadence can be
// retuned without touching the (tested) decision logic.
struct FeedbackGate {

    // MARK: Tunable constants

    /// Minimum number of successful renders before the very first prompt is
    /// allowed. Two means "we've watched the product work for them twice."
    static let MIN_RENDERS: Int = 2

    // MARK: The native review prompt (ruled 2026-09-07)
    //
    // ASK AT THE MOMENT OF DELIGHT, NEVER AT A GATE. The trigger is a completed
    // export or share — the user has the video they came for, in their hands.
    // Never after a failure, never on a paywall, never before their first video.
    //
    // ASK PEOPLE WHO HAVE HAD A GOOD EXPERIENCE. A user whose last render died
    // leaves a one-star, and they are the likeliest to review unprompted, so
    // the failure condition is not a nicety.
    //
    // ONCE, THEN A LONG SILENCE. Apple caps the sheet at three prompts a year
    // and silently discards the rest, so a bad trigger burns the quota with
    // nothing to show for it. Counted locally BECAUSE the discards are
    // invisible: the only way not to spend attempts Apple is throwing away is
    // to not make them.

    /// Successful renders required before the first ask.
    static let REVIEW_MIN_RENDERS: Int = 2
    /// Exports (save or share) required before the first ask. The trigger
    /// itself is an export, so this is satisfied by the very export that fires
    /// it — it exists to refuse a user who has never taken a video out.
    static let REVIEW_MIN_EXPORTS: Int = 1
    /// The long silence after the first ask. Well beyond Apple's own window, so
    /// a re-ask is a genuinely different season of use rather than a retry.
    static let REVIEW_REASK_DAYS: Double = 120

    /// Back-off schedule between prompts, indexed by `ignoreStreak` (clamped to
    /// the last entry). Streak 0 -> 14 days, 1 -> 30, 2+ -> 60. Tunable.
    static let COOLDOWN_DAYS: [Double] = [14, 30, 60]

    /// Hard floor between native App Store review requests, independent of the
    /// in-app prompt cadence. Apple rate-limits the sheet anyway; this keeps us
    /// well inside that and avoids burning the (sparse) annual allowance.
    static let APPSTORE_MIN_INTERVAL_DAYS: Double = 90

    /// Seconds per day — local helper so the constants above read in days.
    private static let SECONDS_PER_DAY: Double = 86_400

    // MARK: State
    //
    // An immutable snapshot of everything the gate needs to decide. The manager
    // builds this from UserDefaults and hands it in; the gate never mutates it.
    struct State {
        /// How many renders the user has successfully watched complete.
        var successfulRenderCount: Int = 0
        /// When we last *showed* a prompt (nil = never shown).
        var lastPromptAt: Date? = nil
        /// Consecutive prompts the user ignored (dismissed without answering).
        /// Drives the back-off; reset to 0 by the manager when they answer.
        var ignoreStreak: Int = 0
        /// When the user last *answered* a prompt (nil = never). Not used by the
        /// gate directly today, but persisted so the manager can reason about
        /// engagement and reset the streak.
        var lastAnswerAt: Date? = nil
        /// When we last asked for the native App Store review (nil = never).
        var lastAppStorePromptAt: Date? = nil
    /// Exports (save or share) this user has completed, lifetime.
    var exportCount: Int = 0
    /// Whether a render FAILED during the current app session. Session-scoped
    /// on purpose: it is not a permanent mark against the user, it is "right
    /// now is the wrong moment to ask".
    var failedRenderInSession: Bool = false
    }

    // MARK: Pure decisions

    /// The cooldown (in seconds) that must elapse after `lastPromptAt` before
    /// another in-app prompt is allowed, given the current ignore streak. The
    /// streak indexes `COOLDOWN_DAYS`, clamped to its last entry so any streak
    /// of 2 or more maps to the longest cadence. Non-decreasing in `ignoreStreak`.
    static func cooldown(ignoreStreak: Int) -> TimeInterval {
        // Clamp into [0, count-1] so negative or runaway streaks are safe.
        let idx = max(0, min(ignoreStreak, COOLDOWN_DAYS.count - 1))
        return COOLDOWN_DAYS[idx] * SECONDS_PER_DAY
    }

    /// Whether an in-app feedback prompt is due right now.
    ///   - false if the user hasn't had `MIN_RENDERS` successful renders yet
    ///     (we never ask a brand-new user).
    ///   - false if we've shown a prompt and the streak-scaled cooldown hasn't
    ///     elapsed (we stay quiet during back-off).
    ///   - true otherwise: enough renders, and either we've never prompted or
    ///     the cooldown is fully past.
    static func shouldShowPrompt(state: State, now: Date) -> Bool {
        // Gate 1: earn the right to ask — at least MIN_RENDERS good renders.
        if state.successfulRenderCount < MIN_RENDERS { return false }

        // Gate 2: respect the back-off window since the last prompt. If we have
        // never prompted (`lastPromptAt == nil`), there's no window to respect.
        if let last = state.lastPromptAt {
            let elapsed = now.timeIntervalSince(last)
            if elapsed < cooldown(ignoreStreak: state.ignoreStreak) {
                return false
            }
        }

        // Earned the renders, and not inside a cooldown window: prompt is due.
        return true
    }

    /// Whether the native App Store review sheet may be requested right now.
    /// True only if we've never asked, or the minimum interval has fully
    /// elapsed since the last ask. This is intentionally separate from
    /// `shouldShowPrompt` so the in-app prompt can appear far more often than
    /// the rate-limited StoreKit sheet.
    /// Whether the native review sheet may be asked for at THIS export.
    ///
    /// Every condition is a refusal, and each one is here because asking the
    /// wrong person is worse than not asking:
    ///
    ///   - two successful renders: not their first video, so the ask follows a
    ///     pattern of the product working rather than a single lucky run;
    ///   - one export: they have taken something out of the app;
    ///   - no failed render in this session: the user whose render just died is
    ///     precisely the one-star, and they are already the likeliest to review
    ///     unprompted;
    ///   - never asked, or asked more than REVIEW_REASK_DAYS ago AND exporting
    ///     again — a second ask has to be earned by a second good experience,
    ///     not merely by the calendar.
    static func reviewPromptEligible(state: State, now: Date) -> Bool {
        guard state.successfulRenderCount >= REVIEW_MIN_RENDERS else { return false }
        guard state.exportCount >= REVIEW_MIN_EXPORTS else { return false }
        guard !state.failedRenderInSession else { return false }
        guard let last = state.lastAppStorePromptAt else { return true }
        return now.timeIntervalSince(last) >= REVIEW_REASK_DAYS * SECONDS_PER_DAY
    }

    static func appStoreReviewEligible(state: State, now: Date) -> Bool {
        guard let last = state.lastAppStorePromptAt else {
            // Never asked — always eligible the first time.
            return true
        }
        let elapsed = now.timeIntervalSince(last)
        return elapsed >= APPSTORE_MIN_INTERVAL_DAYS * SECONDS_PER_DAY
    }
}

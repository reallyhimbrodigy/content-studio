import Foundation

/// IS THIS A GENUINE FIRST INSTALL?
///
/// ONE definition, because there were three (2026-09-07). The onboarding v2
/// funnel asked all three signals; the first-launch paywall asked only
/// `!FirstRun.seen`; the first-session autopicker asked a UserDefaults flag of
/// its own, `first_session_autopicker_fired`, and nothing else. So a user who
/// deleted and reinstalled kept their account, their plan and their history —
/// and was handed the system photo picker on launch as if they were new.
///
/// The rule (ruled 2026-09-07): the funnel fires only for a genuine first
/// install. ANY ONE of the signals below means the user has been here before,
/// and they go straight to chat.
///
/// The signals are chosen for one property: they survive a delete-and-reinstall.
/// The flags that were being consulted — hasCompletedOnboarding,
/// hasSeenFirstLaunchPaywall, first_session_autopicker_fired — all live in
/// UserDefaults, which is erased with the app. Storage that gets wiped cannot
/// answer "have you been here before"; that was the bug.
///
///   1. A RESTORED SESSION. The Keychain survives the reinstall, so
///      `checkSession` brings the same user back. Not `isAuthenticated`, which
///      under deferred auth is true for a brand-new install within a second —
///      `signInAnonymouslyIfNeeded` mints a user for everyone. Only a RESTORE
///      answers the question.
///   2. THE FIRSTRUN MARKER, also Keychain-backed.
///   3. THE SERVER'S ANSWER, /api/install/seen?device_id= — for the reinstall
///      that is signed out, where neither of the above is in hand. Fails open.
///
/// NOT IP (ruled 2026-09-07, cost stated by the owner). Mobile carriers use
/// CGNAT and Promptly's traffic is India-dominant, so thousands of genuinely new
/// users share a small pool of egress addresses. An IP match would suppress the
/// funnel for them. Session plus device_id covers the reinstall exactly, with no
/// false positives.
@MainActor
enum FirstInstall {

    /// Any ONE of these means they have been here before.
    static var hasBeenHereBefore: Bool {
        #if DEBUG
        // `-poseFreshInstall` — DEBUG only, compiled out of Release.
        //
        // A UI test cannot produce a genuine first install: the signals that
        // define one live in the KEYCHAIN, which survives uninstall and cannot
        // be cleared from inside a test run. Only `simctl erase` does that, and
        // the rule itself is already proven that way — three cases on an erased
        // device, verdict read from a settled log line.
        //
        // So this poses the ANSWER, and the funnel tests that stand on it are
        // testing the funnel's own content, not the rule that admits them to
        // it. Two different claims, proven by two different means, and neither
        // standing in for the other.
        if ProcessInfo.processInfo.arguments.contains("-poseFreshInstall") { return false }
        #endif
        // The implicit return is gone now the body has more than one statement.
        return AuthService.shared.restoredExistingSession
            || FirstRun.seen
            || InstallHistory.deviceKnownToServer
    }

    /// The funnel — and every other first-run surface — fires only on this.
    static var isFirstInstall: Bool { !hasBeenHereBefore }

    /// Whether the signals are in hand yet. Deciding before they resolve is how
    /// a returning user gets the funnel anyway: the answer arrives a moment
    /// after the screen it would have suppressed. Callers that can wait pass
    /// their own bounded deadline, the same one the entitlement wait uses —
    /// nothing counts down on screen.
    static func hasResolved(deadlinePassed: Bool) -> Bool {   // countdown-ok: internal readiness, nothing rendered
        if hasBeenHereBefore { return true }   // a positive answer needs no wait
        if deadlinePassed { return true }   // countdown-ok: internal wait bound, never rendered
        return !AuthService.shared.isLoading && InstallHistory.hasResolved
    }
}

import Foundation

/// Pure, UI-free decision core for wedge-proof paywall routing.
///
/// The bug this exists to kill (RACE 1 / RACE 2): a paywall requested while a
/// blocking modal (a full-screen video player, or a sheet that's mid-dismiss)
/// owns the presentation context is silently dropped by UIKit/SwiftUI — yet the
/// request leaves `reason` non-nil, so the root sheet's `reason != nil` binding
/// stays "presented," and every *later* trigger is muted for the whole session.
///
/// This type makes the two guarantees testable without importing SwiftUI:
///   1. A request that arrives behind a blocking modal is PARKED and presented
///      once the modal reports its dismissal (`flush()`), never dropped.
///   2. A request that lands on top of an already-set reason flags `needsRedrive`
///      so the SwiftUI mirror re-drives through nil — a dropped sheet can never
///      wedge the session.
///
/// Generic over the reason so it unit-tests standalone; `AppState` specializes it
/// to `PaywallReason` and mirrors `reason` into its `@Published` binding.
struct PaywallRouting<Reason: Equatable> {

    /// What the root sheet should be bound to right now (non-nil ⇒ present).
    private(set) var reason: Reason?
    /// A request parked behind a blocking modal, promoted by `flush()`.
    private(set) var parked: Reason?
    /// True when the mirror must re-drive through nil to force a re-present:
    /// `reason` moved from one non-nil value to another, which a `!= nil`
    /// SwiftUI binding would otherwise ignore (the session wedge). The mirror
    /// clears it via `redriveHandled()`.
    private(set) var needsRedrive = false

    /// Present a paywall now (nothing blocking).
    mutating func request(_ r: Reason) {
        needsRedrive = (reason != nil && reason != r)
        reason = r
    }

    /// Park a request behind a blocking modal (player / mid-dismiss sheet).
    /// Shows nothing yet; `flush()` promotes it once the modal is gone.
    mutating func park(_ r: Reason) {
        parked = r
    }

    /// Take the parked request (return it and clear it). The player path presents
    /// the paywall via UIKit from the parked reason rather than through the
    /// SwiftUI `.sheet` — which is silently dropped right after a UIKit full-screen
    /// modal dismisses (proven by presentation).
    mutating func takeParked() -> Reason? {
        defer { parked = nil }
        return parked
    }

    /// The blocking modal finished dismissing — promote any parked request.
    mutating func flush() {
        guard let p = parked else { return }
        parked = nil
        request(p)
    }

    /// The paywall sheet was dismissed (user closed it). Clear, and promote
    /// anything queued behind it so a request can never be silently lost.
    mutating func dismissed() {
        reason = nil
        needsRedrive = false
        if let p = parked {
            parked = nil
            request(p)
        }
    }

    /// Called by the mirror once it has performed the nil re-drive.
    mutating func redriveHandled() {
        needsRedrive = false
    }
}

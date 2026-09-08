import Foundation
import SwiftUI

/// The seam between browsing and doing.
///
/// Under deferred auth the user reaches the paywall, the questions, the reveal
/// and the chat without an account. Auth is asked for at the first action that
/// needs one — a purchase, an export, anything that writes to their profile —
/// and the point of this type is that the ask does not LOSE the action.
///
/// WHY AN INTENT AND NOT JUST A SHEET. The failure mode of deferred auth is not
/// the sign-in screen; it is what happens after it. A user taps Continue on a
/// plan, signs up, and lands back at the start of the funnel with nothing
/// bought — they did the work twice or they leave. Recording WHAT was being
/// attempted lets sign-in hand control back to that exact action, which is the
/// only version of this flow worth shipping.
///
/// The intent is deliberately a small value, not a closure. A closure captured
/// before sign-in would hold the pre-auth world — a `Package` from an offering
/// that may have been refreshed, services that re-identified underneath it. A
/// product id re-resolved against the CURRENT offering after sign-in cannot go
/// stale that way.
@MainActor
final class AuthGate: ObservableObject {
    static let shared = AuthGate()
    private init() {}

    enum Intent: Equatable {
        /// Resolved against the live offering after sign-in, never a captured
        /// `Package`.
        case purchase(productId: String, context: String)
        case export(jobId: String?)
        /// Anything that writes to the user's own row.
        case profileWrite(String)

        /// Purchase intents are presented from inside the paywall so the paywall
        /// survives the sign-in (a second sheet from AppShell replaced it, and
        /// the resumed purchase then opened over the chat — executed 2026-09-05).
        var isPurchase: Bool { if case .purchase = self { return true } else { return false } }
        var analyticsName: String {
            switch self {
            case .purchase:     return "purchase"
            case .export:       return "export"
            case .profileWrite: return "profile_write"
            }
        }
    }

    /// What the user was doing when we stopped them. Nil when nothing is
    /// pending.
    @Published private(set) var pending: Intent?
    /// THE SEND SEAM RESUMES. A signed-out send is gated on sign-in and the
    /// composer keeps its text; when the gate resolves for a send, the editor's
    /// registered send runs — without this the user signed in and then sat
    /// looking at their own unsent message (executed 2026-09-05). A closure
    /// rather than a published value: one more modifier on the editor's body
    /// chain put the type-checker over its limit.
    var onSendResume: (() -> Void)?
    /// THE RESUME LANDS WHERE THE TAP WOULD HAVE. `resume` called
    /// `SubscriptionService.purchase` directly, which goes straight to Apple —
    /// so a US user who should have seen the checkout step got Apple's sheet
    /// instead, purely because they had signed in on the way. The paywall
    /// registers this and re-runs its OWN routing (CheckoutRouter first, Apple
    /// otherwise), so the plan they chose resolves the same way it would have
    /// before the interruption. A closure, like onSendResume, because the
    /// decision needs the paywall's view state.
    var onPurchaseResume: ((String, String) -> Void)?
    var pendingIsPurchase: Bool { pending?.isPurchase ?? false }
    /// Drives the sign-in presentation.
    @Published var isPresenting = false

    /// The seam as a FUNCTION, so it can be executed rather than only read.
    ///
    /// The guards were wired at three call sites and verified by a gate that
    /// reads the source — which proves the line is there, not that it does
    /// anything. Naming the check gives every seam one implementation and makes
    /// it callable from a probe, so "chat send refuses when signed out" becomes
    /// something that can be RUN instead of argued from a grep.
    ///
    /// Returns true when the caller may proceed. When it returns false the
    /// sign-in sheet is already rising and the intent is recorded.
    /// DEFERRED AUTH GATES ONE SEAM: PURCHASE (ruled 2026-09-06).
    ///
    /// The anonymous Supabase session already exists and the free credit grant
    /// is keyed on device_id, so nothing in the render path needs a real
    /// account: chat send, upload, render, re-edit and share all work signed
    /// out. Sign-in appears exactly once — tapping a plan on the paywall or a
    /// pack on the top-up screen — and the resume path lands them back in
    /// checkout. Account creation stays available in the account page for
    /// anyone who wants their history synced; optional, never required.
    ///
    /// A non-purchase intent is therefore ALLOWED rather than gated. The cases
    /// are kept so the probe and the gate can assert they never raise, which is
    /// a stronger guarantee than deleting them and trusting no one adds a call.
    /// SIGNED IN MEANS A REAL ACCOUNT, NOT MERELY A SESSION (2026-09-07).
    ///
    /// Both guards below tested `currentUser?.id != nil`. Under deferred auth
    /// every user gets an ANONYMOUS Supabase session at launch, with a real id
    /// — so that test passed for exactly the people the seam exists to stop.
    /// `allow` returned true, `require` returned early without presenting, and
    /// the purchase seam never fired for anyone. It was written for a world
    /// where a signed-out user had no session at all, and anonymous sign-in
    /// quietly removed that world.
    ///
    /// It matters most on the WEB path, where it is a correctness question and
    /// not only a flow one: the checkout link carries app_user_id in its PATH,
    /// so a purchase taken before sign-in attaches to the anonymous customer.
    /// If the user then signs into an EXISTING account (the
    /// identity_already_exists branch, where the uid genuinely changes) the
    /// entitlement lands on an id they have walked away from.
    private var hasRealAccount: Bool {
        AuthService.shared.currentUser?.id != nil
            && !AuthService.shared.hasAnonymousSession
    }

    @discardableResult
    func allow(_ intent: Intent) -> Bool {
        if hasRealAccount { return true }
        guard intent.isPurchase else { return true }
        require(intent)
        return false
    }

    /// Stop, ask for an account, and remember why.
    /// THE USER ASKING IS NOT THE APP GATING. `require` refuses every
    /// non-purchase intent by design — deferred auth gates one seam. But the
    /// account page's "Sign in or create account" is the user choosing to get an
    /// account, so it opens the same sheet without going through the gate.
    func presentForSignIn() {
        guard AuthService.shared.currentUser?.isAnonymous != false else { return }
        pending = .profileWrite("account_signin")
        isPresenting = true
        Analytics.track("auth_sheet_opened", props: ["source": "account"])
    }

    func require(_ intent: Intent) {
        guard !hasRealAccount else { return }
        // The one seam. Anything else asking to gate is a regression, not a
        // request — it is dropped here rather than reaching the presenter.
        guard intent.isPurchase else {
            Analytics.track("auth_gate_suppressed", props: ["intent": intent.analyticsName])
            return
        }
        pending = intent
        isPresenting = true
        Analytics.track("auth_gate_shown", props: ["intent": intent.analyticsName])
    }

    /// Called once sign-in succeeds. Returns the intent to replay, and clears
    /// it so a later redraw cannot replay it twice — a duplicated purchase is
    /// the one bug this whole mechanism must not introduce.
    func takePending() -> Intent? {
        let p = pending
        // ORDER MATTERS. Clearing `pending` first left one frame where
        // `isPresenting` was still true and `pendingIsPurchase` already false —
        // AppShell's own sheet became eligible, presented over the paywall's
        // sheet, and took the paywall down with it (executed 2026-09-05).
        isPresenting = false
        pending = nil
        if let p { Analytics.track("auth_gate_resumed", props: ["intent": p.analyticsName]) }
        return p
    }

    /// The user backed out of sign-in. The intent dies with it; nothing is
    /// half-done.
    func cancel() {
        if let p = pending {
            Analytics.track("auth_gate_abandoned", props: ["intent": p.analyticsName])
        }
        pending = nil
        isPresenting = false
    }

    /// Signed in with nothing to replay. The sheet still has to close.
    ///
    /// `cancel()` would do it, but it means abandonment and reports it that
    /// way; a completed sign-in is the opposite outcome and must not be
    /// counted as one.
    func finish() {
        pending = nil
        isPresenting = false
    }

    /// Replay. Purchase is re-resolved against the current offering, so a
    /// refresh during sign-in cannot make this act on a stale product.
    func resume(_ intent: Intent) {
        switch intent {
        case let .purchase(productId, context):
            let packages = SubscriptionService.shared.offerings?.current?.availablePackages ?? []
            guard let pkg = packages.first(where: {
                $0.storeProduct.productIdentifier == productId
            }) else {
                // The product is no longer on offer. Say nothing and show the
                // paywall rather than silently doing nothing, which would read
                // as the purchase having failed.
                Analytics.track("auth_gate_resume_missing_product",
                                props: ["product": productId, "context": context])
                return
            }
            if let route = onPurchaseResume {
                // Same routing as a fresh tap: the checkout step when it
                // applies, Apple otherwise. `pkg` above is resolved only to
                // prove the product is still on offer.
                _ = pkg
                route(productId, context)
            } else {
                Task { await SubscriptionService.shared.purchase(pkg, context: context) }
            }
        case .export, .profileWrite:
            // These resume at their own call sites, which own the work; the
            // gate's job was to guarantee an account exists by the time they
            // run again.
            break
        }
    }
}

/// Whether this install has already been through the first-run funnel.
///
/// KEYED ON THE KEYCHAIN DEVICE ID, NOT ON UserDefaults AND NOT ON IP.
/// UserDefaults is erased with the app, so a reinstall would replay the whole
/// funnel — and under deferred auth that means replaying a PAYWALL at somebody
/// who may already be a subscriber. IP is worse than useless here: it is shared
/// by everyone behind a household router or a carrier NAT, so it would suppress
/// the funnel for people who have never seen it.
///
/// The Keychain item survives app deletion, so the same physical device gets one
/// first run. It does NOT survive a device erase or a restore to new hardware —
/// the same honest limit `device_id` carries, and the right side to fail on:
/// showing the funnel again to a genuinely new device is a small cost, showing
/// it on every reinstall is a broken product.
enum FirstRun {
    private static var key: String { "first_run_seen_" + Analytics.deviceIdForJoin }

    static var seen: Bool { Keychain.get(key) == "1" }

    static func markSeen() {
        guard !seen else { return }
        let ok = Keychain.set("1", for: key)
        if !ok {
            // A silent failure here means the funnel repeats on every launch.
            // Durable, because the event that reports it would otherwise be
            // dropped by the same install it is describing.
            Analytics.track("first_run_keychain_write_failed", props: [:], durable: true)
        }
    }

    #if DEBUG
    static func reset() { _ = Keychain.delete(key) }
    #endif
}

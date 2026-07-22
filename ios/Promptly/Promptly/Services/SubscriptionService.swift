import Foundation
import SwiftUI
import RevenueCat
import UserNotifications

/// Single source of truth for Pro entitlement on the client.
///
/// Boots RevenueCat with our public iOS SDK key, identifies the user with
/// their Supabase user.id (so RevenueCat's webhook can write back to the
/// right profiles row server-side), and exposes `@Published isPro` for
/// SwiftUI gating.
///
/// Pro entitlement source order:
///   1. RevenueCat's local CustomerInfo cache (instant, offline-tolerant)
///   2. Server `/api/usage` (authoritative — checks profiles.pro_until)
///
/// We trust RevenueCat for the UI-blocking decision (paywall vs. unlocked)
/// and treat server as the gate that actually allows the action — that way
/// a user who buys Pro sees the UI unlock instantly while the server's
/// 402 check waits for the webhook to land (~seconds).
@MainActor
final class SubscriptionService: ObservableObject {
    static let shared = SubscriptionService()

    /// PASTE THE PUBLIC IOS SDK KEY FROM REVENUECAT DASHBOARD HERE.
    /// Looks like `appl_XXXXXXXXXXXXXXXXXX`. Without this, RevenueCat
    /// will not initialize and all users appear as free-tier.
    private let revenueCatPublicKey = "appl_EsLGLEDGZCJerQFCJCEgHnRrSsP"

    /// Entitlement identifier configured in RevenueCat dashboard
    /// (Entitlements → "pro"). Must match exactly — case-sensitive.
    static let proEntitlementId = "pro"

    /// Offering identifier in RevenueCat dashboard. "default" is the
    /// out-of-the-box current offering; rename here if you change it.
    static let defaultOfferingId = "default"

    @Published var isPro: Bool = false

    /// THE source-of-truth Pro flag for every iOS gate that needs one.
    /// Returns true if EITHER RevenueCat's client cache (`isPro`) OR the
    /// server's `/api/usage` snapshot (`UsageService.shared.isPro`) says
    /// the user is Pro. Catches two real cases:
    ///   - **Server-comped users** (manual SQL update to profiles.tier='pro')
    ///     — no RevenueCat transaction exists, so SubscriptionService.isPro
    ///     stays false. UsageService catches it.
    ///   - **RevenueCat webhook drift** — RevenueCat fired INITIAL_PURCHASE
    ///     locally but the webhook hasn't synced profiles.tier yet, or
    ///     vice versa. Whichever signal is ahead wins.
    /// All UI gates (paywall pops, picker caps, re-edit affordance,
    /// Pro badges) should read this, not the raw `isPro`. The raw
    /// signal stays available for purchase-flow logic that genuinely
    /// needs to know what RevenueCat itself thinks.
    var effectiveIsPro: Bool {
        isPro || UsageService.shared.isPro
    }

    /// The wall tier the client should act on: RevenueCat's view composed with
    /// the server-derived tier, most-privileged wins (EntitlementTier.resolve —
    /// mirrors the server's tierFromEntitlement rule). RC knows trial-vs-paid
    /// from the entitlement period; the server knows comp/self-heal grants.
    /// `.none` is the wall; `.trial` is limited; `.paid` is unlimited.
    var effectiveTier: EntitlementTier {
        let rc: EntitlementTier = {
            guard isPro else { return .none }
            // RC period type: an active trial entitlement is .trial, else .paid.
            if let ent = lastCustomerInfo?.entitlements[Self.proEntitlementId],
               ent.periodType == .trial { return .trial }
            return .paid
        }()
        let server = EntitlementTier.fromServer(UsageService.shared.snapshot?.tier)
        return EntitlementTier.resolve(rc: rc, server: server)
    }
    @Published var offerings: Offerings?
    @Published var isLoadingPurchase: Bool = false
    @Published var lastError: String?

    /// Offerings load-state for the paywall. `isLoadingOfferings` is true only
    /// while a fetch is in flight; when it settles false, either
    /// `currentPackages` has options OR `offeringsError` is set. This is what
    /// lets the paywall show a real error+Retry instead of an infinite spinner
    /// when offerings come back empty or the fetch throws.
    @Published var isLoadingOfferings: Bool = false
    @Published var offeringsError: String?

    /// Post-purchase confirmation payload (trust-package Fix 3). Set on a
    /// successful purchase/trial so PaywallView can show a real confirmation
    /// screen — the trial-end date, the exact charge, and (only when true) the
    /// reminder promise — instead of the old silent dismiss.
    @Published var lastConfirmation: PurchaseConfirmation?

    struct PurchaseConfirmation: Equatable {
        let isTrial: Bool
        let price: String
        let trialEnd: Date?
        let reminderScheduled: Bool
    }

    /// Stable id so a re-purchase/renewal replaces rather than stacks reminders.
    static let trialReminderId = "promptly.trial.reminder"

    private var initialized = false

    private init() {}

    /// Boot RevenueCat. Call once from PromptlyApp.init().
    func bootstrap() {
        guard !initialized else { return }
        guard !revenueCatPublicKey.contains("PASTE_YOUR_PUBLIC_KEY") else {
            print("[Subscription] RevenueCat key not configured — Pro features disabled until you set it in SubscriptionService.swift")
            return
        }
        initialized = true
        Purchases.logLevel = .warn
        Purchases.configure(withAPIKey: revenueCatPublicKey)
        Purchases.shared.delegate = SubscriptionDelegate.shared

        // If the user is already signed in, identify them now. Otherwise
        // PromptlyApp will call `identify` after Supabase auth resolves.
        if let uid = AuthService.shared.currentUser?.id {
            Task { await identify(userId: uid) }
        }

        // Fetch offerings so the paywall sheet has package data ready.
        Task { await refreshOfferings() }

        // Initial entitlement snapshot.
        Task { await refreshCustomerInfo() }
    }

    /// Tell RevenueCat which user is signed in. Aliases their anonymous
    /// install ID to the Supabase user.id so cross-device + webhook
    /// targeting both work.
    func identify(userId: String) async {
        guard initialized else { return }
        do {
            _ = try await Purchases.shared.logIn(userId)
            await refreshCustomerInfo()
        } catch {
            print("[Subscription] logIn failed: \(error.localizedDescription)")
        }
    }

    /// Called from sign-out flow.
    func clearIdentity() async {
        guard initialized else { return }
        do {
            _ = try await Purchases.shared.logOut()
            isPro = false
        } catch {
            // logOut throws if user is already anonymous — safe to ignore.
        }
    }

    /// Refresh the local CustomerInfo. RevenueCat caches this, so it's
    /// cheap to call after foreground or after a purchase event.
    func refreshCustomerInfo() async {
        guard initialized else { return }
        do {
            let info = try await Purchases.shared.customerInfo()
            applyCustomerInfo(info)
        } catch {
            print("[Subscription] customerInfo failed: \(error.localizedDescription)")
        }
    }

    /// Pull the current offering (monthly + yearly packages) for the paywall.
    ///
    /// The single point of failure for all revenue does not get to fail
    /// invisibly. This tracks load-state so the paywall can render a real
    /// error+Retry (never an infinite spinner), logs any failure properly
    /// (not print-swallowed), and emits the funnel events:
    ///   - `offerings_loaded {count}` on every successful fetch
    ///   - `offerings_load_failed` when the fetch throws OR returns zero
    ///     packages (a zero-package result almost always means the products
    ///     aren't published/priced for this storefront — the India hypothesis).
    func refreshOfferings() async {
        guard initialized else { return }
        isLoadingOfferings = true
        offeringsError = nil
        defer { isLoadingOfferings = false }
        do {
            let result = try await Purchases.shared.offerings()
            self.offerings = result
            let offering = result.current ?? result[Self.defaultOfferingId]
            let count = offering?.availablePackages.count ?? 0
            Analytics.track("offerings_loaded", props: ["count": count])
            if count == 0 {
                // Fetch succeeded but there is nothing to sell here. Surface it
                // as a visible failure state, not a spinner, and flag it as a
                // load failure so it shows up in the funnel.
                offeringsError = "Subscriptions aren't available in your region yet. Please try again later."
                Analytics.track("offerings_load_failed", props: ["reason": "empty", "count": 0])
                NSLog("[Subscription] offerings loaded but EMPTY (0 packages) — check App Store product availability/pricing for this storefront")
            }
        } catch {
            let ns = error as NSError
            offeringsError = "We couldn't load subscription options. Please check your connection and try again."
            Analytics.track("offerings_load_failed", props: [
                "reason": "fetch_error",
                "code": ns.code,
                "domain": ns.domain,
                "message": error.localizedDescription,
            ])
            NSLog("[Subscription] offerings fetch FAILED: %@ (domain=%@ code=%ld)",
                  error.localizedDescription, ns.domain, ns.code)
        }
    }

    /// Purchase a package. Called from PaywallView.
    /// Returns true on success (entitlement granted), false otherwise.
    /// Sets `lastError` for the UI to surface on cancellation / failure.
    /// Funnel plan key: weekly / monthly / yearly (from the package type).
    func planKey(_ pkg: Package) -> String {
        switch pkg.packageType {
        case .annual: return "yearly"
        case .monthly: return "monthly"
        case .weekly: return "weekly"
        default: return "other"
        }
    }

    @discardableResult
    func purchase(_ package: Package) async -> Bool {
        guard initialized else { return false }
        isLoadingPurchase = true
        defer { isLoadingPurchase = false }
        let plan = planKey(package)
        // FREEMIUM upgrade funnel — the central purchase path (fires for BOTH
        // paywalls). No trial anymore, so no trial_start / trial reminder.
        Analytics.track("purchase_started", props: [
            "plan": plan,
            "product": package.storeProduct.productIdentifier,
        ])
        do {
            let result = try await Purchases.shared.purchase(package: package)
            applyCustomerInfo(result.customerInfo)
            if !result.userCancelled {
                lastError = nil
                let priceString = package.storeProduct.localizedPriceString
                Analytics.track("purchase_completed", props: [
                    "plan": plan,
                    "product": package.storeProduct.productIdentifier,
                ])
                if isPro { Analytics.setTier("pro") } // super-property flips free → pro
                // Feed the confirmation screen with the concrete charge (no trial).
                lastConfirmation = PurchaseConfirmation(
                    isTrial: false,
                    price: priceString,
                    trialEnd: nil,
                    reminderScheduled: false
                )
                // Reconcile with the server immediately so the render gate
                // (which trusts ONLY the server, not RevenueCat's client
                // cache) unlocks without waiting for the webhook to land.
                if isPro { await syncEntitlementWithServer() }
            } else {
                // Cancel that surfaces as a flag rather than a thrown error.
                // Fire the terminal here so purchase_started ALWAYS pairs with
                // exactly one purchase_completed/purchase_failed (clean funnel).
                Analytics.track("purchase_failed", props: [
                    "plan": plan,
                    "billing_error": "user_cancelled",
                    "cancelled": true,
                    "product": package.storeProduct.productIdentifier,
                ])
            }
            return isPro
        } catch {
            let nsErr = error as NSError
            let cancelled = nsErr.code == ErrorCode.purchaseCancelledError.rawValue
            // purchase_failed makes billing declines VISIBLE as analytics, not a
            // mystery. `cancelled` separates a user-cancel from a real decline.
            Analytics.track("purchase_failed", props: [
                "plan": plan,
                "billing_error": "\(nsErr.domain)#\(nsErr.code)",
                "cancelled": cancelled,
                "product": package.storeProduct.productIdentifier,
            ])
            // Skip noisy alerts on user-cancel.
            if !cancelled {
                lastError = error.localizedDescription
                print("[Subscription] purchase failed: \(error.localizedDescription)")
            }
            return false
        }
    }

    /// Restore prior purchases (App Store receipt). Required by App Review.
    @discardableResult
    func restorePurchases() async -> Bool {
        guard initialized else { return false }
        isLoadingPurchase = true
        defer { isLoadingPurchase = false }
        do {
            let info = try await Purchases.shared.restorePurchases()
            applyCustomerInfo(info)
            if isPro {
                Analytics.setTier("pro") // super-property flips free → pro
                await syncEntitlementWithServer()
            }
            return isPro
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    /// Reconcile Pro entitlement with the server SYNCHRONOUSLY after a
    /// purchase or restore. The RevenueCat webhook is the primary activation
    /// path, but it's asynchronous and can lag or fail — this POSTs to
    /// `/api/revenuecat/sync`, which verifies the entitlement against
    /// RevenueCat's REST API and flips `profiles.tier='pro'` on the spot, so
    /// the server-side render gate unlocks right away.
    ///
    /// Best-effort: any failure (offline, key not configured, RC blip) is
    /// swallowed — the webhook plus the `effectiveIsPro` client signal keep
    /// the UI unlocked regardless. Always refreshes `UsageService` afterward
    /// so the server's view is reflected once the write lands.
    func syncEntitlementWithServer() async {
        if let token = await AuthService.shared.getValidToken(),
           let url = URL(string: "https://usepromptly.app/api/revenuecat/sync") {
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.timeoutInterval = 12
            do {
                let (_, response) = try await URLSession.shared.data(for: request)
                if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                    print("[Subscription] server sync returned \(http.statusCode)")
                }
            } catch {
                print("[Subscription] server sync failed: \(error.localizedDescription)")
            }
        }
        // Reflect the server's (now-updated) entitlement regardless of the
        // sync call's outcome.
        await UsageService.shared.refresh()
    }

    /// Schedule the local trial-end reminder ~24h before expiry so the paywall's
    /// "we'll remind you before your trial ends" promise is backed by a real
    /// mechanism — the single best-documented reducer of instant renewal opt-outs.
    ///
    /// Best-effort and permission-aware. Returns false (and the confirmation copy
    /// softens to a "turn on notifications" nudge) when we can't deliver: the
    /// trial is too short to leave a 24h lead, or notifications are denied. If
    /// permission is undetermined we ask now — trial start is the honest,
    /// high-intent moment to request it.
    ///
    /// NOTE ON THE PROMISE: a local notification only fires if the app remains
    /// installed and notifications stay enabled. The durable fallback — a
    /// server-side email off the existing RevenueCat trial-start webhook — is
    /// proposed separately; it is not built here.
    func scheduleTrialReminder(trialEnd: Date?, price: String) async -> Bool {
        guard let trialEnd,
              let fireDate = TrialCopy.reminderFireDate(trialEnd: trialEnd, now: Date()) else {
            return false
        }
        let center = UNUserNotificationCenter.current()
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            break
        case .notDetermined:
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
            if !granted { return false }
        case .denied:
            return false
        @unknown default:
            return false
        }

        let content = UNMutableNotificationContent()
        content.title = TrialCopy.reminderTitle
        content.body = TrialCopy.reminderBody(price: price)
        content.sound = .default

        let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: fireDate)
        let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
        let request = UNNotificationRequest(identifier: Self.trialReminderId, content: content, trigger: trigger)
        // Clear any prior reminder first so a renewal/re-purchase replaces it.
        center.removePendingNotificationRequests(withIdentifiers: [Self.trialReminderId])
        do {
            try await center.add(request)
            return true
        } catch {
            print("[Subscription] trial reminder scheduling failed: \(error.localizedDescription)")
            return false
        }
    }

    // MARK: - Internal

    /// The latest CustomerInfo, stored so `effectiveTier` can read the
    /// entitlement's period type (trial vs paid) without an async fetch.
    private(set) var lastCustomerInfo: CustomerInfo?

    fileprivate func applyCustomerInfo(_ info: CustomerInfo) {
        lastCustomerInfo = info
        let entitled = info.entitlements[Self.proEntitlementId]?.isActive == true
        if entitled != isPro {
            isPro = entitled
        }
        // Self-heal divergence: RevenueCat says Pro but the server profile
        // hasn't caught up (webhook lag/failure, restore on a fresh install,
        // a cross-device renewal). The server is the authoritative render
        // gate, so reconcile it now instead of waiting for the user's next
        // purchase. Fires only while diverged and is overlap-guarded, so it
        // can't spam: once the server reflects Pro, UsageService.isPro flips
        // true and this stops triggering.
        if entitled && !UsageService.shared.isPro {
            reconcileEntitlementIfNeeded()
        }
    }

    private var isReconciling = false

    /// Best-effort, debounced server reconciliation. Safe to call from any
    /// customerInfo update (launch, identify, delegate renewal).
    private func reconcileEntitlementIfNeeded() {
        guard !isReconciling else { return }
        isReconciling = true
        Task { @MainActor in
            await syncEntitlementWithServer()
            isReconciling = false
        }
    }
}

// MARK: - Delegate
//
// RevenueCat's delegate fires whenever CustomerInfo updates (renewal,
// expiration, cross-device sync). We just forward the new info to the
// service so @Published isPro stays in sync without polling.

final class SubscriptionDelegate: NSObject, PurchasesDelegate {
    static let shared = SubscriptionDelegate()

    func purchases(_ purchases: Purchases, receivedUpdated customerInfo: CustomerInfo) {
        Task { @MainActor in
            SubscriptionService.shared.applyCustomerInfo(customerInfo)
        }
    }
}

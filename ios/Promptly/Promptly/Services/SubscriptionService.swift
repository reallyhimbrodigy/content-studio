import Foundation
import SwiftUI
import RevenueCat

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
    @Published var offerings: Offerings?
    @Published var isLoadingPurchase: Bool = false
    @Published var lastError: String?

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
    func refreshOfferings() async {
        guard initialized else { return }
        do {
            let result = try await Purchases.shared.offerings()
            self.offerings = result
        } catch {
            print("[Subscription] offerings failed: \(error.localizedDescription)")
        }
    }

    /// Purchase a package. Called from PaywallView.
    /// Returns true on success (entitlement granted), false otherwise.
    /// Sets `lastError` for the UI to surface on cancellation / failure.
    @discardableResult
    func purchase(_ package: Package) async -> Bool {
        guard initialized else { return false }
        isLoadingPurchase = true
        defer { isLoadingPurchase = false }
        do {
            let result = try await Purchases.shared.purchase(package: package)
            applyCustomerInfo(result.customerInfo)
            if !result.userCancelled {
                lastError = nil
                // Reconcile with the server immediately so the render gate
                // (which trusts ONLY the server, not RevenueCat's client
                // cache) unlocks without waiting for the webhook to land.
                if isPro { await syncEntitlementWithServer() }
            }
            return isPro
        } catch {
            // Skip noisy alerts on user-cancel.
            let nsErr = error as NSError
            if nsErr.code != ErrorCode.purchaseCancelledError.rawValue {
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
            if isPro { await syncEntitlementWithServer() }
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

    // MARK: - Internal

    fileprivate func applyCustomerInfo(_ info: CustomerInfo) {
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

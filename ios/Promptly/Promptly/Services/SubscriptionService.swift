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
            return isPro
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    // MARK: - Internal

    fileprivate func applyCustomerInfo(_ info: CustomerInfo) {
        let entitled = info.entitlements[Self.proEntitlementId]?.isActive == true
        if entitled != isPro {
            isPro = entitled
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

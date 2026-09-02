import Foundation
import SwiftUI
import RevenueCat
import StoreKit

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
    /// The Max entitlement, configured alongside `pro` in RevenueCat. A Max
    /// subscriber holds BOTH — `pro` is what gates features, `max` is what
    /// identifies the tier.
    static let maxEntitlementId = "max"

    /// Offering identifier in RevenueCat dashboard. "default" is the
    /// out-of-the-box current offering; rename here if you change it.
    static let defaultOfferingId = "default"

    @Published var isPro: Bool = false
    /// Whether the user holds the Max entitlement.
    ///
    /// Published, not computed off `lastCustomerInfo`, because SwiftUI cannot
    /// observe a plain stored property — a view reading a computed `hasMax`
    /// would render once with the pre-fetch value and never update when the
    /// entitlement arrived. That is the failure mode where a surface is
    /// "hidden for Max users" everywhere except on the launch that matters.
    @Published private(set) var isMax: Bool = false

    /// Whether RevenueCat has answered about this device even once.
    ///
    /// Entitlements come from the App Store receipt, so an existing subscriber
    /// on a NEW device is Pro before they sign in — RevenueCat just has not said
    /// so yet at launch. Deciding to show a first-run paywall while this is
    /// false means deciding on an unread value, and the answer arrives a moment
    /// later: the paywall flashes at somebody who already pays. Nil-until-known
    /// is the same rule the credit balance follows, for the same reason.
    @Published private(set) var hasResolvedCustomerInfo = false

    #if DEBUG
    /// Sim-proof harness only: pose the Max entitlement so a capture can show
    /// what a Max subscriber actually sees. DEBUG, and never called from app
    /// code — the real value comes from RevenueCat in `applyCustomerInfo`.
    /// Idempotent, and that is not a nicety. `@Published` fires on every
    /// assignment, equal or not, and SwiftUI re-runs a View's `init` on each
    /// update — so an unconditional set here became set -> publish -> update ->
    /// set, a render loop that never settled. The harness caught it by refusing
    /// to screenshot an unsettled screen; the production path has always
    /// guarded the same way in `applyCustomerInfo`.
    func debugSetMax(_ v: Bool) { if isMax != v { isMax = v } }
    #endif

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

    /// INTRO-OFFER ELIGIBILITY, per product, for THIS Apple ID.
    ///
    /// `storeProduct.introductoryDiscount` describes the PRODUCT's offer. It says
    /// nothing about whether this user may receive it. Apple allows one intro
    /// offer per Apple ID per subscription group, for ever — so a returning user
    /// who already used theirs is charged FULL PRICE at the sheet no matter what
    /// we render. Reading the product alone means showing "50% off · $145.99" to
    /// someone Apple will charge $289.99: a false money claim on the money
    /// surface, which is the exact class the percentage gate exists to prevent.
    ///
    /// Keyed by productIdentifier. Absent = not yet fetched, which is treated as
    /// INELIGIBLE by `isEligibleForIntro` — fail closed, never claim on unknown.
    @Published private(set) var introEligibility: [String: Bool] = [:]

    /// True only when RevenueCat has affirmatively said this Apple ID may
    /// receive the product's introductory offer.
    ///
    /// Deliberately fails CLOSED: unknown, unfetched, and error all return
    /// false. Under-promising costs a discount we could have shown; over-
    /// promising charges someone double what the screen said.
    func isEligibleForIntro(_ product: StoreProduct) -> Bool {
        introEligibility[product.productIdentifier] == true
    }

    /// Fetch eligibility for every product in the current offering. Cheap, and
    /// it must complete before any discount claim renders.
    func refreshIntroEligibility() async {
        guard initialized else { return }
        let ids = (offerings?.current?.availablePackages ?? []).map { $0.storeProduct.productIdentifier }
        guard !ids.isEmpty else { return }
        let result = await Purchases.shared.checkTrialOrIntroDiscountEligibility(productIdentifiers: ids)
        var map: [String: Bool] = [:]
        for (pid, elig) in result {
            // `.eligible` ONLY. `.unknown` and `.noIntroOfferExists` are not a
            // licence to claim a discount.
            map[pid] = (elig.status == .eligible)
        }
        introEligibility = map
        let n = map.values.filter { $0 }.count
        Analytics.track("intro_eligibility_checked", props: ["eligible": n, "checked": map.count])
    }

    /// Post-purchase confirmation payload. Set on a successful purchase so the
    /// paywall shows a real confirmation screen (the exact recurring charge)
    /// instead of the old silent dismiss. FREEMIUM — no trial, just the price.
    @Published var lastConfirmation: PurchaseConfirmation?

    struct PurchaseConfirmation: Equatable {
        let price: String
    }

    private var initialized = false

    /// Whether RevenueCat's current app_user_id is aliased to the signed-in
    /// Supabase user. A purchase made while this is false lands under an
    /// anonymous RC id, and the webhook then has NO profile to write to — the
    /// most likely reason the 2026-07-26 sandbox purchase left no server record.
    /// The purchase/restore paths await `ensureIdentified()` so it can't happen.
    @Published private(set) var isIdentified = false
    private var identifiedUserId: String?

    private init() {}

    /// Boot RevenueCat. Call once from PromptlyApp.init().
    func bootstrap() {
        Self.refreshStorefrontCache()
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

    /// Tell RevenueCat which user is signed in. Aliases their anonymous install
    /// ID to the Supabase user.id so cross-device + webhook targeting both work.
    ///
    /// Returns true once RC's appUserID equals `userId`. A swallowed logIn
    /// failure here silently breaks EVERY future purchase's server-side write
    /// (the webhook can't map an anonymous id to a profile), so a transient
    /// failure is retried and a hard failure is surfaced to analytics rather
    /// than print-swallowed.
    @discardableResult
    func identify(userId: String) async -> Bool {
        guard initialized else { return false }
        // Already aliased to this user — avoid a redundant logIn on every
        // foreground/bootstrap while still confirming RC agrees.
        if identifiedUserId == userId, Purchases.shared.appUserID == userId {
            isIdentified = true
            return true
        }
        for attempt in 1...3 {
            do {
                _ = try await Purchases.shared.logIn(userId)
                await refreshCustomerInfo()
                if Purchases.shared.appUserID == userId {
                    identifiedUserId = userId
                    isIdentified = true
                    return true
                }
                // logIn returned but RC's id didn't become ours — don't let a
                // purchase proceed under the wrong id; treat as a retryable miss.
                Analytics.track("rc_identify_mismatch", props: ["attempt": attempt])
            } catch {
                print("[Subscription] logIn failed (attempt \(attempt)/3): \(error.localizedDescription)")
                if attempt == 3 {
                    // Hard failure — VISIBLE, not a lone print. This user's
                    // purchases can't be attributed server-side until it clears.
                    Analytics.track("rc_identify_failed", props: [
                        "message": error.localizedDescription,
                        "attempts": attempt,
                    ])
                }
            }
            if attempt < 3 { try? await Task.sleep(for: .milliseconds(400 * attempt)) }
        }
        isIdentified = false
        return false
    }

    /// Guarantee RC is aliased to the signed-in Supabase user before a money
    /// action. Returns false ONLY when there's a signed-in user we couldn't
    /// alias RC to — in which case the caller must NOT purchase (the webhook
    /// would have no profile to write). No signed-in user → true (nothing to
    /// align; RC's anonymous id is correct by design).
    func ensureIdentified() async -> Bool {
        guard initialized else { return false }
        guard let uid = AuthService.shared.currentUser?.id else { return true }
        if Purchases.shared.appUserID == uid { isIdentified = true; return true }
        return await identify(userId: uid)
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
            // Eligibility rides the same load: a discount claim must never be
            // able to render before we know whether this Apple ID can have it.
            await refreshIntroEligibility()
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

    /// Purchase a package. Called from every purchase surface.
    /// Returns true on success (entitlement granted), false otherwise.
    /// Sets `lastError` for the UI to surface on cancellation / failure.
    /// Funnel plan key: weekly / monthly / yearly (from the package type).
    /// `context` names the SURFACE that initiated the buy (PaywallView's
    /// reasonKey / TrialWallView's contextKey / "first_launch") and is stamped
    /// on the purchase_* terminals so the funnel can attribute every buy to
    /// its trigger without a join back to upgrade_wall_viewed. Defaulted so
    /// call sites that predate the stamp still compile (and land unstamped).
    /// Canonical package order for EVERY purchase surface: duration
    /// DESCENDING (Annual → Monthly → Weekly, unknowns last). Ruled
    /// 2026-08-26 after the identifier check: our packages use the standard
    /// $rc_ types (plan props resolve to yearly/monthly/weekly, zero
    /// "other"), but availablePackages returns the offering's ATTACHMENT
    /// order — RC returned weekly first, and every surface pins both the
    /// pre-selection and the BEST VALUE badge to `.first`. Sorting client-
    /// side removes the dashboard-order dependency entirely; the yearly
    /// anchor ($33.33/mo) plus this ordering is the whole reorder ask.
    /// SYNC-readable storefront snapshot for funnel props (the coordinator's
    /// "three queries instead of one": plan_selected and upgrade_wall_viewed
    /// rows lacked storefront while purchase_* carried it — every funnel row
    /// must be self-contained). Populated at bootstrap; best-effort static,
    /// same doctrine as ReachabilityMonitor's conn snapshot.
    nonisolated(unsafe) private(set) static var cachedStorefrontProps: [String: Any] = [:]
    static func refreshStorefrontCache() {
        Task {
            if let sf = await Storefront.current {
                cachedStorefrontProps = ["storefront": sf.countryCode, "storefront_id": sf.id]
            }
        }
    }

    /// TIER FIRST, THEN DURATION. Max sits above Pro, which duration alone
    /// cannot express — a Max monthly and a Pro monthly are the same
    /// PackageType, so the old comparator interleaved them by whatever order
    /// the offering happened to return.
    ///
    /// The tier is derived from the ALLOWANCE the product maps to, not from a
    /// hardcoded product id: `promptly_max_monthly` sorts above Pro because
    /// CreditAllowance says it is worth 1000 credits, and any future tier
    /// configured in the dashboard sorts itself. Nothing here needs to know
    /// that "max" exists.
    ///
    /// Products with no known allowance rank last among tiers rather than
    /// first — an unrecognised product should not lead the paywall.
    static func sortedByDuration(_ packages: [Package]) -> [Package] {
        func tierRank(_ p: Package) -> Int {
            guard let m = CreditAllowance.monthly(forProductId: p.storeProduct.productIdentifier)
            else { return Int.max }
            return -m   // higher allowance sorts first
        }
        func rank(_ t: PackageType) -> Int {
            switch t {
            case .lifetime: return 0
            case .annual: return 1
            case .sixMonth: return 2
            case .threeMonth: return 3
            case .twoMonth: return 4
            case .monthly: return 5
            case .weekly: return 6
            default: return 7
            }
        }
        return packages.enumerated()
            .sorted {
                (tierRank($0.element), rank($0.element.packageType), $0.offset)
                    < (tierRank($1.element), rank($1.element.packageType), $1.offset)
            }
            .map(\.element)
    }

    func planKey(_ pkg: Package) -> String {
        switch pkg.packageType {
        case .annual: return "yearly"
        case .monthly: return "monthly"
        case .weekly: return "weekly"
        default: return "other"
        }
    }

    @discardableResult
    func purchase(_ package: Package, context: String? = nil) async -> Bool {
        guard initialized else { return false }
        // NO PURCHASE WITHOUT AN ACCOUNT. NON-NEGOTIABLE, AND NOT FLAG-GATED.
        //
        // This guard used to read `if currentUser != nil { ensureIdentified() }`
        // — it enforced aliasing for a signed-IN user and did nothing at all for
        // a signed-out one. That hole was harmless only because the paywall was
        // unreachable before signup; restoring the pre-auth funnel makes it
        // live, and an anonymous purchase lands on $RCAnonymousID where it
        // cannot be attributed or reliably aliased (the no_profile_matched
        // failure the 1.3.20 ordering fix exists for). Browsing moves before
        // auth; the TRANSACTION does not.
        //
        // Inverted to a hard `guard`, so a signed-out caller is refused rather
        // than falling through. The refusal records what the user was trying to
        // buy so sign-in can resume it instead of dropping them at the start.
        guard AuthService.shared.currentUser?.id != nil else {
            var props: [String: Any] = [
                "plan": planKey(package),
                "product": package.storeProduct.productIdentifier,
            ]
            if let context { props["context"] = context }
            Analytics.track("purchase_blocked_unauthenticated", props: props, durable: true)
            AuthGate.shared.require(
                .purchase(productId: package.storeProduct.productIdentifier,
                          context: context ?? "paywall"))
            return false
        }
        // With a signed-in user, RC must be aliased to them FIRST — else the
        // webhook fires with an app_user_id that matches no profile and the paid
        // entitlement is never written server-side (the device shows Pro; the
        // server never learns). A pre-purchase await closes that race.
        let ok = await ensureIdentified()
        if !ok {
            lastError = "We couldn't verify your account. Please try again in a moment."
            var blockedProps: [String: Any] = [
                "plan": planKey(package),
                "product": package.storeProduct.productIdentifier,
            ]
            if let context { blockedProps["context"] = context }
            Analytics.track("purchase_blocked_unidentified", props: blockedProps)
            return false
        }
        isLoadingPurchase = true
        defer { isLoadingPurchase = false }
        let plan = planKey(package)
        // Storefront on the funnel (ruled 2026-08-25): the envelope's territory
        // made the first geography cut possible, but the purchase rows must be
        // SELF-CONTAINED — storefront + currency + price let the per-storefront
        // pricing read run without an envelope join, and currency/price are the
        // pricing-project's raw material (IND: 0/155 Hindi buyers at parity
        // quality — the problem is the price sheet, so measure the price sheet).
        var sfProps: [String: Any] = [
            "plan": plan,
            "product": package.storeProduct.productIdentifier,
            "currency": package.storeProduct.currencyCode ?? "",
            "price": "\(package.storeProduct.price)",
        ]
        // Surface stamp: rides sfProps so purchase_started AND both terminals
        // (purchase_completed / purchase_failed) carry the same context.
        if let context { sfProps["context"] = context }
        if let sf = await Storefront.current {
            sfProps["storefront"] = sf.countryCode
            sfProps["storefront_id"] = sf.id
        }
        Analytics.track("purchase_started", props: sfProps)
        do {
            let result = try await Purchases.shared.purchase(package: package)
            applyCustomerInfo(result.customerInfo)
            if !result.userCancelled {
                lastError = nil
                let priceString = package.storeProduct.localizedPriceString
                Analytics.track("purchase_completed", props: sfProps)
                if isPro { Analytics.setTier("pro") } // super-property flips free → pro
                // Feed the confirmation screen with the concrete charge (no trial).
                lastConfirmation = PurchaseConfirmation(price: priceString)
                // Reconcile with the server immediately so the render gate
                // (which trusts ONLY the server, not RevenueCat's client
                // cache) unlocks without waiting for the webhook to land.
                if isPro { await syncEntitlementWithServer() }
            } else {
                // Cancel that surfaces as a flag rather than a thrown error.
                // Fire the terminal here so purchase_started ALWAYS pairs with
                // exactly one purchase_completed/purchase_failed (clean funnel).
                Analytics.track("purchase_failed", props: sfProps.merging(
                    ["billing_error": "user_cancelled", "cancelled": true]) { _, new in new })
            }
            return isPro
        } catch {
            let nsErr = error as NSError
            let cancelled = nsErr.code == ErrorCode.purchaseCancelledError.rawValue
            // purchase_failed makes billing declines VISIBLE as analytics, not a
            // mystery. `cancelled` separates a user-cancel from a real decline.
            Analytics.track("purchase_failed", props: sfProps.merging(
                ["billing_error": "\(nsErr.domain)#\(nsErr.code)", "cancelled": cancelled]) { _, new in new })
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
        // Align RC to the signed-in user first so a restore re-attributes the
        // entitlement to THIS account (and the server sync writes the right row).
        if AuthService.shared.currentUser?.id != nil { _ = await ensureIdentified() }
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

    // MARK: - Internal

    /// The latest CustomerInfo, stored so `effectiveTier` can read the
    /// entitlement's period type (trial vs paid) without an async fetch.
    private(set) var lastCustomerInfo: CustomerInfo?

    fileprivate func applyCustomerInfo(_ info: CustomerInfo) {
        lastCustomerInfo = info
        if !hasResolvedCustomerInfo { hasResolvedCustomerInfo = true }
        let entitled = info.entitlements[Self.proEntitlementId]?.isActive == true
        if entitled != isPro {
            isPro = entitled
        }
        let maxEntitled = info.entitlements[Self.maxEntitlementId]?.isActive == true
        if maxEntitled != isMax {
            isMax = maxEntitled
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

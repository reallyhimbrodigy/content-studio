import SwiftUI
import RevenueCat

/// Conversion workstream item 1 — the FIRST-LAUNCH paywall.
///
/// Shown once, on first launch, BEFORE signup/onboarding, and always
/// dismissible (the X is never hidden). The mechanism (from the captions.ai
/// teardown): a dismissible wall costs nothing and takes paid-tier exposure
/// from ~7% to 100% — every user learns a paid tier exists in the first
/// seconds. Measured evidence says wall exposure correlates with HIGHER
/// pick-rates, so the success metrics are wall-views, dismiss rate, pick-rate
/// movement, and conversion per SKU — all against wall-views on the auth UUID.
///
/// Pre-auth purchase is architecturally allowed: RevenueCat runs under an
/// anonymous appUserID which aliases to the Supabase user at sign-in
/// (identify()); purchases are only ever blocked for a signed-in user who
/// cannot be aliased (billing-identity hardening). So the CTA can sell before
/// signup, and attribution merges later.
///
/// SKU presentation (ruled 2026-08-21): packages render in the OFFERING's own
/// order — annual first & pre-selected, weekly second, configured in the
/// RevenueCat dashboard, never hardcoded (reversing the order is a dashboard
/// change, not a build). Both SKUs read in weekly terms: the weekly SKU's
/// price line is per-week already; the annual row carries the per-week anchor.
///
/// Gated by /api/health.first_launch_paywall ("on"), cached, default OFF —
/// the wall ships dark and cannot brick a launch on a config fetch.
struct FirstLaunchPaywallView: View {
    @ObservedObject private var subscription = SubscriptionService.shared
    @ObservedObject private var onboarding = OnboardingState.shared

    /// Set when this screen is a BEAT inside OnboardingV2Flow rather than a
    /// root branch. Nil for the legacy root presentation (v2 off), where
    /// setting `hasSeenFirstLaunchPaywall` is enough for the root to fall
    /// through on its own.
    var onFinished: (() -> Void)?

    @State private var selectedPackage: Package?
    @State private var isPurchasing = false
    @State private var didPurchaseHere = false

    /// THE MAX GATE APPLIES HERE TOO, and this screen was the hole in it.
    ///
    /// 74c5597 dropped Max "at the SOURCE in `tierOptions`, not filtered in the
    /// view, so it cannot leak into the toggle, the CTA, or a percentage
    /// computed across tiers." True of the two-step paywall, and this screen
    /// never calls `tierOptions` — it reads `availablePackages` raw. So on a
    /// real fresh install the FIRST screen of the app listed four plans, Max
    /// among them, with **Max Yearly $799.99 preselected and badged BEST
    /// VALUE** — a product in MISSING_METADATA that nobody can buy. Confirmed
    /// on an erased device against live flags, not reasoned about.
    ///
    /// Worse than showing it: `packages.first` is also written to
    /// `preselectedPlanID`, so the unbuyable SKU was the default purchase
    /// intent carried into the rest of the funnel.
    ///
    /// Filtered at the SOURCE for the same reason 74c5597 gave — selection, the
    /// CTA and `preselectedPlanID` all read this property, so gating it here
    /// reaches every one of them.
    ///
    /// Mirrors `tierOptions(maxEnabled:)`: keep only the LOWEST allowance tier.
    /// A product whose id we cannot price (`nil` allowance) is KEPT — it cannot
    /// be positively identified as the higher tier, and silently hiding an
    /// unrecognised Pro SKU would be a worse failure than the one being fixed.
    /// The Max gate is applied inside `sortedByDuration`, not here. It was here
    /// first, and one screen filtering itself is exactly how this defect
    /// survived: 74c5597 gated Max in `tierOptions`, which this view never
    /// calls, so it listed Max Yearly $799.99 preselected and BEST VALUE.
    /// Fixing it locally would have left the trial wall, the second paywall and
    /// the legacy PaywallView each one edit away from the same leak.
    private var packages: [Package] {
        SubscriptionService.sortedByDuration(subscription.offerings?.current?.availablePackages ?? [])
    }

    #if DEBUG
    private var motionProof: Bool { ProcessInfo.processInfo.arguments.contains("-motionProof") }
    #endif

    var body: some View { proofDriven(realBody) }

    #if DEBUG
    @ViewBuilder private func proofDriven<V: View>(_ v: V) -> some View {
        v.task {
            guard motionProof else { return }
            try? await Task.sleep(nanoseconds: 2_600_000_000)
            finish()   // through the one exit, so the beat advances under -motionProof too
        }
    }
    #else
    @ViewBuilder private func proofDriven<V: View>(_ v: V) -> some View { v }
    #endif

    /// THE SHARED PAYWALL, not a second implementation of one.
    ///
    /// This view owned ~150 lines of its own layout — its own benefit rows, its
    /// own package rows, its own CTA — and that is why the approved design
    /// reached `manual` and never reached `first_launch`: no toggle, no social
    /// proof, no cancel-anytime line, a different headline and a different CTA,
    /// on the SECOND-LARGEST paywall surface in the product (1,393 of 5,563
    /// views, 1,277 users, 13 days to 2026-09-02).
    ///
    /// Everything entry-specific is now a PARAMETER of the shared view: the
    /// headline and the analytics context both derive from `.firstLaunch`
    /// through `PaywallView.title(for:)` and `PaywallView.reasonKey(for:)`. A
    /// design change now lands here and on every other entry at once, which is
    /// the property whose absence produced the drift.
    ///
    /// The binding is write-only on purpose: the host decides what dismissal
    /// MEANS (mark seen, advance the onboarding beat), so `false` routes to
    /// `finish()` rather than to a local `@State` this view would then have to
    /// keep in sync with the flow.
    private var realBody: some View {
        TwoStepPaywall(
            isPresented: Binding(get: { true },
                                 set: { shown in if !shown { finish() } }),
            reason: .firstLaunch
        )
        // NO EMITTER HERE. This view renders TwoStepPaywall, which emits
        // `upgrade_wall_viewed` with this entry's own `reasonKey` — a second
        // emitter would double-count every view on this surface.
    }

    private func finish() {
        withAnimation { onboarding.hasSeenFirstLaunchPaywall = true }
        onFinished?()
    }

    private func openLegal(_ url: String) {
        if let u = URL(string: url) { UIApplication.shared.open(u) }
    }
}

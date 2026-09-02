import SwiftUI
import RevenueCat

/// Conversion item 4 — the SECOND, PERSONALISED paywall. Runs after the three
/// questions + the results wall, before the app. The copy is fed by Q1/Q2 —
/// that is the point of asking them. The third option is the REFERRAL (ruled
/// 2026-08-21: it replaces the first-month discount as the alternative to
/// paying): a day of Pro for each person you invite who finishes a first video,
/// three days plus a bonus at three. Copy lives in ReferralCopy — this file
/// spells none of it. Re-laddered 2026-08-29: the old shape stated a quota of
/// three before the user had shared once, so a first successful invite paid
/// nothing and the loop never taught itself.
///
/// SKU order comes from the RevenueCat OFFERING (annual first + pre-selected,
/// weekly second — dashboard-owned, reversible without a build); both SKUs
/// read in weekly terms. Always leaveable: "Not now" is honest and visible.
struct SecondPaywallView: View {
    /// Called on every exit: purchased, shared, or declined — all land in the app.
    let onDone: () -> Void

    @ObservedObject private var subscription = SubscriptionService.shared
    @ObservedObject private var referrals = ReferralService.shared
    @ObservedObject private var onboarding = OnboardingState.shared

    @State private var selectedPackage: Package?
    @State private var isPurchasing = false
    @State private var didPurchaseHere = false

    private var packages: [Package] {
        SubscriptionService.sortedByDuration(subscription.offerings?.current?.availablePackages ?? [])
    }

    // MARK: Personalised copy (Q1 audience + Q2 intents feed this)

    private var headline: String {
        switch onboarding.intents.first {
        case "viral":       return "Made to go viral"
        case "promo":       return "Sell more with every video"
        case "storytime":   return "Tell stories people finish"
        case "talkinghead": return "Crisp talking-head edits, daily"
        case "highlights":  return "Every highlight, cut for you"
        default:            return "Your editor, on every video"
        }
    }

    private var personalBenefit: String {
        switch onboarding.audience {
        case "clients":  return "Client-ready output, every time"
        case "business": return "On-brand videos without hiring an editor"
        case "creator":  return "Post daily without burning out"
        case "event":    return "Recaps ready before the event ends"
        // The generic fallback is the headline claim itself — taken from the
        // shared source, not respelled. This line was the fourth copy of it.
        default:         return ProBenefits.core[0].text
        }
    }

    /// THE SHARED PAYWALL — see FirstLaunchPaywallView for the full rationale.
    /// Entry copy comes from `.secondPaywall`; the analytics context stays
    /// "post_onboarding".
    ///
    /// REACHABILITY: its only reference is `OnboardingFlow.swift:93`, and that
    /// flow needs `wallOnboardingEnabled == true` while `wall_onboarding` is
    /// absent from /api/health — so this screen is DEAD today. Converted so the
    /// tree holds one paywall design rather than three, not because it ships.
    var body: some View {
        TwoStepPaywall(
            isPresented: Binding(get: { true }, set: { shown in if !shown { onDone() } }),
            reason: .secondPaywall
        )
        .onAppear {
            Analytics.track("upgrade_wall_viewed",
                            props: (["context": "post_onboarding"] as [String: Any])
                                .merging(SubscriptionService.cachedStorefrontProps) { a, _ in a })
        }
    }

}

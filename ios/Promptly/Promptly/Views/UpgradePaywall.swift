import SwiftUI
import RevenueCat

/// The one place that decides WHICH upgrade paywall is shown, and — since
/// 2026-09-02 — what happens when the user tries to LEAVE it.
///
/// There are two presentation sites — the `AppShell` sheet and
/// `AppState.presentPaywallFromTop`'s hosting controller — and a flag honoured
/// at only one of them is worse than a flag honoured at neither: the surface
/// then depends on which code path happened to open it, so a review, a
/// screenshot and a funnel can each be looking at a different screen while all
/// three believe the flag is on. Both sites construct THIS view, so there is a
/// single branch and it cannot drift.
///
/// ── THE DISCOUNT IS NOW EXIT-INTENT ──────────────────────────────────────────
/// The reveal used to be an automatic beat in the onboarding funnel: everyone
/// saw the discount, whether or not they had shown any sign of leaving, and
/// before they had made a single video. It now fires on the way OUT of the
/// paywall — the moment a user who has just hit the credit wall decides not to
/// pay. That is the only moment the discount is answering a question the user
/// has actually asked.
///
/// ONCE, EVER — not on every dismiss. `hasSeenExitOffer` is persisted, so the
/// second and every later dismissal closes immediately. A discount that
/// reappears each time the user closes a screen stops being an offer and
/// becomes a toll gate, and it teaches the user that dismissing is cheaper than
/// deciding.
///
/// AND ONLY WHEN IT IS REAL. `OfferReveal.isAvailable` runs the same
/// eligibility check the reveal itself does, which fails closed for a user
/// Apple will charge full price. No offer, or no eligibility, means the
/// dismissal is a dismissal — we never stage a "discount" that is the standard
/// price wearing a badge.
struct UpgradePaywall: View {
    @Binding var isPresented: Bool
    let reason: PaywallReason

    @ObservedObject private var onboarding = OnboardingState.shared
    @ObservedObject private var subscription = SubscriptionService.shared

    /// Which catch, if any, is on screen. `.none` is the paywall itself.
    private enum Stage { case paywall, reveal, referral }
    @State private var stage: Stage = .paywall

    private static let seenKey = "exit_offer_seen"

    var body: some View {
        Group {
            switch stage {
            case .paywall:
                if onboarding.twoStepPaywallEnabled {
                    TwoStepPaywall(isPresented: exitBinding, reason: reason)
                } else {
                    PaywallView(isPresented: exitBinding, reason: reason)
                }

            case .reveal:
                // Purchasing here closes the whole thing; declining steps to the
                // invite rung, exactly as it did inside the old funnel.
                OfferRevealView(onDecline: { stage = .referral },
                                onPurchased: { isPresented = false })

            case .referral:
                ReferralCatchBeat(onSkip: { isPresented = false })
            }
        }
    }

    /// Intercepts the paywall's own dismissal. Write-only: the paywall never
    /// needs to know it is being wrapped, which is what keeps this out of both
    /// paywall bodies and out of every entry point.
    private var exitBinding: Binding<Bool> {
        Binding(get: { true }, set: { shown in
            if !shown { attemptExit() }
        })
    }

    private func attemptExit() {
        guard shouldCatch else {
            isPresented = false
            return
        }
        UserDefaults.standard.set(true, forKey: Self.seenKey)
        Analytics.track("exit_offer_shown", props: [
            "context": PaywallView.reasonKey(for: reason),
        ])
        stage = .reveal
    }

    private var shouldCatch: Bool {
        guard !UserDefaults.standard.bool(forKey: Self.seenKey) else { return false }
        guard !subscription.effectiveIsPro else { return false }
        let packages = SubscriptionService.sortedByDuration(
            subscription.offerings?.current?.availablePackages ?? [])
        let preferred = OfferReveal.preferredPackage(in: packages)
        return OfferReveal.isAvailable(in: packages, preferring: preferred)
    }
}

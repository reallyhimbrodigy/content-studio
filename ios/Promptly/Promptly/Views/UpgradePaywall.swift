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
/// THREE TIMES, THEN STOP — see `ExitOffer` below. It was once-ever, which is
/// too few for the only thing standing between a declining user and nothing;
/// unlimited would be a toll gate that teaches dismissing is cheaper than
/// deciding. The budget is shared with the credit wall, which spends from the
/// same three.
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
        ExitOffer.record("paywall_dismiss_" + PaywallView.reasonKey(for: reason))
        stage = .reveal
    }

    private var shouldCatch: Bool {
        guard ExitOffer.shouldOffer() else { return false }
        let packages = SubscriptionService.sortedByDuration(
            subscription.offerings?.current?.availablePackages ?? [])
        let preferred = OfferReveal.preferredPackage(in: packages)
        return OfferReveal.isAvailable(in: packages, preferring: preferred)
    }
}


/// THE EXIT OFFER'S BUDGET, in one place because two surfaces spend it.
///
/// It was a boolean — shown once, ever. Once is too few for a discount that is
/// the only thing standing between a declining user and nothing, and unlimited
/// is a toll gate that teaches dismissing is cheaper than deciding. Three, then
/// stop.
///
/// THE SEQUENCE IS DELIBERATE, not just a cap: the first two firings may share a
/// session (dismiss the paywall, then hit the credit wall an hour later), but
/// the THIRD requires a new launch. Without that, a user who dismissed twice in
/// one sitting would be shown it a third time in the same sitting, which is the
/// nagging the cap exists to prevent.
///
/// Shared rather than duplicated: the paywall exit and the credit wall are
/// different code paths, and two copies of "have we spent it" drift the moment
/// one of them is edited.
enum ExitOffer {
    private static let countKey = "exit_offer_count"
    private static let lastLaunchKey = "exit_offer_last_launch"
    static let limit = 3

    /// Stable for the lifetime of the process; changes on relaunch. Cheap, and
    /// it does not need to survive termination — "a later session" only has to
    /// mean "not this one".
    private static let launchId = UUID().uuidString

    static var spent: Int { UserDefaults.standard.integer(forKey: countKey) }

    /// Never for a subscriber, never past the cap, and the third only in a new
    /// session. Callers add their own reason to offer.
    @MainActor
    static func shouldOffer() -> Bool {
        guard !SubscriptionService.shared.effectiveIsPro else { return false }
        let n = spent
        guard n < limit else { return false }
        if n >= limit - 1 {
            let last = UserDefaults.standard.string(forKey: lastLaunchKey)
            guard last != launchId else { return false }
        }
        return true
    }

    static func record(_ trigger: String) {
        let n = spent + 1
        UserDefaults.standard.set(n, forKey: countKey)
        UserDefaults.standard.set(launchId, forKey: lastLaunchKey)
        Analytics.track("exit_offer_shown", props: ["trigger": trigger, "shown_count": n])
    }
}

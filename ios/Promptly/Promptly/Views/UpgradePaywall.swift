import SwiftUI
import RevenueCat

/// The one place that decides WHICH upgrade paywall is shown.
///
/// There are two presentation sites — the `AppShell` sheet and
/// `AppState.presentPaywallFromTop`'s hosting controller — and a flag honoured
/// at only one of them is worse than a flag honoured at neither: the surface
/// then depends on which code path happened to open it, so a review, a
/// screenshot and a funnel can each be looking at a different screen while all
/// three believe the flag is on. Both sites construct THIS view, so there is a
/// single branch and it cannot drift.
///
/// ── THE EXIT LADDER IS NOT HERE, AND THAT IS THE POINT ───────────────────────
/// This view briefly owned the exit-intent catch: dismissing it walked
/// reveal → downsell → invite. That put the discount behind EVERY in-app
/// paywall dismissal — the Upgrade pill, the export gate, re-edit, any usage
/// limit — because every in-app entry point constructs this view. Tapping
/// Upgrade out of curiosity and closing it handed the user a discount ladder.
///
/// The catch was written for the funnel, and the funnel never came through
/// here: `OnboardingV2Flow` renders `FirstLaunchPaywallView` DIRECTLY, exactly
/// so the discount stays reserved for a post-value dismissal. So a "is this the
/// funnel?" flag on this view would be a parameter that is false at every
/// construction site — dead code wearing the shape of a gate. The honest
/// version is that this view does not catch at all.
///
/// The two legitimate firings keep their OWN triggers, neither of which routes
/// through here:
///   • the credit wall — `CreditsTopUpView`'s close in `AppShell` records
///     `credit_wall` and raises `ExitOfferLadder` itself;
///   • the funnel — its own beat, in its own flow.
///
/// Both still spend from `ExitOffer`'s shared budget, so the cap holds across
/// them.
struct UpgradePaywall: View {
    @Binding var isPresented: Bool
    let reason: PaywallReason

    @ObservedObject private var onboarding = OnboardingState.shared

    var body: some View {
        if onboarding.twoStepPaywallEnabled {
            TwoStepPaywall(isPresented: $isPresented, reason: reason)
        } else {
            PaywallView(isPresented: $isPresented, reason: reason)
        }
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


/// THE LADDER, as a view, so both surfaces walk the same rungs.
///
/// The paywall exit builds these stages inline in `UpgradePaywall`; the credit
/// wall needs the identical sequence from a `fullScreenCover` with no paywall
/// above it. Extracted rather than copied — a second inline copy is how the
/// credit wall lost the invite rung in the first place.
struct ExitOfferLadder: View {
    let onFinish: () -> Void
    @State private var showInvite = false

    var body: some View {
        Group {
            if showInvite {
                ReferralCatchBeat(onSkip: onFinish)
            } else {
                OfferRevealView(onDecline: { showInvite = true },
                                onPurchased: onFinish)
            }
        }
    }
}

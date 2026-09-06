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
///     `credit_wall` and raises the invite rung itself.
///
/// The reveal rung and its firing budget were deleted 2026-09-06: the funnel is
/// paywall -> dismiss -> invite, and the monthly downsell it carried lives on
/// the Month row.
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

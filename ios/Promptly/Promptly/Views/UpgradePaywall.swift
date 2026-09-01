import SwiftUI

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
/// Off is byte-identical to today. `twoStepPaywallEnabled` defaults false and
/// the else-branch is the unmodified `PaywallView`.
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

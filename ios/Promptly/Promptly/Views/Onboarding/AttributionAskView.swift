import SwiftUI

/// The shared ATTRIBUTION ASK — the wall flow's Q3 verbatim (same
/// `OnboardingQuestion.attribution` options), with no flow around it.
///
/// Why it exists (attribution resurrection): the whole question flow hangs off
/// `wallOnboardingEnabled` = the wall_enforcement knob, which is OFF and
/// coupled to the server billing gates — so `onboarding_attribution` has fired
/// ZERO times ever. This view is the question decoupled from that flow,
/// reachable from two flag-gated placements:
///   - STANDALONE (`attribution_gate`): PromptlyApp shows it once at the
///     first-session moment, just before the first-launch paywall branch.
///   - ONBOARDING V2 (`onboarding_v2`): beat 3 of OnboardingV2Flow — which
///     SUPERSEDES the standalone, since it contains this same screen.
///
/// Rules: SKIPPABLE, never blocks the session, shown at most once per install.
/// ANY disposition (answer or skip) sets `hasSeenAttributionGate`, so no flag
/// combination can ever re-nag the question. On answer: the long-dead
/// `onboarding_attribution` event (allowlisted since 73609d2) + the state
/// write + the best-effort profile persist. Pre-auth the persist is a no-op
/// (no token) — PromptlyApp re-fires it the moment auth lands.
struct AttributionAskView: View {
    /// Names the surface on every event ("attribution_gate" / "onboarding_v2").
    let context: String
    /// Progress through a containing flow, e.g. (3, 4). nil when standalone.
    var progress: (index: Int, total: Int)? = nil
    /// Fired on any disposition (answer or skip). The standalone passes {} —
    /// the `hasSeenAttributionGate` flip re-branches the root by itself.
    let onDone: () -> Void

    @ObservedObject private var state = OnboardingState.shared

    var body: some View {
        OnboardingQuestionView(question: .attribution, isOptional: true,
                               progress: progress, onSkip: {}) { picked in
            if let first = picked.first {
                state.attribution = first
                Analytics.track("onboarding_attribution", props: ["attribution": first, "context": context])
                state.persistAnswersToProfile()
            } else {
                // Was emitted on `onboarding_step`, the LEGACY wall-flow event,
                // while every other beat of this flow reports on
                // `onboarding_v2_step`. So Q3's skip existed but sat in a table
                // the v2 funnel never reads — it looked like "skip is not
                // instrumented for Q3" when it was instrumented to the wrong
                // name. Emitted on BOTH: the v2 event so the funnel can see it,
                // and the legacy one so the standalone attribution gate's
                // existing series is not broken mid-flight.
                Analytics.track("onboarding_v2_step",
                                props: ["step": "attribution_skip",
                                        "phase": "skip", "context": context])
                Analytics.track("onboarding_step", props: ["step": "attribution_skip", "context": context])
            }
            // Any disposition counts as seen — the ask never re-nags.
            withAnimation { state.hasSeenAttributionGate = true }
            onDone()
        }
        .onAppear {
            Analytics.track("onboarding_step", props: ["step": "attribution_view", "context": context])
        }
    }
}

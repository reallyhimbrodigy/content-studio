import SwiftUI

/// The 1.2.0 wall onboarding — trimmed to language → signup → social proof → wall.
///
/// Beat order:
///   1. LANGUAGE — pick the app language (the one quiz step Zac kept); the rest
///      of onboarding + the app render in it.
///   2. SIGNUP — Sign in with Apple, minimal.
///   3. SOCIAL PROOF — one screen, true numbers only (+ the native review
///      prompt fires here, before the money ask).
///   4. THE WALL — the trial-timeline paywall (TrialWallView).
///
/// Removed 2026-07-21 (Zac): the opening HOOK clip (returns in a later build
/// with a good clip) and the QUIZ's engagement questions — and with the quiz
/// gone, the quiz-fed "building your studio" reveal is gone too (no personalized
/// screen left dangling). Language selection is deliberately KEPT.
///
/// Exposure: shown ONLY when the one knob says so (OnboardingState.resolve
/// Exposure → /api/health.wall_enforcement == 'on'). Knob off = the legacy
/// AuthView flow, byte-for-byte — PromptlyApp makes that branch, not us.
struct OnboardingFlow: View {
    @StateObject private var state = OnboardingState.shared
    @State private var auth = AuthService.shared

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            switch state.step {
            case .language:
                LanguageSelectionView {
                    state.step = auth.isAuthenticated ? .audience : .signup
                }
                .transition(.opacity)

            case .signup:
                // The real AuthView, untouched, embedded mid-flow. The flow
                // (not the root) reacts to the auth flip via onChange below,
                // so success continues to the questions instead of the app.
                AuthView()
                    .transition(.opacity)

            // EVENT NAMES ARE LITERALS on purpose: the deploy gate's regex only
            // sees `Analytics.track("…")` literals, and the old indirect
            // `.event` form left every answer silently dropped by the SQL
            // mirror. Allowlisted on main (73609d2). Answers ride post-signup,
            // so they key on the auth UUID.
            case .audience:
                OnboardingQuestionView(question: .audience,
                                       progress: (1, 3), onSkip: {}) { picked in
                    if let first = picked.first {
                        state.audience = first
                        Analytics.track("onboarding_audience", props: ["audience": first])
                    }
                    state.step = .intent
                }
                .transition(.move(edge: .trailing).combined(with: .opacity))

            case .intent:
                OnboardingQuestionView(question: .intent, multiSelect: true,
                                       progress: (2, 3), onSkip: {}) { picked in
                    if !picked.isEmpty {
                        state.intents = picked
                        // The vibe bridge keys off the FIRST pick.
                        state.preselectedVibe = OnboardingQuestion.vibe(forIntent: picked[0])
                        Analytics.track("onboarding_intent", props: ["intent": picked])
                    }
                    state.step = .attribution
                }
                .transition(.move(edge: .trailing).combined(with: .opacity))

            case .attribution:
                OnboardingQuestionView(question: .attribution, isOptional: true,
                                       progress: (3, 3), onSkip: {}) { picked in
                    if let first = picked.first {
                        state.attribution = first
                        Analytics.track("onboarding_attribution", props: ["attribution": first])
                    }
                    // Answers are final — persist now; completion fires after
                    // the results wall + second paywall run.
                    state.persistAnswersToProfile()
                    state.step = .results
                }
                .transition(.opacity)

            case .results:
                ResultsWallView {
                    state.step = .paywall2
                }
                .transition(.move(edge: .trailing).combined(with: .opacity))

            case .paywall2:
                SecondPaywallView {
                    // Purchased, shared, or declined — all land in the app.
                    Analytics.track("onboarding_completed")
                    state.hasCompletedOnboarding = true
                    state.step = .done
                }
                .transition(.opacity)

            case .done:
                // PromptlyApp observes hasCompletedOnboarding + auth and swaps
                // to AppShell; this is just the last frame before that flip.
                Color.black.ignoresSafeArea()
            }
        }
        .animation(.spring(response: 0.34, dampingFraction: 1.0), value: state.step)
        .onChange(of: auth.isAuthenticated) { _, isAuthed in
            if isAuthed && state.step == .signup {
                // The real signup moment → into the three questions.
                Analytics.track("signup_completed")
                state.step = .audience
            }
        }
        .onAppear {
            state.markFlowStarted()
            state.restore()
            // Completed → straight to done. Already signed in but still on a
            // pre-signup beat (language/signup) → skip ahead to the questions.
            if state.hasCompletedOnboarding {
                state.step = .done
            } else if auth.isAuthenticated && (state.step == .language || state.step == .signup) {
                state.step = .audience
            }
        }
    }
}

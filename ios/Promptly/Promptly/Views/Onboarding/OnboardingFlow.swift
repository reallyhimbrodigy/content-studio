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
                    state.step = auth.isAuthenticated ? .socialProof : .signup
                }
                .transition(.opacity)

            case .signup:
                // The real AuthView, untouched, embedded mid-flow. The flow
                // (not the root) reacts to the auth flip via onChange below,
                // so success continues to social proof instead of the app.
                AuthView()
                    .transition(.opacity)

            case .socialProof:
                SocialProofView {
                    state.step = .wall
                }
                .transition(.move(edge: .trailing).combined(with: .opacity))

            case .wall:
                TrialWallView(context: .onboarding) {
                    // Trial started or Pro purchased — the only doors out.
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
                state.step = .socialProof
            }
        }
        .onAppear {
            state.markFlowStarted()
            state.restore()
            // Completed → straight to done. Already signed in but still on a
            // pre-signup beat (language/signup) → skip ahead to social proof.
            if state.hasCompletedOnboarding {
                state.step = .done
            } else if auth.isAuthenticated && (state.step == .language || state.step == .signup) {
                state.step = .socialProof
            }
        }
    }
}

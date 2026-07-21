import SwiftUI

/// The 1.2.0 wall onboarding — Cal AI's conversion machine, our honesty.
///
/// Beat order (master spec):
///   1. HOOK — the before/after transformation plays before any ask.
///   2. SIGNUP — Sign in with Apple first, minimal.
///   3. QUIZ — language first (everything after renders in it), then creator
///      questions + one aspiration question. Progress bar, one-thumb taps,
///      every step evented with drop-off.
///   4. REVIEW PROMPT — at the investment peak, after the quiz, before the
///      wall (their documented placement; happy users rate before the ask).
///   5. REVEAL — "building your studio" from their answers.
///   6. SOCIAL PROOF — one screen, true numbers only.
///   7. THE WALL — the trial-timeline paywall (TrialWallView).
///
/// Exposure: shown ONLY when the one knob says so (OnboardingState.resolve
/// Exposure → /api/health.wall_enforcement == 'on'). Knob off = the legacy
/// AuthView flow, byte-for-byte — PromptlyApp makes that branch, not us.
///
/// Resume: a killed app re-enters at the right beat (state persisted); an
/// authenticated user never re-sees hook/signup.
struct OnboardingFlow: View {
    @StateObject private var state = OnboardingState.shared
    @State private var auth = AuthService.shared

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            switch state.step {
            case .hook:
                OnboardingHookView {
                    state.step = auth.isAuthenticated ? .quiz : .signup
                }
                .transition(.opacity)

            case .signup:
                // The real AuthView, untouched, embedded mid-flow. The flow
                // (not the root) reacts to the auth flip via onChange below,
                // so success continues to the quiz instead of the app.
                AuthView()
                    .transition(.opacity)

            case .quiz:
                OnboardingQuizView {
                    state.step = .building
                }
                .transition(.move(edge: .trailing).combined(with: .opacity))

            case .building:
                BuildingStudioView(answers: state.answers) {
                    state.step = .socialProof
                }
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
                state.step = .quiz
            }
        }
        .onAppear {
            state.markFlowStarted()
            state.restore()
            // Never resume into hook/signup once signed in; never into a
            // pre-wall beat once completed.
            if state.hasCompletedOnboarding {
                state.step = .done
            } else if auth.isAuthenticated && (state.step == .hook || state.step == .signup) {
                state.step = .quiz
            }
        }
    }
}

import SwiftUI

/// Beat 3 — THE QUIZ. Six steps, progress bar, animated transitions, one thumb.
/// Language is STEP ONE — everything after renders in it. The aspiration
/// question gates nothing (Cal AI proved engagement questions build the
/// investment that converts); every answer feeds personalization AND the
/// person properties funnels cut by. Every step emits `onboarding_step` with
/// the step key, so drop-off is measurable per screen.
struct OnboardingQuizView: View {
    let onComplete: () -> Void

    @StateObject private var state = OnboardingState.shared
    @State private var stepIndex = 0

    // Tier-1 nine languages (localization spec §13). English first; each shown
    // in its own script — a user picks THEIR language in THEIR language.
    private static let languages: [(code: String, label: String)] = [
        ("en", "English"), ("es", "Español"), ("pt", "Português"),
        ("hi", "हिन्दी"), ("ar", "العربية"), ("id", "Bahasa Indonesia"),
        ("fr", "Français"), ("de", "Deutsch"), ("ja", "日本語"),
    ]

    private struct QuizStep {
        let key: String
        let title: String
        let subtitle: String?
        let options: [String]
        let apply: (OnboardingState, String) -> Void
    }

    private static let steps: [QuizStep] = [
        QuizStep(key: "language",
                 title: "Choose your language",
                 subtitle: nil,
                 options: languages.map { $0.label },
                 apply: { s, label in
                     s.answers.language = languages.first(where: { $0.label == label })?.code ?? "en"
                 }),
        QuizStep(key: "creates",
                 title: "What do you create?",
                 subtitle: "So your edits match your world.",
                 options: ["Talking-head videos", "Tutorials & how-tos", "Product & business content", "Faith & motivation", "Something else"],
                 apply: { s, v in s.answers.creates = v }),
        QuizStep(key: "platform",
                 title: "Where do you post?",
                 subtitle: nil,
                 options: ["TikTok", "Instagram Reels", "YouTube Shorts", "More than one", "Not posting yet"],
                 apply: { s, v in s.answers.platform = v }),
        QuizStep(key: "frequency",
                 title: "How often do you post?",
                 subtitle: nil,
                 options: ["Daily", "A few times a week", "Weekly", "Just getting started"],
                 apply: { s, v in s.answers.frequency = v }),
        QuizStep(key: "goal",
                 title: "What's your goal?",
                 subtitle: nil,
                 options: ["Grow my audience", "Save editing time", "Make my videos look pro", "Turn content into income"],
                 apply: { s, v in s.answers.goal = v }),
        QuizStep(key: "aspiration",
                 title: "Where do you want to be in 90 days?",
                 subtitle: "We'll build your studio around it.",
                 options: ["Posting consistently", "First 1,000 followers", "First viral video", "Content is my job"],
                 apply: { s, v in s.answers.aspiration = v }),
    ]

    var body: some View {
        let step = Self.steps[stepIndex]
        VStack(spacing: 0) {
            // Progress bar + back. Investment made visible.
            HStack(spacing: 12) {
                if stepIndex > 0 {
                    Button {
                        withAnimation { stepIndex -= 1 }
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(.white.opacity(0.7))
                    }
                }
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.12))
                        Capsule().fill(Color.white)
                            .frame(width: geo.size.width * CGFloat(stepIndex + 1) / CGFloat(Self.steps.count))
                    }
                }
                .frame(height: 4)
                .animation(.spring(response: 0.4, dampingFraction: 1.0), value: stepIndex)
            }
            .padding(.horizontal, 24)
            .padding(.top, 18)

            Spacer(minLength: 32)

            VStack(alignment: .leading, spacing: 10) {
                Text(step.title)
                    .font(.system(size: 28, weight: .heavy))
                    .foregroundColor(.white)
                if let sub = step.subtitle {
                    Text(sub)
                        .font(.system(size: 15))
                        .foregroundColor(.white.opacity(0.6))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24)
            .id("title-\(stepIndex)")
            .transition(.move(edge: .trailing).combined(with: .opacity))

            Spacer(minLength: 24)

            // Options — big, tappable, one thumb.
            ScrollView(showsIndicators: false) {
                VStack(spacing: 10) {
                    ForEach(step.options, id: \.self) { option in
                        Button {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            step.apply(state, option)
                            Analytics.track("onboarding_step", props: [
                                "step": "quiz_\(step.key)", "answer": option,
                            ])
                            advance()
                        } label: {
                            // Localize the option label by its own text (a
                            // catalog key). Language names ("Español", …) aren't
                            // keys and fall back to display-as-is — correct.
                            Text(LocalizedStringKey(option))
                                .font(.system(size: 17, weight: .medium))
                                .foregroundColor(.white)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 18)
                                .frame(height: 58)
                                .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.white.opacity(0.10)))
                        }
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 32)
                .id("options-\(stepIndex)")
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .background(Color.black.ignoresSafeArea())
        .animation(.spring(response: 0.34, dampingFraction: 1.0), value: stepIndex)
        .onAppear {
            Analytics.track("onboarding_step", props: ["step": "quiz_\(Self.steps[stepIndex].key)_view"])
        }
    }

    private func advance() {
        if stepIndex + 1 < Self.steps.count {
            withAnimation { stepIndex += 1 }
            Analytics.track("onboarding_step", props: ["step": "quiz_\(Self.steps[stepIndex].key)_view"])
        } else {
            onComplete()
        }
    }
}

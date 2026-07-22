import SwiftUI

/// Beat 1 — LANGUAGE. The only quiz step Zac kept (2026-07-21) — the quiz's
/// engagement questions were removed, but language selection stays because most
/// of the user base is international and it drives which language the app UI
/// renders in (via the 9-language String Catalog). Each option is shown in its
/// OWN script — a user picks their language in their language — so these labels
/// are intentionally NOT localized.
///
/// Sets `OnboardingState.preferredLanguage`, which persists to AppleLanguages
/// (full effect next launch) and is applied as the root `.environment(\.locale)`
/// this session, so the rest of onboarding + the app render in the choice.
struct LanguageSelectionView: View {
    let onContinue: () -> Void
    @ObservedObject private var state = OnboardingState.shared

    // Tier-1 nine languages. English first; each in its own script.
    private static let languages: [(code: String, label: String)] = [
        ("en", "English"), ("es", "Español"), ("pt-BR", "Português"),
        ("hi", "हिन्दी"), ("ar", "العربية"), ("id", "Bahasa Indonesia"),
        ("fr", "Français"), ("de", "Deutsch"), ("ja", "日本語"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 40)
            VStack(spacing: 8) {
                Text("Choose your language")
                    .font(.system(size: 28, weight: .heavy))
                    .foregroundColor(.white)
                Text("You can change this anytime in Settings.")
                    .font(.system(size: 14))
                    .foregroundColor(.white.opacity(0.6))
            }
            .padding(.horizontal, 24)
            .multilineTextAlignment(.center)

            Spacer(minLength: 24)

            ScrollView(showsIndicators: false) {
                VStack(spacing: 10) {
                    ForEach(Self.languages, id: \.code) { lang in
                        let selected = state.preferredLanguage == lang.code
                        Button {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            state.preferredLanguage = lang.code
                            // Discrete ONBOARDING-funnel event (step 1 of 4).
                            Analytics.track("language_selected", props: ["language": lang.code])
                            // Push the choice onto the person profile immediately.
                            if let uid = AuthService.shared.currentUser?.id {
                                Analytics.identify(userId: uid, preferredLanguage: lang.code)
                            }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { onContinue() }
                        } label: {
                            HStack {
                                Text(lang.label)
                                    .font(.system(size: 18, weight: .medium))
                                    .foregroundColor(.white)
                                Spacer()
                                if selected {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundColor(.yellow)
                                }
                            }
                            .padding(.horizontal, 18)
                            .frame(height: 58)
                            .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                            .overlay(RoundedRectangle(cornerRadius: 16)
                                .stroke(selected ? Color.yellow.opacity(0.8) : Color.white.opacity(0.10), lineWidth: 1.5))
                        }
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.ignoresSafeArea())
        .onAppear {
            Analytics.track("onboarding_step", props: ["step": "language_view"])
        }
    }
}

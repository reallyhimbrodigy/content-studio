import SwiftUI

/// One onboarding question — single-select chips, Skip top-right, and a Continue
/// that stays DISABLED until a choice is made. Three of these back-to-back
/// (audience → intent → attribution) are the entire onboarding after signup,
/// then the user lands on the picker. No tour, no carousel: the funnel proved
/// day-1 is everything and 96% who render do it within 24h, so this is
/// deliberately three taps and out.
///
/// Each question is data (`OnboardingQuestion`) so the three screens share one
/// view. `onPick` reports the raw option key; `onSkip`/`onContinue` advance the
/// flow. The typed analytics event fires here so per-step drop-off is measurable
/// from day one.
struct OnboardingQuestion {
    let step: OnboardingState.Step
    let title: String
    let subtitle: String?
    /// (key stored + emitted, label shown). Order = display order.
    let options: [(key: String, label: String)]
    /// Analytics event name, e.g. "onboarding_audience".
    let event: String
    /// Prop key under which the chosen option rides, e.g. "audience".
    let propKey: String

    // MARK: - The three questions

    static let audience = OnboardingQuestion(
        step: .audience,
        title: "Who are you making videos for?",
        subtitle: "So Promptly can tailor the edit.",
        options: [
            ("self", "Myself / my brand"),
            ("business", "A business"),
            ("clients", "Clients"),
            ("creator", "A creator audience"),
            ("event", "An event"),
            ("trying", "Just trying it out"),
        ],
        event: "onboarding_audience",
        propKey: "audience"
    )

    static let intent = OnboardingQuestion(
        step: .intent,
        title: "What do you want to make?",
        subtitle: "We'll start you on a matching style.",
        options: [
            ("viral", "Viral / hype"),
            ("promo", "Sales / promo"),
            ("storytime", "Storytime"),
            ("talkinghead", "Talking-head clean-up"),
            ("highlights", "Highlights / recap"),
            ("unsure", "Not sure yet"),
        ],
        event: "onboarding_intent",
        propKey: "intent"
    )

    static let attribution = OnboardingQuestion(
        step: .attribution,
        title: "How did you hear about us?",
        subtitle: nil,
        options: [
            ("tiktok", "TikTok"),
            ("instagram", "Instagram"),
            ("youtube", "YouTube"),
            ("friend", "A friend"),
            ("appstore", "App Store search"),
            ("reddit_x", "Reddit / X"),
            ("other", "Other"),
        ],
        event: "onboarding_attribution",
        propKey: "attribution"
    )

    /// Q2 intent → the vibe the editor should open on. nil = default composer.
    static func vibe(forIntent key: String) -> String? {
        switch key {
        case "viral":       return "viral hype edit, fast cuts, punchy captions"
        case "promo":       return "sales pitch, clear value, call-to-action"
        case "storytime":   return "storytime, narrative pacing, captions"
        case "talkinghead": return "clean talking-head, remove filler, captions"
        case "highlights":  return "highlights recap, best moments, upbeat"
        default:            return nil   // "unsure" → blank composer
        }
    }
}

struct OnboardingQuestionView: View {
    let question: OnboardingQuestion
    /// Q2 is multi-select (ruled 2026-08-21); Q1/Q3 stay single-select.
    var multiSelect: Bool = false
    /// Q3 is OPTIONAL: Continue is always enabled (empty = same as Skip).
    /// Q1/Q2 are required-with-Skip: Continue stays disabled until a pick.
    var isOptional: Bool = false
    /// Progress through the question run, e.g. (1, 3) — the bar at the top.
    var progress: (index: Int, total: Int)? = nil
    let onSkip: () -> Void
    /// Reports the chosen option keys ([] if skipped/none). Advances the flow.
    let onContinue: (_ pickedKeys: [String]) -> Void

    @State private var selected: [String] = []

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                // Progress + Skip. Skip is always available on required
                // questions (the escape); on the optional one Continue already
                // never blocks, but Skip stays for consistency.
                HStack(spacing: 12) {
                    if let p = progress {
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(Color.white.opacity(0.12))
                                Capsule().fill(Color.white)
                                    .frame(width: geo.size.width * CGFloat(p.index) / CGFloat(max(p.total, 1)))
                            }
                        }
                        .frame(width: 120, height: 4)
                        .accessibilityLabel("Step \(p.index) of \(p.total)")
                    }
                    Spacer()
                    Button("Skip") { onContinue([]); onSkip() }
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(.white.opacity(0.55))
                }
                .padding(.top, 8)
                .padding(.horizontal, 20)

                VStack(alignment: .leading, spacing: 8) {
                    Text(question.title)
                        .font(.system(size: 28, weight: .bold))
                        .foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)
                    if let subtitle = question.subtitle {
                        Text(subtitle)
                            .font(.system(size: 16))
                            .foregroundStyle(.white.opacity(0.6))
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 28)
                .padding(.bottom, 24)

                ScrollView {
                    VStack(spacing: 12) {
                        ForEach(question.options, id: \.key) { opt in
                            chip(opt.key, opt.label)
                        }
                    }
                    .padding(.horizontal, 20)
                }

                Spacer(minLength: 8)

                // Continue — DISABLED until a choice is made (Zac's rule) on
                // required questions; always enabled on the optional one.
                Button {
                    guard isOptional || !selected.isEmpty else { return }
                    onContinue(selected)
                } label: {
                    Text("Continue")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 54)
                        .foregroundStyle(!isOptional && selected.isEmpty ? .white.opacity(0.4) : .black)
                        .background(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .fill(!isOptional && selected.isEmpty ? Color.white.opacity(0.12) : Color.white)
                        )
                }
                .disabled(!isOptional && selected.isEmpty)
                .padding(.horizontal, 20)
                .padding(.bottom, 16)
            }
        }
    }

    private func chip(_ key: String, _ label: String) -> some View {
        let isSelected = selected.contains(key)
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            if multiSelect {
                if let idx = selected.firstIndex(of: key) { selected.remove(at: idx) }
                else { selected.append(key) }
            } else {
                selected = [key]
            }
        } label: {
            HStack {
                Text(label)
                    .font(.system(size: 17, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(.white)
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.white)
                }
            }
            .padding(.horizontal, 18)
            .frame(height: 56)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.white.opacity(isSelected ? 0.16 : 0.07))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(Color.white.opacity(isSelected ? 0.9 : 0.0), lineWidth: 1.5)
            )
        }
    }
}

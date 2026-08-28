import SwiftUI

// MARK: - Onboarding motion vocabulary (2026-08-27)
//
// One spring, used everywhere in this flow, so screens feel like one product
// rather than five independently-tuned animations. Every value here is
// interruptible by construction (SwiftUI springs retarget mid-flight) and no
// animation ever gates a tap: selection commits on touch-down feedback via a
// ButtonStyle, never inside a completion handler.
enum OnboardingMotion {
    /// The house spring — quick enough to feel responsive at 60/120Hz,
    /// damped enough not to wobble.
    static let spring = Animation.spring(response: 0.38, dampingFraction: 0.82)
    /// Selection/press: shorter, snappier.
    static let snap = Animation.spring(response: 0.26, dampingFraction: 0.7)
    /// Reduce Motion substitute: the state change still READS, it just
    /// doesn't travel. Never "no animation at all" — an instant swap is its
    /// own kind of jarring.
    static let reduced = Animation.easeInOut(duration: 0.18)

    static func step(_ reduce: Bool) -> Animation { reduce ? reduced : spring }
    static func tap(_ reduce: Bool) -> Animation { reduce ? reduced : snap }
}

/// Press feedback that can never block input: the scale lives in the button
/// STYLE, driven by `configuration.isPressed`, so the gesture is never
/// waiting on an animation to finish.
struct OnboardingPressStyle: ButtonStyle {
    var reduceMotion: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.975 : 1.0)
            .animation(OnboardingMotion.tap(reduceMotion), value: configuration.isPressed)
    }
}

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
    #if DEBUG
    /// Motion-proof only: selects this option and continues, on a delay, via
    /// the SAME state changes a real tap makes — so a screen recording shows
    /// the real selection spring, the real Continue enable, and the real
    /// beat transition. Synthetic INPUT, genuine animation.
    var autoDriveKey: String? = nil
    #endif
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Required questions gate Continue on a selection; the optional one never does.
    private var canContinue: Bool { isOptional || !selected.isEmpty }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            // Render-caught 2026-08-27: this column had no width bound, so a
            // longer option label ("Clients (agency or freelance)") widened
            // the whole screen and the centred content ran off BOTH edges —
            // the title read "ho are you making videos for?". Bounding the
            // column to the container is the fix; it is inert for the short
            // labels the wall flow uses.
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
                                    // The bar travels between beats; without
                                    // this it teleports and the flow reads as
                                    // five unrelated screens.
                                    .animation(OnboardingMotion.step(reduceMotion), value: p.index)
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
                        .foregroundStyle(canContinue ? .black : .white.opacity(0.4))
                        .background(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .fill(canContinue ? Color.white : Color.white.opacity(0.12))
                        )
                        // Enabling is an EVENT, not a colour swap: the button
                        // rises to full size and settles as the answer lands.
                        .scaleEffect(canContinue ? 1.0 : 0.97)
                        .animation(OnboardingMotion.step(reduceMotion), value: canContinue)
                }
                .buttonStyle(OnboardingPressStyle(reduceMotion: reduceMotion))
                .disabled(!canContinue)
                .padding(.horizontal, 20)
                .padding(.bottom, 16)
            }
            .frame(maxWidth: .infinity)
        }
        #if DEBUG
        .task {
            guard let key = autoDriveKey else { return }
            try? await Task.sleep(nanoseconds: 900_000_000)
            withAnimation(OnboardingMotion.tap(reduceMotion)) { selected = [key] }
            try? await Task.sleep(nanoseconds: 1_100_000_000)
            onContinue(selected)
        }
        #endif
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
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                // The check springs in rather than blinking on — the one
                // moment the user is told "yes, that one".
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.white)
                    .scaleEffect(isSelected ? 1 : 0.4)
                    .opacity(isSelected ? 1 : 0)
            }
            .padding(.horizontal, 18)
            .frame(maxWidth: .infinity, minHeight: 56)
            .animation(OnboardingMotion.tap(reduceMotion), value: isSelected)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.white.opacity(isSelected ? 0.16 : 0.07))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(Color.white.opacity(isSelected ? 0.9 : 0.0), lineWidth: 1.5)
            )
        }
        .buttonStyle(OnboardingPressStyle(reduceMotion: reduceMotion))
    }
}

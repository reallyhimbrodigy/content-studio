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
    /// Retyped to V2 when the V1 flow was deleted. The two enums both had an
    /// `.audience` case, so this compiled against the wrong one for as long as
    /// both existed — it only surfaced when V1 went.
    let step: OnboardingState.V2Step
    let title: String
    let subtitle: String?
    /// (key stored + emitted, label shown). Order = display order.
    let options: [(key: String, label: String)]
    /// Analytics event name, e.g. "onboarding_audience".
    let event: String
    /// Prop key under which the chosen option rides, e.g. "audience".
    let propKey: String

    // MARK: - The three questions

    // `title`/`subtitle`/`label` are plain `String`, NOT LocalizedStringKey, so
    // a bare literal here is invisible to the compiler's string extractor and
    // can never localize — it renders English in every language and no
    // catalog-only check can see it, because the key never reaches the catalog.
    // That is exactly how Q3 shipped English-only to twelve localized markets.
    // Every user-visible literal in these specs is wrapped.
    //
    // Brand names are wrapped too rather than special-cased: it keeps the gate
    // default-deny with no exemption list. They are translated as themselves —
    // brands are not transliterated, so an Arabic reader sees "TikTok".




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
    /// Motion-proof only: selects this option and continues, on a delay, via
    /// the SAME state changes a real tap makes — so a screen recording shows
    /// the real selection spring, the real Continue enable, and the real
    /// beat transition. Synthetic INPUT, genuine animation.
    ///
    /// Declared in BOTH configurations on purpose. It was DEBUG-only while the
    /// call site was not, so this compiled in Debug and failed in Release —
    /// invisible to every simulator build and caught only at archive. Only the
    /// `.task` that acts on this is DEBUG-gated; in Release it is an unused
    /// nil default.
    var autoDriveKey: String? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var hSize
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
                    OnboardingMark()
                        .padding(.bottom, 6)
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
                    // A REAL TABLET GRID, not a phone list in a wider column.
                    // Six answers stacked one-per-row down a 1032pt screen is
                    // the shape that reads as an adapted phone; two across
                    // fills the width, keeps each tile large enough to hit
                    // comfortably, and shortens the scroll to nothing.
                    if hSize == .regular {
                        // 26pt between tiles, not 16. On a tablet the slack has
                        // to go somewhere, and putting it BETWEEN the answers
                        // is what fills the screen; leaving it to the trailing
                        // Spacer pooled 708pt under the grid.
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 26),
                                            GridItem(.flexible(), spacing: 26)],
                                  spacing: 26) {
                            ForEach(question.options, id: \.key) { opt in
                                chip(opt.key, opt.label)
                            }
                        }
                        .padding(.horizontal, 20)
                    } else {
                        VStack(spacing: 12) {
                            ForEach(question.options, id: \.key) { opt in
                                chip(opt.key, opt.label)
                            }
                        }
                        .padding(.horizontal, 20)
                    }
                }

                // Capped on a tablet so the remainder cannot all land here —
                // the same rule the paywall's seams follow.
                Spacer(minLength: 8).frame(maxHeight: hSize == .regular ? 40 : .infinity)

                // Continue — DISABLED until a choice is made (Zac's rule) on
                // required questions; always enabled on the optional one.
                Button {
                    guard isOptional || !selected.isEmpty else { return }
                    onContinue(selected)
                } label: {
                    Text("Continue")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .cControl(54)
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
            // The only width bound on the question column — capping here
            // constrains the header, the options and the CTA together.
            .conversionColumn(ConversionColumn.content)
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

/// THE ONBOARDING MARK — brand presence on the question beats. 2026-09-02.
///
/// The funnel is now two questions and then the product, and neither question
/// carried the mark at all: a progress bar, a Skip link and a headline, on
/// black. Correct and characterless — the two screens that set the tone for the
/// whole app were the only ones with nothing of the brand in them.
///
/// ANIMATED ON APPEAR, not made larger and not redrawn. A bigger mark is scale,
/// not personality, and a different mark is a brand decision that belongs to
/// Zac rather than to a build. Motion gives it presence while leaving the
/// identity untouched.
///
/// The entrance MATCHES LaunchView deliberately — scale settling inward, blur
/// clearing, opacity rising — so the mark reads as the same object continuing
/// its arrival rather than a second logo appearing in a new style. Under
/// Reduce Motion it simply is there, with no travel.
struct OnboardingMark: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var arrived = false

    var body: some View {
        Image("PromptlyLogo")
            .renderingMode(.original)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: 30, height: 30)
            .scaleEffect(arrived ? 1.0 : 1.12)
            .blur(radius: arrived ? 0 : 6)
            .opacity(arrived ? 1 : 0)
            .onAppear {
                guard !reduceMotion else { arrived = true; return }
                withAnimation(.easeOut(duration: 0.52)) { arrived = true }
            }
            .accessibilityHidden(true)   // decorative; the headline carries the meaning
    }
}

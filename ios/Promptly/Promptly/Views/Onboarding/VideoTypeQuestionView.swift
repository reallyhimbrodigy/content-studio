import SwiftUI

/// Q2 — content type, with editing style as a SEPARATE control on the same
/// screen (rebuilt 2026-08-27).
///
/// WHAT THIS REPLACES AND WHY: the previous cut multiplied the two axes into
/// one option list — "Podcast clips — fast cuts", "Podcast clips — clean and
/// minimal", "Talking head — punchy", "Talking head — clean and minimal"...
/// a Cartesian product that repeated every noun, grew with each new style,
/// and made the user read the same word twice to find the row they wanted.
/// Two questions were being asked through one control.
///
/// Now: content type is the question (single-select rows, full coverage
/// including a personal/everyday option that was missing), and style is a
/// second, OPTIONAL control below it — a compact row the user can leave
/// alone. Continue gates on the content type only, because style is a
/// refinement, not a requirement.
///
/// The compound key ("podcast:fast") is still what gets STORED — every
/// downstream reader already parses it, and the parse is gate-enforced. It
/// is an internal encoding and never appears in the UI.
struct VideoTypeQuestionView: View {
    var progress: (index: Int, total: Int)? = nil
    let onSkip: () -> Void
    /// Reports the compound key, or [] when skipped.
    let onContinue: (_ pickedKeys: [String]) -> Void
    /// Motion-proof: drives (type, style) through the same state a tap sets.
    /// Declared in both configurations so call sites compile in Release; only
    /// the `.task` that acts on it is DEBUG-only.
    var autoDrive: (type: String, style: String?)? = nil

    @State private var type: String?
    @State private var style: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let types: [(key: String, label: String)] = [
        ("talkinghead", String(localized: "Talking head")),
        ("podcast", String(localized: "Podcast clips")),
        ("vlogs", String(localized: "Vlogs")),
        ("promo", String(localized: "Product or promo")),
        ("personal", String(localized: "Personal / everyday")),
        ("other", String(localized: "Something else")),
    ]

    /// Style is deliberately short and plain-language. No creator names.
    static let styles: [(key: String, label: String)] = [
        ("fast", String(localized: "Fast cuts")),
        ("clean", String(localized: "Clean")),
        ("cinematic", String(localized: "Cinematic")),
    ]

    private var canContinue: Bool { type != nil }

    @FocusState private var otherFocused: Bool

    /// The free-text answer for "Something else".
    ///
    /// Stored under its own key rather than squeezed into the compound key: the
    /// compound key is parsed by `contentTypeV2` and friends, and a user's
    /// arbitrary sentence has no business in a field those switch on. This is
    /// data for personalisation to READ, not a new enum case to guess at.
    @State private var otherText: String = ""

    private var otherField: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("", text: $otherText, prompt:
                Text(String(localized: "What kind of videos?"))
                    .foregroundColor(.white.opacity(0.35)))
                .textInputAutocapitalization(.sentences)
                .autocorrectionDisabled(false)
                .focused($otherFocused)
                .font(.system(size: 16))
                .foregroundColor(.white)
                .padding(.horizontal, 14)
                .frame(height: 52)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.white.opacity(0.07)))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.white.opacity(otherFocused ? 0.28 : 0.10), lineWidth: 1))
                // OPTIONAL. Continue already gates on the type alone, and
                // demanding a sentence here would turn the escape hatch into a
                // second question — which is what the removed chips did.
                .submitLabel(.done)
        }
    }

    /// The internal encoding: "type:style", or bare type when no style was
    /// chosen. Never rendered.
    private var compoundKey: String? {
        guard let type else { return nil }
        guard let style, type != "other" else { return type }
        return "\(type):\(style)"
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 12) {
                    if let p = progress {
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(Color.white.opacity(0.12))
                                Capsule().fill(Color.white)
                                    .frame(width: geo.size.width * CGFloat(p.index) / CGFloat(max(p.total, 1)))
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
                    Text(String(localized: "What kind of videos do you make?"))
                        .font(.system(size: 28, weight: .bold))
                        .foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(String(localized: "We'll start you on a matching style."))
                        .font(.system(size: 16))
                        .foregroundStyle(.white.opacity(0.6))
                }
                .padding(.horizontal, 20)
                .padding(.top, 28)
                .padding(.bottom, 20)

                ScrollView {
                    VStack(spacing: 10) {
                        ForEach(Self.types, id: \.key) { opt in
                            typeRow(opt.key, opt.label)
                        }

                        // STYLE CHIPS REMOVED. They asked for a second answer
                        // before the first one had done anything, and the same
                        // three labels are already asked — better — by
                        // InstantQuestionCard at the moment a render starts,
                        // where the user has context and the answer is about
                        // the clip in front of them.
                        //
                        // FREE TEXT ON "SOMETHING ELSE", which is the change
                        // that earns its place. Picking it used to store the
                        // bare key `other`, and `other` returns nil from
                        // contentTypeV2, PaywallPersonalization.contentNoun and
                        // ProBenefits.personalised — so every user who did not
                        // fit the five presets fell into a bucket that
                        // personalises nothing and tells us nothing. Their
                        // answer existed and was thrown away.
                        if type == "other" {
                            otherField
                                .padding(.top, 14)
                                .transition(reduceMotion ? .opacity
                                            : .opacity.combined(with: .move(edge: .bottom)))
                        }
                    }
                    .padding(.horizontal, 20)
                    .animation(OnboardingMotion.step(reduceMotion), value: type)
                }

                Spacer(minLength: 8)

                Button {
                    guard let key = compoundKey else { return }
                    // Store the free text alongside the key. Trimmed, and only
                    // when non-empty — an empty string would read downstream as
                    // "they answered nothing", which is exactly what `other`
                    // already means and would gain nothing.
                    let trimmed = otherText.trimmingCharacters(in: .whitespacesAndNewlines)
                    if key == "other", !trimmed.isEmpty {
                        OnboardingState.shared.v2VideoTypeOther = trimmed
                    }
                    onContinue([key])
                } label: {
                    Text("Continue")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(maxWidth: .infinity).frame(height: 54)
                        .foregroundStyle(canContinue ? .black : .white.opacity(0.4))
                        .background(RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(canContinue ? Color.white : Color.white.opacity(0.12)))
                        .scaleEffect(canContinue ? 1.0 : 0.97)
                        .animation(OnboardingMotion.step(reduceMotion), value: canContinue)
                }
                .buttonStyle(OnboardingPressStyle(reduceMotion: reduceMotion))
                .disabled(!canContinue)
                .padding(.horizontal, 20)
                .padding(.bottom, 16)
            }
            .conversionColumn(ConversionColumn.content)
        }
        #if DEBUG
        .task {
            guard let drive = autoDrive else { return }
            try? await Task.sleep(nanoseconds: 900_000_000)
            withAnimation(OnboardingMotion.tap(reduceMotion)) { type = drive.type }
            if let st = drive.style {
                try? await Task.sleep(nanoseconds: 800_000_000)
                withAnimation(OnboardingMotion.tap(reduceMotion)) { style = st }
            }
            try? await Task.sleep(nanoseconds: 900_000_000)
            if let key = compoundKey { onContinue([key]) }
        }
        #endif
    }

    private func typeRow(_ key: String, _ label: String) -> some View {
        let isSelected = type == key
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            type = key
            if key == "other" { style = nil }
        } label: {
            HStack {
                Text(label)
                    .font(.system(size: 17, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.white)
                    .scaleEffect(isSelected ? 1 : 0.4)
                    .opacity(isSelected ? 1 : 0)
            }
            .padding(.horizontal, 18)
            .frame(maxWidth: .infinity, minHeight: 56)
            .animation(OnboardingMotion.tap(reduceMotion), value: isSelected)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(isSelected ? 0.16 : 0.07)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.white.opacity(isSelected ? 0.9 : 0.0), lineWidth: 1.5))
        }
        .buttonStyle(OnboardingPressStyle(reduceMotion: reduceMotion))
    }

    private var styleControl: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(String(localized: "Editing style (optional)"))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.5))
                .textCase(.uppercase)
            HStack(spacing: 10) {
                ForEach(Self.styles, id: \.key) { s in
                    let on = style == s.key
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        style = (style == s.key) ? nil : s.key   // tap again to clear
                    } label: {
                        Text(s.label)
                            .font(.system(size: 15, weight: on ? .semibold : .regular))
                            .foregroundStyle(on ? .black : .white)
                            .frame(maxWidth: .infinity).frame(height: 44)
                            .background(Capsule().fill(on ? Color.white : Color.white.opacity(0.07)))
                            .animation(OnboardingMotion.tap(reduceMotion), value: on)
                    }
                    .buttonStyle(OnboardingPressStyle(reduceMotion: reduceMotion))
                }
            }
        }
    }
}

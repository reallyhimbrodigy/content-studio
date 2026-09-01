import SwiftUI

/// The readable column every conversion surface lives in.
///
/// WHY THIS EXISTS AS ONE THING. The app ships on iPad
/// (TARGETED_DEVICE_FAMILY = "1,2") with no UIRequiresFullScreen, so every
/// surface can be handed anything from a ~320pt Slide Over column to 1366pt
/// landscape. Before this, exactly TWO files in the whole app capped their
/// width — AuthView and OtpInputView — and both did it by hand. Everything else
/// stretched to the window.
///
/// That is not a cosmetic matter here. AuthView's cap carries the note that a
/// full-width control "is what Apple flagged in the App Review rejection of
/// build 151". The pattern was already known, already paid for, and applied in
/// one place. Copying it by hand into eight more would mean eight numbers to
/// keep in step, so it lives here once.
///
/// THE TWO FRAMES ARE BOTH LOAD-BEARING, in this order:
///   1. `maxWidth: columnWidth` caps the content.
///   2. `maxWidth: .infinity` re-expands the CONTAINER so the capped content
///      centers inside it.
/// Cap alone leaves the column pinned to the leading edge with dead space to the
/// right, which reads as a rendering fault rather than a layout choice. This is
/// the exact pair AuthView.swift:72-73 uses.
///
/// It is a no-op on iPhone: at 390pt the cap never binds, so the shipping
/// majority sees no change at all.
struct ConversionColumn: ViewModifier {
    /// TWO WIDTHS, because two different jobs were being served by one number.
    ///
    /// 460 came from AuthView, where it is correct: a sign-in form is one field
    /// and one button, and widening it only spreads a small amount of content
    /// thinner. Reusing it for the paywall was the mistake — that surface
    /// carries six benefit rows, three plan cards and a referral row, and at
    /// 460 on a 13-inch iPad it reads as a phone screenshot centred in a large
    /// black field. Content-heavy surfaces need room; forms do not.
    ///
    /// `form` stays 460 exactly, so AuthView and OtpInputView are unchanged and
    /// the build-151 rejection fix is untouched.
    static let form: CGFloat = 460
    /// Content-heavy: paywall, offer reveal, onboarding questions, render
    /// screen. 660 keeps body text near a readable measure (~75 characters at
    /// the scaled size) while giving plan cards and benefit rows the room the
    /// 460 column denied them.
    static let content: CGFloat = 660

    /// Back-compat default. Existing callers that passed nothing meant "the one
    /// width there was", which was the form width.
    static let columnWidth: CGFloat = form

    var width: CGFloat = ConversionColumn.columnWidth

    func body(content: Content) -> some View {
        content
            .frame(maxWidth: width)
            .frame(maxWidth: .infinity)
    }
}

extension View {
    /// Constrain a conversion surface to a centered, readable column.
    ///
    /// Apply to the SCROLL CONTENT, not to the ScrollView — capping the
    /// ScrollView itself would narrow the scrollable area and leave the
    /// scroll indicator floating in the middle of the screen.
    func conversionColumn(_ width: CGFloat = ConversionColumn.columnWidth) -> some View {
        modifier(ConversionColumn(width: width))
    }
}

/// A conversion surface's scroll container: capped width AND vertically
/// centered when the content is shorter than the viewport.
///
/// WHY THE VERTICAL HALF MATTERS. Capping the width alone fixed the stretch and
/// left a second defect visible in the first iPad capture: the column sat
/// top-aligned with roughly a third of a 13-inch screen as dead black beneath
/// the legal links. On a phone that never shows, because the content is taller
/// than the viewport. On iPad it reads as a half-loaded page.
///
/// `minHeight` rather than a fixed height is the whole trick, and it is why this
/// is safe on small devices: when the content is TALLER than the viewport — the
/// 375pt iPhone case, where this paywall's CTA already sits below the fold — the
/// constraint simply does not bind and the view scrolls exactly as before. It
/// only ever adds height that was empty anyway.
///
/// A fixed height, or `containerRelativeFrame`, would size the content to the
/// viewport and clip the overflow on those same small screens. That would turn
/// an iPad polish fix into an iPhone regression, on the surface with App Review
/// history.
struct ConversionScroll<Content: View>: View {
    var width: CGFloat = ConversionColumn.columnWidth
    var showsIndicators: Bool = false
    @ViewBuilder var content: () -> Content

    /// Regular width means iPad (or a wide Split View column). Compact means a
    /// phone, or a narrow Split View column ON an iPad — which is the case that
    /// makes size class the right signal and device model the wrong one: a
    /// 320pt Slide Over column on a 13-inch iPad should render phone-sized type,
    /// because that is the size it actually is.
    @Environment(\.horizontalSizeClass) private var hSize

    /// 1.18 rather than something larger. The goal is a screen that looks
    /// designed for the device, not a magnified phone: past roughly 1.2 the
    /// proportions start reading as an accessibility setting rather than a
    /// layout.
    private var scale: CGFloat { hSize == .regular ? 1.18 : 1.0 }

    var body: some View {
        GeometryReader { geo in
            ScrollView(showsIndicators: showsIndicators) {
                content()
                    .environment(\.conversionScale, scale)
                    .conversionColumn(width)
                    .frame(minHeight: geo.size.height)
            }
        }
    }
}


// MARK: - iPad type + spacing scale

/// How much larger type and spacing run on a regular-width (iPad) container.
///
/// WHY THIS EXISTS AS A SEPARATE THING FROM THE WIDTH CAP. Capping the column
/// stopped the stretch, but it left the other half of the defect: iPhone-sized
/// type sitting in a wider column on a much larger screen, viewed from further
/// away. A 15pt label that reads correctly at arm's length on a phone is small
/// on a 13-inch iPad on a desk — the column looked right and the CONTENT still
/// looked like a phone screenshot pasted into it.
///
/// DYNAMIC TYPE CANNOT DO THIS HERE, which is why there is a bespoke mechanism.
/// Every label on these surfaces uses `Font.system(size:)`, a FIXED point size
/// that does not respond to Dynamic Type at all. Bumping the environment's
/// size category — the obvious lever — would move nothing on this codebase. I
/// checked before building this rather than after.
private struct ConversionScaleKey: EnvironmentKey {
    static let defaultValue: CGFloat = 1.0
}

extension EnvironmentValues {
    var conversionScale: CGFloat {
        get { self[ConversionScaleKey.self] }
        set { self[ConversionScaleKey.self] = newValue }
    }
}

extension View {
    /// Type on a conversion surface, scaled for the container it is in.
    ///
    /// Deliberately NOT `scaleEffect` on the whole column: that rasterises at
    /// the original size and scales the bitmap, which softens text — on the
    /// screen where the product asks for money. This resolves a real point size
    /// instead, so glyphs are rendered crisp at the size they are shown.
    func cType(_ size: CGFloat, _ weight: Font.Weight = .regular) -> some View {
        modifier(ConversionType(size: size, weight: weight))
    }

    /// Spacing that grows with the same factor as the type, so the rhythm of a
    /// screen is preserved rather than type getting bigger inside phone-sized
    /// gaps.
    func cSpacing(_ base: CGFloat, _ edges: Edge.Set = .all) -> some View {
        modifier(ConversionSpacing(base: base, edges: edges))
    }
}

private struct ConversionType: ViewModifier {
    let size: CGFloat
    let weight: Font.Weight
    @Environment(\.conversionScale) private var scale
    func body(content: Content) -> some View {
        content.font(.system(size: (size * scale).rounded(), weight: weight))
    }
}

private struct ConversionSpacing: ViewModifier {
    let base: CGFloat
    let edges: Edge.Set
    @Environment(\.conversionScale) private var scale
    func body(content: Content) -> some View {
        content.padding(edges, (base * scale).rounded())
    }
}

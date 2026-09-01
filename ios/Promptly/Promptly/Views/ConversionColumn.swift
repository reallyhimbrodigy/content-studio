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
    /// 460pt, matching AuthView. Wide enough for a two-column plan card, narrow
    /// enough that body text stays near a readable measure instead of running to
    /// the ~120-character lines a 1024pt column would produce.
    static let columnWidth: CGFloat = 460

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

    var body: some View {
        GeometryReader { geo in
            ScrollView(showsIndicators: showsIndicators) {
                content()
                    .conversionColumn(width)
                    .frame(minHeight: geo.size.height)
            }
        }
    }
}

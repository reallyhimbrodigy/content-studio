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

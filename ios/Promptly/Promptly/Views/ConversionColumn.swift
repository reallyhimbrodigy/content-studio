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
    /// Content-heavy: paywall, offer reveal, onboarding questions, top-up,
    /// account.
    ///
    /// 660 WAS A PHONE LAYOUT WITH PADDING. On a 13-inch iPad (1032pt portrait)
    /// it left 186pt of dead black down each side, and the read was correct:
    /// the app did not look like it knew it was on a tablet. A readable measure
    /// governs BODY PROSE; these surfaces are mostly rows, cards and controls,
    /// which want the width.
    ///
    /// 920 fills an 11-inch portrait almost entirely and leaves a generous but
    /// deliberate margin on a 13-inch, while still never binding on any phone.
    static let content: CGFloat = 920

    /// One factor, used by both the scroll container and the bare width cap, so
    /// two surfaces can never disagree about how big an iPad is.
    /// THE ONE CONSTANT, defined by the screen: the tablet's long side over the
    /// iPhone 17 Pro's 852pt. 1376 / 852 = 1.615 on a 13-inch, 1194 / 852 =
    /// 1.40 on an 11-inch. Every dimension on every screen multiplies by it —
    /// type, padding, radius, icon, stroke, control height, tile height — and
    /// nothing gets a second layout. Set once at the window root.
    static let phoneReferenceHeight: CGFloat = 852

    /// Back-compat default. Existing callers that passed nothing meant "the one
    /// width there was", which was the form width.
    static let columnWidth: CGFloat = form

    var width: CGFloat = ConversionColumn.columnWidth

    /// THE SCALE TRAVELS WITH THE COLUMN. It used to be set only by
    /// `ConversionScroll`, so surfaces that took the width cap directly —
    /// the account page, the top-up screen — got an iPad-width column full of
    /// phone-sized type and phone-sized controls. That is the shape of the
    /// complaint, and it was a wiring gap rather than a design decision.
    @Environment(\.horizontalSizeClass) private var hSize

    /// PROPORTIONAL, NOT A NUMBER. 660 then 920 were both fixed caps, and a
    /// fixed cap is wrong in two directions at once: it leaves a 13-inch
    /// portrait (1032pt) short and a 13-inch LANDSCAPE (1376pt) far shorter,
    /// while a narrow split-view column never reaches it at all. 88% of
    /// whatever width the container actually has fills both orientations and
    /// keeps a real margin.
    ///
    /// The phone is untouched: `min` with the compact width means the cap
    /// simply never binds below it.
    static let padFill: CGFloat = 0.88

    func body(content: Content) -> some View {
        content
            // The scale is NOT set here any more. It is one value, set once at
            // the window root (`RootScale`), so a nav bar, a pill in a header
            // and a plan row all read the same k. Setting it per column was how
            // the Upgrade pill stayed phone-sized on a tablet: it sat outside
            // every column.
            // `containerRelativeFrame`, NOT a GeometryReader.
            //
            // The proportional width was first written with a GeometryReader,
            // and a GeometryReader reports NO intrinsic height. EditorView
            // attaches its composer with `.safeAreaInset(edge: .bottom)`, whose
            // height comes from the content's ideal height — so the inset
            // collapsed, the composer took the whole screen, and the chat
            // rendered with the input at the TOP and everything below it empty.
            // A width mechanism silently broke a layout anchor.
            //
            // `containerRelativeFrame` asks the container for its width without
            // claiming the height, which is exactly the question being asked.
            .modifier(ProportionalWidth(active: hSize == .regular,
                                        fraction: ConversionColumn.padFill,
                                        fallback: width))
    }
}

/// Width relative to the container, height left alone — measured, not asked.
///
/// `containerRelativeFrame` was the first attempt and it has a hole: applied
/// to the CONTENT of a ScrollView it resolves to no width at all, and three
/// surfaces built that way (PaywallView, both paths, and the offer reveal)
/// rendered blank on iPad while every surface that applied the column outside
/// a scroll view was fine. A GeometryReader in the BACKGROUND is the idiom
/// that measures without laying out: it takes no part in the height (so the
/// composer's safe-area inset is unaffected — the bug before this one), and
/// inside a vertical ScrollView the proposed width is the viewport's, which is
/// exactly the measure the 88% rule wants.
private struct ProportionalWidth: ViewModifier {
    let active: Bool
    let fraction: CGFloat
    let fallback: CGFloat
    @State private var available: CGFloat = 0
    func body(content: Content) -> some View {
        content
            .frame(maxWidth: active && available > 0 ? available * fraction : fallback)
            .frame(maxWidth: .infinity)
            .background(
                GeometryReader { geo in
                    Color.clear
                        .onAppear { available = geo.size.width }
                        .onChange(of: geo.size.width) { _, w in available = w }
                }
            )
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

    /// 1.32, up from 1.18.
    ///
    /// The old note argued that past ~1.2 the proportions read as an
    /// accessibility setting. That reasoning held the type to phone
    /// proportions in a container twice the size, and the result was the
    /// complaint: small type, floating in a wide screen. VIEWING DISTANCE is
    /// the missing term — an iPad is held further away than a phone, so
    /// matching apparent size needs more than a token bump.

    var body: some View {
        GeometryReader { geo in
            ScrollView(showsIndicators: showsIndicators) {
                // NOT `.conversionColumn(width)` here. That modifier now sizes
                // with `containerRelativeFrame`, and inside a ScrollView that
                // is itself inside this GeometryReader the container width
                // resolves to nothing — PaywallView and the offer reveal, the
                // two surfaces built on this scroll, rendered BLANK on iPad
                // (only the close button, which sits outside the scroll,
                // survived). The phone was untouched because the rule is
                // compact-gated. This container already knows its width, so it
                // applies the same 88% fill directly.
                content()
                    .frame(maxWidth: hSize == .regular
                           ? geo.size.width * ConversionColumn.padFill
                           : width)
                    .frame(maxWidth: .infinity)
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

    /// A CONTROL's height, scaled with the type.
    ///
    /// Type and spacing scaled; hit targets did not, so an iPad rendered larger
    /// labels inside phone-sized buttons — the "buttons still phone-sized"
    /// read. A touch target is not a typographic quantity, but it is a physical
    /// one, and the reason type grows here (a tablet is held further away, on a
    /// desk or a lap) applies to the thing you have to hit at least as much.
    ///
    /// At the 1.32 factor a 50pt phone button becomes 66pt, inside the 64-72pt
    /// range a tablet control wants.
    func cControl(_ base: CGFloat) -> some View {
        modifier(ConversionControl(base: base))
    }

    /// A CAPPED SEAM, scaled for the container.
    ///
    /// The caps exist so slack is shared between the gaps instead of pooling in
    /// whichever comes first. Fixed at phone values they under-share on a
    /// tablet: a 1376pt portrait iPad has far more slack than three 46pt caps
    /// can absorb, and the remainder lands as one void under the content — the
    /// dead space measured at 660pt. Scaling the caps keeps the rule and lets
    /// them take a tablet-sized share. 3x on top of the type factor, because
    /// the surplus grows with the screen, not with the type.
    func cSeam(_ base: CGFloat) -> some View {
        modifier(ConversionSeam(base: base))
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

private struct ConversionControl: ViewModifier {
    let base: CGFloat
    @Environment(\.conversionScale) private var scale
    func body(content: Content) -> some View {
        content.frame(height: (base * scale).rounded())
    }
}

private struct ConversionSeam: ViewModifier {
    let base: CGFloat
    @Environment(\.conversionScale) private var scale
    func body(content: Content) -> some View {
        content.frame(maxHeight: (base * scale).rounded())
    }
}

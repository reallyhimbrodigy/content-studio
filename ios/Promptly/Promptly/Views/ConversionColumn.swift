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
                // THE SYMMETRY RULE (2026-09-05). `minHeight: container` let the
                // phone layout's single trailing Spacer stretch on a much taller
                // iPad, which pinned the CTA to the bottom and opened a 300–1100pt
                // hole in the middle of six screens. Empty space is fine; a hole
                // with content jammed against both edges is not.
                //
                // On regular width the content is held to its intrinsic height
                // (fixedSize collapses that internal Spacer to its minimum) and
                // centred between two equal Spacers, so the slack splits into
                // near-equal top and bottom bands. Compact is untouched — the
                // phone still pushes its CTA to the thumb zone, which is right
                // there and wrong here.
                VStack(spacing: 0) {
                    if hSize == .regular { Spacer(minLength: 0) }
                    content()
                        .frame(maxWidth: hSize == .regular
                               ? geo.size.width * ConversionColumn.padFill
                               : width)
                        .frame(maxWidth: .infinity)
                    if hSize == .regular { Spacer(minLength: 0) }
                }
                    .frame(minHeight: geo.size.height)
            }
        }
    }
}


/// `fixedSize(vertical:)` only where it is wanted. Applied unconditionally it
/// would collapse legitimately-scrolling content on a phone; applied on regular
/// width it is what stops an internal Spacer from stretching into a hole.
private struct IntrinsicHeightOnRegular: ViewModifier {
    let active: Bool
    func body(content: Content) -> some View {
        if active { content.fixedSize(horizontal: false, vertical: true) }
        else { content }
    }
}

/// THE SYMMETRY RULE, as a modifier (2026-09-05).
///
/// These surfaces are `ZStack { Color.black; content }`, and a ZStack CENTRES
/// its children. On a phone the content fills the screen so that is invisible.
/// On an iPad the same content is short, its trailing Spacer stretches to the
/// full container, and the CTA gets pinned to the bottom edge — one hole in the
/// middle, content jammed against both edges. Holding the content to a
/// phone-ish height lets the ZStack do what it already does: centre it, so the
/// slack becomes near-equal bands top and bottom.
///
/// Compact is untouched: the phone still pushes its CTA into the thumb zone,
/// which is right there and wrong on a 13-inch screen.
struct SymmetricHeightOnRegular: ViewModifier {
    @Environment(\.horizontalSizeClass) private var hSize
    let cap: CGFloat
    func body(content: Content) -> some View {
        if hSize == .regular {
            // INTRINSIC HEIGHT, not a cap. A cap still lets the internal
            // Spacers stretch inside it, which just makes a smaller hole.
            // fixedSize collapses them to their minLength, so the block is its
            // natural height and the parent ZStack centres it — equal bands,
            // no hole. Capped as a backstop so content taller than the screen
            // cannot overflow off the top and bottom.
            content
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxHeight: cap)
        } else { content }
    }
}

extension View {
    func symmetricHeightOnRegular(_ cap: CGFloat = 900) -> some View {
        modifier(SymmetricHeightOnRegular(cap: cap))
    }
}

/// THE THREAD FILLS ITS COLUMN ON IPAD (ruled 2026-09-05).
///
/// Phone caps stop a line of text running the whole screen. On an iPad the same
/// caps left the entire conversation — the finished video, the caption block,
/// the assistant message, Share — inside a ~430pt column with 60% of the screen
/// empty, while the composer (which does scale) spanned ~770pt. k reached the
/// composer and stopped at the thread.
///
/// On regular width these fill the conversation column, which is itself 88% of
/// the container — the same content width every other screen uses. Compact
/// keeps the phone cap exactly, because there the cap is right.
/// THE CHAT THREAD GETS ITS OWN RULE (ruled 2026-09-05).
/// Everything else on iPad is 88% of the container. A conversation is not a
/// form: at 88% of a 13-inch landscape screen a line of message text runs
/// ~1210pt and stops being readable. The thread is capped at 820pt and CENTRED;
/// the composer and the empty-state rows stay full width.
enum ThreadColumn {
    static let maxWidth: CGFloat = 820
    /// The bubble's own horizontal padding, so the media box lines up with the
    /// text above it rather than overhanging.
    static let videoInset: CGFloat = 48
    /// One media height for BOTH states — the render container and the finished
    /// video — so the transition from in-progress to result does not jump.
    static let videoHeight: CGFloat = 480
}

/// An action pill on iPad: capsule behind it, an equal share of the row.
/// A placeholder that is 9:16 on a phone and shapeless on iPad, where the
/// media box's own 772x480 frame decides the shape.
/// A FITTED IMAGE OVER A BLURRED FILL OF ITSELF (ruled 2026-09-05).
///
/// The media box is 772x480 landscape; the footage is 1080x1920 portrait.
/// `.fill` cropped the subject's head off, `.fit` would letterbox onto flat
/// black. This does what every video app does with mismatched aspect: the frame
/// is fitted whole, and the empty sides are a blurred, enlarged copy of the same
/// frame — so the box is full, nothing is cropped, and the colour comes from the
/// footage rather than a black bar.
struct BlurredFillImage: View {
    let image: Image
    var blur: CGFloat = 28
    var body: some View {
        // BOTH LAYERS ARE SIZED EXPLICITLY. In a bare ZStack the stack takes its
        // size from the FITTED child, so the "fill" layer was handed the same
        // letterboxed box and never covered the sides — the box rendered with
        // black bars. GeometryReader hands each layer the container's real size,
        // so the fill genuinely overflows and is clipped.
        GeometryReader { geo in
            ZStack {
                image
                    .resizable()
                    .scaledToFill()
                    .frame(width: geo.size.width, height: geo.size.height)
                    .clipped()
                    .blur(radius: blur, opaque: true)
                    .overlay(Color.black.opacity(0.28))
                image
                    .resizable()
                    .scaledToFit()
                    .frame(width: geo.size.width, height: geo.size.height)
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }
}

struct MediaBoxAspect: ViewModifier {
    let regular: Bool
    func body(content: Content) -> some View {
        if regular { content } else { content.aspectRatio(9/16, contentMode: .fit) }
    }
}

struct ThreadPillChrome: ViewModifier {
    let active: Bool
    func body(content: Content) -> some View {
        if active {
            content
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity)
                .background(Capsule().fill(Color.white.opacity(0.07)))
                .overlay(Capsule().stroke(Color.white.opacity(0.10), lineWidth: 0.5))
        } else { content }
    }
}

extension View {
    func threadPillChrome(_ active: Bool) -> some View { modifier(ThreadPillChrome(active: active)) }
}

struct ThreadFill: ViewModifier {
    @Environment(\.horizontalSizeClass) private var hSize
    let phoneCap: CGFloat
    let alignment: Alignment
    func body(content: Content) -> some View {
        content.frame(maxWidth: hSize == .regular ? .infinity : phoneCap, alignment: alignment)
    }
}

extension View {
    func threadFill(_ phoneCap: CGFloat, alignment: Alignment = .leading) -> some View {
        modifier(ThreadFill(phoneCap: phoneCap, alignment: alignment))
    }
    /// The finished video: fills the column and is never smaller than 480pt tall
    /// on an iPad, where a 384pt cap read as a phone screenshot pasted in.
    func threadVideo(_ phoneCap: CGFloat) -> some View {
        modifier(ThreadVideo(phoneCap: phoneCap))
    }
}

struct ThreadVideo: ViewModifier {
    @Environment(\.horizontalSizeClass) private var hSize
    let phoneCap: CGFloat
    func body(content: Content) -> some View {
        if hSize == .regular {
            // THE SAME BOX AS THE RENDER CONTAINER ABOVE IT, so the transition
            // from in-progress to finished does not jump. The content fills and
            // is clipped rather than letterboxed — the inner views declare a
            // 9:16 `.fit`, which inside this box would letterbox to a narrow
            // strip and reintroduce the phone outline this replaced.
            // No outer scaledToFill: BlurredFillImage already composes the
            // fitted frame over its own blurred fill, and forcing the whole
            // stack to fill would crop the fitted layer straight back off.
            content
                .frame(width: ThreadColumn.maxWidth - ThreadColumn.videoInset,
                       height: ThreadColumn.videoHeight)
                .clipped()
        } else { content.frame(maxWidth: phoneCap) }
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

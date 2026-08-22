import SwiftUI

/// Item 8 (the standing "make it feel alive" half) — ONE entrance vocabulary
/// for static SwiftUI surfaces, so screens assemble instead of popping on.
///
/// The recipe follows the house motion laws learned the hard way:
///   - SMALL travel (12pt rise) that DECELERATES into rest (.easeOut) — arrival
///     reads as settling, never ballistic.
///   - Single-shot: animates once on appear, then completely static (the idle
///     motion that read as "shaking" stays dead).
///   - Staggerable via `delay` so sibling blocks cascade (~60-90ms steps), which
///     is what makes a screen read as composed rather than switched on.
///   - Reduce Motion: fade only, at identity position (WCAG 2.1 SC 2.3.3).
///
/// Usage: `.entrance()` or `.entrance(delay: 0.08)`. Deliberately NOT applied
/// to the caption text layer (frame-1-is-final is a caption law) — this is for
/// app chrome: paywalls, heroes, walls, grids.
struct EntranceReveal: ViewModifier {
    var delay: Double = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var revealed = false

    func body(content: Content) -> some View {
        content
            .opacity(revealed ? 1 : 0)
            .offset(y: revealed || reduceMotion ? 0 : 12)
            .onAppear {
                withAnimation(.easeOut(duration: 0.42).delay(delay)) {
                    revealed = true
                }
            }
    }
}

extension View {
    /// The house entrance: rise 12pt + fade, 420ms ease-out, then static.
    func entrance(delay: Double = 0) -> some View {
        modifier(EntranceReveal(delay: delay))
    }
}

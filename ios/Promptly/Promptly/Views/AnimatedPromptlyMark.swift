import SwiftUI

/// The Promptly brand mark with the LaunchView entrance, extracted as a
/// reusable component so premium surfaces carry the product's own brand
/// instead of a generic system glyph (the paywall wore a crown.fill — a
/// paywall that doesn't carry the brand reads as a system dialog, not a
/// premium offer).
///
/// Motion is the proven LaunchView recipe, verbatim: one zoom-in
/// (scale 0.35 → 1.0) while blur clears (10 → 0) and opacity rises, 520ms
/// .easeOut so it decelerates as it arrives — then COMPLETELY static. No
/// bob, no pulse, no breath (the idle motion read as "shaking" and was
/// deliberately killed). The ambient halo is scaled to the mark.
///
/// Reduce Motion (WCAG 2.1 SC 2.3.3): skip the zoom; fade in at identity
/// scale. Same end state, no kinetic surprise.
struct AnimatedPromptlyMark: View {
    /// Rendered logo width/height. The halo scales at ~3.1x, matching
    /// LaunchView's 168 → 520 ratio.
    var size: CGFloat = 72
    /// Ambient radial halo behind the mark (screen blend). On for dark
    /// hero placements (paywall header); off where a flat mark is wanted.
    var halo: Bool = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var logoScale: CGFloat = 0.35
    @State private var logoOpacity: Double = 0
    @State private var logoBlur: CGFloat = 10
    @State private var glowOpacity: Double = 0

    var body: some View {
        ZStack {
            if halo {
                RadialGradient(
                    colors: [Color.white.opacity(0.22), Color.white.opacity(0.0)],
                    center: .center,
                    startRadius: 0,
                    endRadius: size * 1.55
                )
                .frame(width: size * 3.1, height: size * 3.1)
                .opacity(glowOpacity)
                .blendMode(.screen)
                .allowsHitTesting(false)
            }

            Image("PromptlyLogo")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
                .scaleEffect(logoScale)
                .opacity(logoOpacity)
                .blur(radius: logoBlur)
        }
        // The halo overflows the logo frame by design; keep layout stable
        // for siblings by claiming only the logo's own footprint.
        .frame(width: size, height: size)
        .task {
            if reduceMotion {
                logoScale = 1.0
                logoBlur = 0
                withAnimation(.easeOut(duration: 0.32)) {
                    logoOpacity = 1
                    glowOpacity = 0.22
                }
                return
            }
            withAnimation(.easeOut(duration: 0.52)) {
                logoScale = 1.0
                logoOpacity = 1
                logoBlur = 0
                glowOpacity = 0.22
            }
        }
    }
}

import SwiftUI

/// App-wide design tokens. Every screen pulls from here so visual
/// language stays consistent — when one surface drifts (different
/// padding, different radius, different label weight), it's because
/// the screen wasn't using the token system. Never inline magic
/// numbers for spacing/radius/typography elsewhere; add the token
/// here first, then reference it.
enum Theme {

    // MARK: - Spacing scale
    //
    // Use the closest token below; never invent intermediate values.
    // The 8pt rhythm + a couple of tighter values for label/control
    // groups gives a consistent visual cadence across screens.

    enum Space {
        static let xxs: CGFloat = 4
        static let xs: CGFloat = 8
        static let sm: CGFloat = 12
        static let md: CGFloat = 16
        static let lg: CGFloat = 20
        static let xl: CGFloat = 24
        static let xxl: CGFloat = 32
    }

    // MARK: - Corner radii
    //
    // 10 chips/badges → 14 inputs/buttons → 20 cards/bubbles. Going
    // tighter than 10 looks brittle; going larger than 20 starts
    // feeling toylike for primary surfaces.

    enum Radius {
        static let sm: CGFloat = 10
        static let md: CGFloat = 14
        static let lg: CGFloat = 20
    }

    // MARK: - Typography ramp
    //
    // SF Pro at the named iOS sizes. Bold reserved for nav titles
    // only; everything below uses regular/medium/semibold so the
    // hierarchy reads as weight, not size.

    enum Font {
        static let caption = SwiftUI.Font.system(size: 11, weight: .medium)
        static let footnote = SwiftUI.Font.system(size: 13, weight: .regular)
        static let body = SwiftUI.Font.system(size: 15, weight: .regular)
        static let bodyMedium = SwiftUI.Font.system(size: 15, weight: .medium)
        static let callout = SwiftUI.Font.system(size: 17, weight: .regular)
        static let calloutSemibold = SwiftUI.Font.system(size: 17, weight: .semibold)
        static let title3 = SwiftUI.Font.system(size: 22, weight: .semibold)
        static let title1 = SwiftUI.Font.system(size: 28, weight: .bold)
        /// Section header treatment used on every list. 11pt semibold,
        /// uppercased, tracked +0.6, secondary label color.
        static let sectionHeader = SwiftUI.Font.system(size: 11, weight: .semibold)
    }

    // MARK: - Surfaces
    //
    // Three-step surface ladder for layering on dark mode. surface1
    // is the page background's nearest sibling (cards on the page);
    // surface2 is content one step deeper (chips on a card);
    // surface3 is the deepest (input field on a chip).

    enum Surface {
        static let page = Color(.systemBackground)
        static let surface1 = Color(.secondarySystemBackground)
        static let surface2 = Color(.tertiarySystemBackground)
        static let surface3 = Color(.tertiarySystemFill)
    }

    // MARK: - Hairline border

    enum Border {
        static let hairline = Color(.separator).opacity(0.5)
        static let focused = Color.white.opacity(0.35)
    }
}

// MARK: - Section header view modifier

extension View {
    /// Apply the global section-header treatment. Tracked, uppercased,
    /// 11pt semibold, secondary label color — used everywhere a list
    /// has a section break so they all read identically.
    func sectionHeaderStyle() -> some View {
        self
            .font(Theme.Font.sectionHeader)
            .foregroundColor(.secondary)
            .textCase(.uppercase)
            .tracking(0.6)
    }
}

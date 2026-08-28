import SwiftUI
import RevenueCat

/// OFFER REVEAL — the last beat of onboarding v2, after the three questions.
///
/// THE CONSTRAINT THIS SCREEN LIVES UNDER: Apple applies whatever introductory
/// offer the account is eligible for at ITS OWN sheet, regardless of anything
/// we draw. So this screen is PRESENTATION, not entitlement — and screen one
/// (the full-price paywall) simply doesn't mention a discount, which is why
/// the reveal can land as news rather than as a correction.
///
/// Honesty rules, enforced structurally:
///   • The intro price is read live from the product's own
///     `introductoryDiscount` (StoreKit via RevenueCat). Never hardcoded,
///     never computed by us.
///   • Free-trial offers are ignored outright (freemium law: no trial copy).
///   • If NO paid intro offer exists on any package, this screen does not
///     render at all — the flow goes straight to the picker. We never invent
///     a discount to have something to reveal.
///   • Real scarcity only: no countdown, no "limited time". The only true
///     urgency is that the offer applies to a first subscription.
///   • The escape hatch is a text link ("Decline offer"), never an X — the
///     user must be able to leave, and must not be able to leave by accident.
struct OfferRevealView: View {
    let onDecline: () -> Void
    let onPurchased: () -> Void

    @ObservedObject private var subscription = SubscriptionService.shared
    @ObservedObject private var onboarding = OnboardingState.shared
    @State private var isPurchasing = false

    private var packages: [Package] {
        SubscriptionService.sortedByDuration(subscription.offerings?.current?.availablePackages ?? [])
    }

    /// The package whose product actually carries a PAID intro offer. Nil →
    /// nothing to reveal (see `OfferReveal.isAvailable`).
    private var offerPackage: Package? { OfferReveal.package(in: packages) }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            ScrollView(showsIndicators: false) {
                VStack(spacing: 0) {
                    Spacer().frame(height: 76)

                    AnimatedPromptlyMark(size: 72, halo: true)
                        .padding(.bottom, 22)

                    Text(String(localized: "Your first subscription is half price"))
                        .font(.system(size: 28, weight: .bold))
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .minimumScaleFactor(0.85)
                        .padding(.horizontal, 28)

                    if let pkg = offerPackage {
                        priceBlock(pkg).padding(.top, 22)
                    }

                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(OfferReveal.benefitLines(audience: onboarding.v2Audience,
                                                         videoType: onboarding.v2VideoType), id: \.self) { line in
                            HStack(spacing: 14) {
                                ZStack {
                                    Circle().fill(Color.white).frame(width: 24, height: 24)
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 11, weight: .heavy))
                                        .foregroundColor(.black)
                                }
                                Text(line)
                                    .font(.system(size: 16, weight: .medium))
                                    .foregroundColor(.white)
                                Spacer()
                            }
                        }
                    }
                    .padding(.horizontal, 28)
                    .padding(.top, 28)

                    Button {
                        guard let pkg = offerPackage else { return }
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        isPurchasing = true
                        Task {
                            let ok = await subscription.purchase(pkg, context: "offer_reveal")
                            isPurchasing = false
                            if ok { onPurchased() }
                        }
                    } label: {
                        Group {
                            if isPurchasing { ProgressView().tint(.black) }
                            else { Text(String(localized: "Claim half price")).font(.system(size: 17, weight: .bold)) }
                        }
                        .foregroundColor(.black)
                        .frame(maxWidth: .infinity).frame(height: 56)
                        .background(Color.white, in: Capsule())
                    }
                    .disabled(offerPackage == nil || isPurchasing)
                    .padding(.horizontal, 24)
                    .padding(.top, 32)

                    // The escape hatch: a text link, never an X (an X invites
                    // an accidental dismissal of a one-time reveal).
                    Button {
                        Analytics.track("offer_reveal_declined", props: ["context": "onboarding_v2"])
                        onDecline()
                    } label: {
                        Text(String(localized: "Decline offer"))
                            .font(.system(size: 14, weight: .medium))
                            .foregroundColor(.white.opacity(0.6))
                    }
                    .padding(.top, 18)

                    Text(TrialCopy.fineprint)
                        .font(.system(size: 11))
                        .foregroundColor(.white.opacity(0.4))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .padding(.top, 16)
                        .padding(.bottom, 40)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .onAppear {
            Analytics.track("offer_reveal_viewed",
                            props: ["context": "onboarding_v2",
                                    "has_offer": offerPackage != nil,
                                    "audience": onboarding.v2Audience ?? "skipped",
                                    "video_type": onboarding.v2VideoType ?? "skipped"])
        }
    }

    /// Struck-through standard price beside the live intro price. Both strings
    /// come from the store; we format neither.
    private func priceBlock(_ pkg: Package) -> some View {
        VStack(spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(pkg.storeProduct.localizedPriceString)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(.white.opacity(0.5))
                    .strikethrough(true, color: .white.opacity(0.5))
                if let intro = pkg.storeProduct.introductoryDiscount?.localizedPriceString {
                    Text(intro)
                        .font(.system(size: 34, weight: .heavy))
                        .foregroundColor(.white)
                }
            }
            Text(OfferReveal.termLine(for: pkg))
                .font(.system(size: 13))
                .foregroundColor(.white.opacity(0.65))
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 28)
    }
}

// MARK: - Offer reveal data (testable, view-free)

enum OfferReveal {
    /// The first package carrying a PAID introductory offer. Free-trial offers
    /// are excluded by the freemium law, so a trial-only product reads as "no
    /// offer" and the reveal is skipped entirely.
    static func package(in packages: [Package]) -> Package? {
        packages.first { pkg in
            guard let d = pkg.storeProduct.introductoryDiscount else { return false }
            return d.paymentMode != .freeTrial
        }
    }

    /// True when there is something real to reveal. The flow consults this —
    /// no offer means the beat is skipped, never faked.
    static func isAvailable(in packages: [Package]) -> Bool { package(in: packages) != nil }

    /// "Then <standard>/month — cancel anytime" style line, entirely from the
    /// store's own strings. Real scarcity only: the honest constraint is that
    /// the intro price applies to a first subscription, which we say plainly.
    static func termLine(for pkg: Package) -> String {
        let standard = pkg.storeProduct.localizedPriceString
        switch pkg.packageType {
        case .annual:  return String(localized: "for your first year, then \(standard)/year")
        case .monthly: return String(localized: "for your first month, then \(standard)/month")
        case .weekly:  return String(localized: "for your first week, then \(standard)/week")
        default:       return String(localized: "for your first term, then \(standard)")
        }
    }

    /// Benefits in the user's OWN terms, from Q1 (who for) and Q2 (what kind).
    /// Falls back to the approved generic claims when a question was skipped.
    static func benefitLines(audience: String?, videoType: String?) -> [String] {
        var lines: [String] = []
        switch videoType {
        case "podcast":     lines.append(String(localized: "Every episode into clips, unlimited"))
        case "talkinghead": lines.append(String(localized: "Every take into a finished cut, unlimited"))
        case "vlogs":       lines.append(String(localized: "Every vlog cut and captioned, unlimited"))
        case "promo":       lines.append(String(localized: "Every promo cut and captioned, unlimited"))
        default:            lines.append(String(localized: "Unlimited renders"))
        }
        switch audience {
        case "clients":        lines.append(String(localized: "Turn around client work the same day"))
        case "small_business": lines.append(String(localized: "Keep your business posting without an editor"))
        case "employer":       lines.append(String(localized: "Ship team video without a production queue"))
        default:               lines.append(String(localized: "Re-edit any finished video"))
        }
        lines.append(String(localized: "Save and share every video"))
        lines.append(String(localized: "Upload up to 10 videos at a time"))
        return lines
    }
}

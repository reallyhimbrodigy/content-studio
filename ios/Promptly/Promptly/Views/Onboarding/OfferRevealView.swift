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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isPurchasing = false
    /// The price is the payload of this screen. It LANDS — settles in with
    /// weight a beat after the headline — rather than simply being present
    /// when the screen appears.
    @State private var priceLanded = false
    /// Drives the badge's breathing glow (see `oneTimeBadge`).
    @State private var glowing = false

    private var packages: [Package] {
        SubscriptionService.sortedByDuration(subscription.offerings?.current?.availablePackages ?? [])
    }

    /// The package whose product actually carries a PAID intro offer. Nil →
    /// nothing to reveal (see `OfferReveal.isAvailable`).
    /// The plan the user is already leaning on — the same computed
    /// pre-selection the paywall uses, so the reveal never switches them.
    private var preferredPackage: Package? { OfferReveal.preferredPackage(in: packages) }
    private var offerPackage: Package? {
        OfferReveal.package(in: packages, preferring: preferredPackage)
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            ScrollView(showsIndicators: false) {
                VStack(spacing: 0) {
                    Spacer().frame(height: 76)

                    AnimatedPromptlyMark(size: 72, halo: true)
                        .padding(.bottom, 22)

                    // Personalised lead, ABOVE the discount headline and never
                    // inside it — the headline is a money claim guarded by the
                    // banned-percentage gate, and user-derived text has no
                    // business inside the one sentence that must say exactly
                    // what the store says. Nil when the questions were skipped
                    // (most users), and nil means it simply is not drawn: a
                    // generic "For your videos" would read as personalisation
                    // that failed, which is worse than none.
                    if onboarding.paywallPersonalizationEnabled,
                       let lead = PaywallPersonalization.lead(audience: onboarding.v2Audience,
                                                               videoType: onboarding.v2VideoType) {
                        Text(lead)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(.white.opacity(0.6))
                            .multilineTextAlignment(.center)
                            .padding(.bottom, 4)
                    }

                    Text(offerPackage.map { OfferReveal.headline(for: $0) }
                         ?? String(localized: "Your first subscription"))
                        .font(.system(size: 28, weight: .bold))
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .minimumScaleFactor(0.85)
                        .padding(.horizontal, 28)

                    if offerPackage != nil {
                        oneTimeBadge.padding(.top, 18)
                    }

                    if let pkg = offerPackage {
                        priceBlock(pkg)
                            .padding(.top, 22)
                            .scaleEffect(priceLanded || reduceMotion ? 1 : 0.88)
                            .opacity(priceLanded ? 1 : 0)
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
                            else { Text(offerPackage.map { OfferReveal.ctaLabel(for: $0) }
                                        ?? String(localized: "Continue"))
                                        .font(.system(size: 17, weight: .bold)) }
                        }
                        .foregroundColor(.black)
                        .frame(maxWidth: .infinity).frame(height: 56)
                        .background(Color.white, in: Capsule())
                    }
                    .buttonStyle(OnboardingPressStyle(reduceMotion: reduceMotion))
                    .disabled(offerPackage == nil || isPurchasing)
                    .padding(.horizontal, 24)
                    .padding(.top, 32)

                    // SECONDARY PLAN LINE. The yearly stays the hero; this
                    // offers the monthly intro to someone who will not commit
                    // to a year. It sits BELOW the primary CTA and ABOVE
                    // "Decline offer" — a real alternative, not an equal, and
                    // never louder than the plan being sold.
                    secondaryMonthlyLine

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

                    // The auto-renew disclosure. Spacing is tighter than the
                    // rest of the screen on purpose: in German this line wraps
                    // to two lines where English and Hindi take one, and at the
                    // old 16/40 padding the second line sat below the fold at
                    // the default scroll position. It was still reachable by
                    // scrolling, but a required disclosure should not depend on
                    // the user scrolling to find it in one language and not
                    // another. Measured on the longest of the twelve.
                    Text(TrialCopy.fineprint)
                        .font(.system(size: 11))
                        .foregroundColor(.white.opacity(0.4))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 24)
                        .padding(.top, 12)
                        .padding(.bottom, 28)
                }
                // Root cause of the whole surface's iPad stretch: this was the
                // only width bound on the reveal column.
                .conversionColumn()
            }
        }
        .onAppear {
            // Render-caught 2026-08-27: with no offer on any package this
            // screen showed a discount headline, no price, and a DISABLED
            // CTA — a promise it could not keep. If offerings have settled
            // and carry no paid intro offer, leave immediately; the flow
            // treats that exactly like a decline (straight to the picker).
            if !subscription.isLoadingOfferings, offerPackage == nil {
                Analytics.track("offer_reveal_skipped",
                                props: ["context": "onboarding_v2", "reason": "no_offer_at_render"])
                onDecline()
                return
            }
            // The landing is the whole point of the beat, so it runs on a
            // short delay after the screen settles — and is a plain fade
            // under Reduce Motion.
            withAnimation(reduceMotion
                          ? OnboardingMotion.reduced
                          : .spring(response: 0.5, dampingFraction: 0.72).delay(0.12)) {
                priceLanded = true
            }
            #if DEBUG
            for p in packages {
                let d = p.storeProduct.introductoryDiscount
                print("[offerDiag] \(p.packageType) std=\(p.storeProduct.price) intro=\(d.map { "\($0.price) mode=\($0.paymentMode.rawValue)" } ?? "NONE") real=\(OfferReveal.isRealOffer(p))")
            }
            print("[offerDiag] preferred=\(String(describing: preferredPackage?.packageType)) chosen=\(String(describing: offerPackage?.packageType))")
            #endif
            Analytics.track("offer_reveal_viewed",
                            props: ["context": "onboarding_v2",
                                    "has_offer": offerPackage != nil,
                                    "audience": onboarding.v2Audience ?? "skipped",
                                    "video_type": onboarding.v2VideoType ?? "skipped"])
        }
    }

    /// "ONE TIME OFFER" — literally true, which is the only reason it passes
    /// the fake-scarcity ban: Apple enforces introductory-offer eligibility
    /// once per account, so this is a statement of fact, not manufactured
    /// urgency. No deadline is claimed anywhere, because we do not control
    /// one; the honest scarcity is the eligibility itself.
    ///
    /// The glow BREATHES (a slow opacity/blur pulse) rather than sitting
    /// static, so it reads as the most alive thing on screen — but it is
    /// deliberately slower and lower-contrast than the price landing, so it
    /// never competes with the number it is introducing. Reduce Motion gets
    /// the badge with a fixed glow and no pulse.
    /// The monthly alternative, or NOTHING.
    ///
    /// Both the price and the percentage are read live from the monthly
    /// product's own `introductoryDiscount` and floored — never typed, never
    /// derived from the yearly. If the monthly package is absent, carries no
    /// paid intro offer, or its intro is not genuinely cheaper in this
    /// territory, this renders NOTHING rather than falling back to a default.
    /// A default here would be a price claim we did not read from the store,
    /// which is the one thing this screen must never do — and a wrong second
    /// price is worse than no second price, because it is the line a hesitant
    /// user is most likely to act on.
    @ViewBuilder
    private var secondaryMonthlyLine: some View {
        if let m = monthlyAlternative,
           let intro = m.storeProduct.introductoryDiscount,
           let pct = OfferReveal.percentOff(for: m) {
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                isPurchasing = true
                Task {
                    let ok = await subscription.purchase(m, context: "offer_reveal_secondary")
                    isPurchasing = false
                    if ok { onPurchased() }
                }
            } label: {
                // Price string comes from StoreKit's own formatter — we never
                // compose a currency string ourselves.
                //
                // ONE key, not fragments. This line used to be assembled from
                // "Or start monthly for" + price + "(" + pct + "% " + "off" + ")",
                // which is unlocalizable: every language puts the price, the
                // number and the discount word in a different order, and Arabic
                // and Urdu reverse the run direction around the parenthetical.
                // A translator handed the fragment "off" has no sentence to
                // place it in. Interpolated as a whole sentence, the translator
                // moves %@ and %lld wherever their grammar needs them.
                Text(String(localized: "Or start monthly for \(intro.localizedPriceString) (\(pct)% off)"))
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(.white.opacity(0.75))
                    .underline()
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .buttonStyle(OnboardingPressStyle(reduceMotion: reduceMotion))
            .disabled(isPurchasing)
            .padding(.top, 16)
            .padding(.horizontal, 24)
        }
    }

    /// The monthly package, only when it carries a genuinely cheaper paid
    /// intro AND is not already the plan being sold above.
    private var monthlyAlternative: Package? {
        guard offerPackage?.packageType != .monthly else { return nil }
        guard let m = packages.first(where: { $0.packageType == .monthly }) else { return nil }
        return OfferReveal.isRealOffer(m) ? m : nil
    }

    private var oneTimeBadge: some View {
        Text(String(localized: "ONE TIME OFFER"))
            .font(.system(size: 12, weight: .heavy))
            .tracking(1.4)
            .foregroundColor(.black)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(
                Capsule().fill(Color.white)
                    .shadow(color: .white.opacity(reduceMotion ? 0.45 : glowStrength),
                            radius: reduceMotion ? 10 : glowRadius)
                    .shadow(color: .white.opacity(reduceMotion ? 0.2 : glowStrength * 0.5),
                            radius: reduceMotion ? 18 : glowRadius * 2.2)
            )
            .onAppear {
                guard !reduceMotion else { return }
                // 0.85s, not 1.6s. At 1.6 the pulse was slower than a resting
                // breath and read as ambient light rather than as something
                // live — you had to watch the badge to notice it moving at all.
                withAnimation(.easeInOut(duration: 0.85).repeatForever(autoreverses: true)) {
                    glowing = true
                }
            }
    }
    // Trough-to-peak is what makes a pulse legible in peripheral vision, and it
    // was 0.3->0.75 (2.5x) on a 7->16pt radius: too narrow to catch the eye
    // beside a large price. Now ~7x on opacity and ~5x on radius, so the badge
    // is the second thing seen after the number without ever being brighter
    // than it.
    private var glowStrength: Double { glowing ? 0.95 : 0.14 }
    private var glowRadius: CGFloat { glowing ? 22 : 4 }

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
    ///
    /// ANNUAL FALL-THROUGH — HELD PENDING ZAC'S RULING (2026-08-27). Offers
    /// are configured on MONTHLY only (175 territories; Yearly and Weekly
    /// have none). Today an annual-leaning user therefore falls through to
    /// the monthly offer: a real, honestly-priced offer, but a plan switch.
    /// If the ruling is "don't switch their plan", THIS is the one seam to
    /// change — take the pre-selected package as a parameter and return nil
    /// when it carries no offer, which routes into the same graceful skip as
    /// no-offer-at-all (the view's onAppear guard). Behaviour is unchanged
    /// until then; nothing here is dead code.
    /// `preferred` is the plan the user is already leaning on (the paywall's
    /// computed pre-selection). Yearly offers now exist in all 175
    /// territories, so an annual-leaning user must see the ANNUAL offer —
    /// never be switched to a monthly one. Falls back to any offered plan
    /// only when the preferred one carries none.
    @MainActor
    static func package(in packages: [Package], preferring preferred: Package? = nil) -> Package? {
        if let preferred, isRealOffer(preferred) { return preferred }
        return packages.first(where: isRealOffer)
    }

    /// An offer is REAL only if it is a paid offer that is genuinely CHEAPER
    /// than the standard price.
    ///
    /// That last clause is not paranoia: the 2026-08-27 territory sweep found
    /// Indonesia's yearly intro configured at 17,499,000 IDR against a
    /// 3,499,000 standard — an "offer" 5x the regular price, from a digit
    /// shift in ASC. Without this guard the reveal would have shown an
    /// Indonesian user a struck-through 3,499,000 beside a larger "discount"
    /// price. A store-side typo must never become a client-side lie.
    @MainActor
    static func isRealOffer(_ pkg: Package) -> Bool {
        guard let d = pkg.storeProduct.introductoryDiscount,
              d.paymentMode != .freeTrial else { return false }
        // ELIGIBILITY, checked per Apple ID (2026-08-30).
        //
        // introductoryDiscount describes the PRODUCT. Apple grants one intro
        // offer per Apple ID per subscription group, permanently — so a
        // returning user who already used theirs is charged FULL PRICE at the
        // sheet regardless of what we draw. Without this check the reveal
        // showed "49% off · $145.99" to someone Apple then charged $289.99.
        //
        // It sits HERE because every claim on this screen — the headline
        // percentage, the struck price, the CTA label, the secondary monthly
        // line, and whether the reveal renders at all — already flows through
        // isRealOffer. One choke point means a new claim cannot be added that
        // forgets to ask.
        guard SubscriptionService.shared.isEligibleForIntro(pkg.storeProduct) else { return false }
        return (d.price as NSDecimalNumber).doubleValue
             < (pkg.storeProduct.price as NSDecimalNumber).doubleValue
    }

    /// True when there is something real to reveal. The flow consults this —
    /// no offer means the beat is skipped, never faked.
    @MainActor
    static func isAvailable(in packages: [Package], preferring preferred: Package? = nil) -> Bool {
        package(in: packages, preferring: preferred) != nil
    }

    /// The plan the user actually pre-selected on the paywall, resolved back to
    /// a live Package; the default selection when they never saw a paywall.
    ///
    /// This is the ONE resolver. OnboardingV2Flow uses it to decide whether to
    /// show the reveal at all, and OfferRevealView uses it to decide what to
    /// render — if those two computed the preference separately they could
    /// disagree, and the flow would show a screen the view then declines to
    /// fill.
    @MainActor
    static func preferredPackage(in packages: [Package]) -> Package? {
        if let id = OnboardingState.shared.preselectedPlanID,
           let picked = packages.first(where: { $0.identifier == id }) {
            return picked
        }
        return PlanSavings.defaultSelection(in: packages)
    }

    /// The largest discount we will ever CLAIM, whatever the store says.
    ///
    /// Ruled 2026-08-28. Apple's price points do not land on clean fractions:
    /// the same "50% off" intro resolves to 49.65% in one territory and 52% in
    /// another, purely from rounding to the nearest local price point. Claiming
    /// the 52% would be a different promise per country for the same offer, and
    /// the number the campaign is built around is 50. So we cap the CLAIM at 50
    /// and let the real price do the talking above it — a user who gets 52% off
    /// is told 50% and receives more, which is the only direction this error is
    /// allowed to run.
    static let maxClaimedPercent = 50

    /// Whole-percent discount of the intro price against the standard price,
    /// FLOORED and then CAPPED at `maxClaimedPercent`. Never rounds up: a money
    /// claim rounded up is overstated, and 49.65% presented as "50%" would be a
    /// claim the receipt does not support. Nil when either price is missing.
    @MainActor
    static func percentOff(for pkg: Package) -> Int? {
        // Same eligibility bar as isRealOffer: a percentage is a money claim.
        guard SubscriptionService.shared.isEligibleForIntro(pkg.storeProduct) else { return nil }
        guard let intro = pkg.storeProduct.introductoryDiscount,
              intro.paymentMode != .freeTrial else { return nil }
        let std = (pkg.storeProduct.price as NSDecimalNumber).doubleValue
        let off = (intro.price as NSDecimalNumber).doubleValue
        guard std > 0, off < std else { return nil }
        let floored = Int(((1.0 - off / std) * 100.0).rounded(.down))
        guard floored >= 1 else { return nil }
        return min(floored, maxClaimedPercent)
    }

    /// The headline states the REAL discount, computed per territory. It used
    /// to hardcode "half price" — false wherever Apple's price points land
    /// the intro at 40% off (HUN, POL) rather than 50%.
    @MainActor
    static func headline(for pkg: Package) -> String {
        guard let pct = percentOff(for: pkg) else {
            return String(localized: "Your first subscription")
        }
        switch pkg.packageType {
        case .annual:  return String(localized: "Your first year is \(pct)% off")
        case .monthly: return String(localized: "Your first month is \(pct)% off")
        case .weekly:  return String(localized: "Your first week is \(pct)% off")
        default:       return String(localized: "Your first subscription is \(pct)% off")
        }
    }

    @MainActor
    static func ctaLabel(for pkg: Package) -> String {
        guard let pct = percentOff(for: pkg) else { return String(localized: "Continue") }
        return String(localized: "Claim \(pct)% off")
    }

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

    /// Benefits in the user's OWN terms. The CLAIMS live in ProBenefits; this
    /// only asks for the personalised variant. Before 2026-08-28 this function
    /// owned its own list and the first-launch paywall owned a different one,
    /// which is how they drifted apart without anything noticing.
    static func benefitLines(audience: String?, videoType: String?) -> [String] {
        ProBenefits.lines(audience: audience, videoType: videoType)
    }
}

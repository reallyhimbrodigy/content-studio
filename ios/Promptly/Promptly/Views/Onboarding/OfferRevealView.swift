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
    @Environment(\.conversionScale) private var k
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

    @State private var checkout: CheckoutItem?
    var body: some View {
        revealBody
            .sheet(item: $checkout) { item in
                CheckoutSheet(item: item, onApple: {
                    checkout = nil
                    guard let pkg = offerPackage else { return }
                    isPurchasing = true
                    Task {
                        let ok = await subscription.purchase(pkg, context: "offer_reveal")
                        isPurchasing = false
                        if ok { onPurchased() }
                    }
                }, onDismiss: { checkout = nil })
                .presentationDetents([.large])
            }
    }

    private var revealBody: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            ScrollView(showsIndicators: false) {
                VStack(spacing: 0 * k) {
                    Spacer().frame(height: 76 * k)

                    AnimatedPromptlyMark(size: 72 * k, halo: true)
                        .padding(.bottom, 22 * k)

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
                            .cType(15, .medium)
                            .foregroundColor(.white.opacity(0.6))
                            .multilineTextAlignment(.center)
                            .padding(.bottom, 4 * k)
                    }

                    Text(offerPackage.map { OfferReveal.headline(for: $0) }
                         ?? String(localized: "Your first subscription"))
                        .cType(28, .bold)
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .minimumScaleFactor(0.85)
                        .padding(.horizontal, 28 * k)

                    if offerPackage != nil {
                        oneTimeBadge.padding(.top, 18 * k)
                    }

                    if let pkg = offerPackage {
                        priceBlock(pkg)
                            .padding(.top, 22 * k)
                            .scaleEffect(priceLanded || reduceMotion ? 1 : 0.88)
                            .opacity(priceLanded ? 1 : 0)
                    }

                    VStack(alignment: .leading, spacing: 14 * k) {
                        // FIVE, not six. Six checkmarks is past the point where
                        // a list is read rather than scanned, and "Save and
                        // share every video" was the weakest of them — the one
                        // claim a reader would assume anyway. Taken as a PREFIX
                        // rather than by dropping a named line, so the order
                        // stays the pitch order and no surface can quietly
                        // promote a minor claim into the cut.
                        ForEach(OfferReveal.benefitLines(audience: onboarding.v2Audience,
                                                         videoType: onboarding.v2VideoType)
                                    .prefix(5), id: \.self) { line in
                            HStack(spacing: 14 * k) {
                                ZStack {
                                    Circle().fill(Color.white).frame(width: 24 * k, height: 24 * k)
                                    Image(systemName: "checkmark")
                                        .cType(11, .heavy)
                                        .foregroundColor(.black)
                                }
                                Text(line)
                                    .cType(16, .medium)
                                    .foregroundColor(.white)
                                Spacer()
                            }
                        }
                    }
                    .padding(.horizontal, 28 * k)
                    .padding(.top, 28 * k)

                    Button {
                        guard let pkg = offerPackage else { return }
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        if let item = CheckoutRouter.item(for: pkg, tierNoun: String(localized: "Pro"), surface: "offer_reveal") {
                            checkout = item
                            return
                        }
                        isPurchasing = true
                        Task {
                            let ok = await subscription.purchase(pkg, context: "offer_reveal")
                            isPurchasing = false
                            if ok { onPurchased() }
                        }
                    } label: {
                        Group {
                            if isPurchasing { ProgressView().tint(.white) }
                            else { Text(offerPackage.map { OfferReveal.ctaLabel(for: $0) }
                                        ?? String(localized: "Continue"))
                                        .cType(17, .bold) }
                        }
                        // PURPLE, like every other primary in the funnel. White
                        // is iOS's neutral — it reads as "dismiss" or "cancel"
                        // as readily as "buy", and this screen's whole job is
                        // one decision. The paywall CTA, the invite CTA and the
                        // downsell CTA are all this accent; the one asking for
                        // the largest commitment was the only one opting out of
                        // the pattern.
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity).frame(height: 56 * k)
                        .background(Color(hex: "6C5CE7"), in: Capsule())
                    }
                    .buttonStyle(OnboardingPressStyle(reduceMotion: reduceMotion))
                    .disabled(offerPackage == nil || isPurchasing)
                    .padding(.horizontal, 24 * k)
                    .padding(.top, 32 * k)

                    // 2. WHAT IS ACTUALLY BEING AGREED TO, at the point of
                    // commitment. The renewal terms are already stated under
                    // the price at the top, but that is a screen-height away
                    // from the button by the time someone has read six bullets —
                    // and hesitation happens at the tap, not at the headline.
                    //
                    // Read from StoreKit's own formatter via the same helper the
                    // price block uses, so it cannot disagree with the number
                    // above it.
                    if let renew = offerPackage.map({ OfferReveal.renewalLine(for: $0) }) ?? nil {
                        Text(renew)
                            .cType(12)
                            .foregroundColor(.white.opacity(0.55))
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 24 * k)
                            .padding(.top, 8 * k)
                    }

                    // SECONDARY PLAN LINE. The yearly stays the hero; this
                    // offers the monthly intro to someone who will not commit
                    // to a year. It sits BELOW the primary CTA and ABOVE
                    // "Decline offer" — a real alternative, not an equal, and
                    // never louder than the plan being sold.
                    secondaryMonthlyLine

                    // No referral line here (ruled 2026-09-05). The referral
                    // offer exists in exactly one place — the invite rung that
                    // follows a decline — and a second mention on the screen
                    // being declined is a second place.

                    // The escape hatch: a text link, never an X (an X invites
                    // an accidental dismissal of a one-time reveal).
                    Button {
                        Analytics.track("offer_reveal_declined", props: ["context": "onboarding_v2"])
                        onDecline()
                    } label: {
                        // LEGIBLE, NORMAL SIZE. It was 14pt at 60% white, which
                        // is the styling of something you are meant to overlook
                        // — and an escape hatch you cannot find is a dark
                        // pattern whatever the intent. The primary is still
                        // dominant by fill and size; this only has to be
                        // readable and obviously tappable.
                        //
                        // A LARGER TAP TARGET TOO: a bare Text button hit-tests
                        // to the glyphs, well under the 44pt minimum, on the one
                        // control someone frustrated is reaching for.
                        Text(String(localized: "Decline offer"))
                            .cType(16, .medium)
                            .foregroundColor(.white.opacity(0.82))
                            .frame(minHeight: 44 * k)
                            .padding(.horizontal, 20 * k)
                            .contentShape(Rectangle())
                    }
                    .padding(.top, 18 * k)

                    // The auto-renew disclosure. Spacing is tighter than the
                    // rest of the screen on purpose: in German this line wraps
                    // to two lines where English and Hindi take one, and at the
                    // old 16/40 padding the second line sat below the fold at
                    // the default scroll position. It was still reachable by
                    // scrolling, but a required disclosure should not depend on
                    // the user scrolling to find it in one language and not
                    // another. Measured on the longest of the twelve.
                    Text(TrialCopy.fineprint)
                        .cType(11)
                        .foregroundColor(.white.opacity(0.4))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 24 * k)
                        .padding(.top, 12 * k)
                        .padding(.bottom, 28 * k)
                }
                // Root cause of the whole surface's iPad stretch: this was the
                // only width bound on the reveal column.
                .conversionColumn(ConversionColumn.content)
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
        // The percentage is a PRECONDITION, not copy. It is not in the line any
        // more — that now reads "$X for your first month, then $Y/mo." — but a
        // computable percent-off is still the proof that StoreKit is offering
        // this user a real discount rather than the standard price. Bound as a
        // condition rather than a value so it cannot read as a dropped
        // interpolation (it compiled with an "unused `pct`" warning, which is
        // exactly what a dropped price claim would look like).
        if let m = monthlyAlternative,
           let intro = m.storeProduct.introductoryDiscount,
           OfferReveal.percentOff(for: m) != nil {
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
                // A REAL SECONDARY BUTTON, not an underlined sentence.
                //
                // Underlined text reads as a footnote or a legal link, so the
                // monthly plan — an actual thing the user can buy — was styled
                // like fine print and sat below the fold of attention. A
                // bordered capsule says "this is tappable" without competing
                // with the filled primary above it: the hierarchy is carried by
                // FILL versus OUTLINE, which is the standard idiom, rather than
                // by making the alternative hard to see.
                // THE TERMS TRAVEL WITH THE PRICE. This read "for $14.99
                // (50% off)" — a first-period price with no statement of what
                // follows it, which is the one shape the intro-eligibility work
                // exists to prevent: a number the user reads as the price and
                // the receipt later contradicts.
                //
                // Both figures are STOREKIT's own formatted strings — the intro
                // price and the standard price — never composed or computed, so
                // they are right in every territory for the same reason the
                // percentage is. `pct` is dropped from the line: the two prices
                // state the saving more plainly than a number does, and it was
                // the only part of this sentence a reader had to take on trust.
                Text(String(localized: "\(intro.localizedPriceString) for your first month, then \(m.storeProduct.localizedPriceString)/mo."))
                    .cType(15, .semibold)
                    .foregroundColor(.white.opacity(0.92))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 52 * k)
                    .background(
                        Capsule().strokeBorder(Color.white.opacity(0.30), lineWidth: 1.5 * k)
                    )
                    .contentShape(Capsule())
            }
            .buttonStyle(OnboardingPressStyle(reduceMotion: reduceMotion))
            .disabled(isPurchasing)
            .padding(.top, 16 * k)
            .padding(.horizontal, 24 * k)
        }
    }

    /// The monthly package, only when it carries a genuinely cheaper paid
    /// intro AND is not already the plan being sold above.
    /// SAME TIER AS THE OFFER, not merely the first monthly in the list.
    ///
    /// `sortedByDuration` ranks by `-allowance`, so Max (1000) sorts BEFORE Pro
    /// (200). Once `max_tier` armed, `first(where: isMonthlyPlan)` started
    /// returning promptly_max_monthly — which carries no introductory offer, so
    /// `isRealOffer` failed and the monthly line silently disappeared from a
    /// reveal that was selling the PRO year.
    ///
    /// It worked right up until Max existed, which is why it was not caught:
    /// with one tier there was only one monthly and "the first monthly" and
    /// "this tier's monthly" were the same package. That also makes it the
    /// reason the collapse of the standalone downsell rung looked wrong — the
    /// line it was collapsed INTO had stopped rendering.
    private var monthlyAlternative: Package? {
        guard offerPackage?.isMonthlyPlan != true else { return nil }
        let tier = offerPackage.flatMap {
            CreditAllowance.monthly(forProductId: $0.storeProduct.productIdentifier)
        }
        guard let m = packages.first(where: {
            $0.isMonthlyPlan
                && CreditAllowance.monthly(forProductId: $0.storeProduct.productIdentifier) == tier
        }) else { return nil }
        return OfferReveal.isRealOffer(m) ? m : nil
    }

    private var oneTimeBadge: some View {
        Text(String(localized: "ONE TIME OFFER"))
            .cType(12, .heavy)
            .tracking(1.4 * k)
            .foregroundColor(.black)
            .padding(.horizontal, 14 * k)
            .padding(.vertical, 7 * k)
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
        VStack(spacing: 6 * k) {
            HStack(alignment: .firstTextBaseline, spacing: 12 * k) {
                Text(pkg.storeProduct.localizedPriceString)
                    .cType(20, .semibold)
                    .foregroundColor(.white.opacity(0.5))
                    .strikethrough(true, color: .white.opacity(0.5))
                if let intro = pkg.storeProduct.introductoryDiscount?.localizedPriceString {
                    Text(intro)
                        .cType(34, .heavy)
                        .foregroundColor(.white)
                }
            }
            Text(OfferReveal.termLine(for: pkg))
                .cType(13)
                .foregroundColor(.white.opacity(0.65))
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 28 * k)
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

    /// "then $289.99/year" — the standard price and period, from StoreKit's own
    /// formatter. Never composed from parts: a currency string assembled in code
    /// is wrong in every locale that puts the symbol somewhere else.
    ///
    /// Nil when the product carries no intro offer, because there is then no
    /// "then" — the price beside the button is already the price forever, and a
    /// reassurance line restating it would imply a change that is not coming.
    @MainActor
    static func renewalLine(for pkg: Package) -> String? {
        guard isRealOffer(pkg) else { return nil }
        let sp = pkg.storeProduct
        let noun = PaywallView.offerNoun(sp.subscriptionPeriod ?? .init(value: 1, unit: .year))
        return String(localized: "then \(sp.localizedPriceString)/\(noun)")
    }

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
        switch pkg.planPeriod {
        case .year:  return String(localized: "Your first year is \(pct)% off")
        case .month: return String(localized: "Your first month is \(pct)% off")
        case .week:  return String(localized: "Your first week is \(pct)% off")
        case .other: return String(localized: "Your first subscription is \(pct)% off")
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
        switch pkg.planPeriod {
        case .year:  return String(localized: "for your first year, then \(standard)/year")
        case .month: return String(localized: "for your first month, then \(standard)/month")
        case .week:  return String(localized: "for your first week, then \(standard)/week")
        case .other: return String(localized: "for your first term, then \(standard)")
        }
    }

    /// Benefits in the user's OWN terms. The CLAIMS live in ProBenefits; this
    /// only asks for the personalised variant. Before 2026-08-28 this function
    /// owned its own list and the first-launch paywall owned a different one,
    /// which is how they drifted apart without anything noticing.
    @MainActor
    static func benefitLines(audience: String?, videoType: String?) -> [String] {
        ProBenefits.lines(audience: audience, videoType: videoType)
    }
}

import SwiftUI
import RevenueCat

// MARK: - Presentation models

/// What a tier card needs in order to draw. Plain values, no StoreKit and no
/// RevenueCat.
///
/// WHY THESE EXIST. The layout has one hard requirement — it must fit on a
/// 375x667 screen without scrolling — and that requirement can only be checked
/// by rendering it and measuring. A view that reads `Purchases.shared.offerings`
/// cannot be measured anywhere the offerings are absent: on a fresh simulator
/// the package list comes back empty, every card drops out of the `ForEach`, and
/// the probe measures an empty screen and reports a comfortable PASS. That
/// happened on the first run of this file's fit check — 179.5pt against 647pt
/// available, which is not a paywall fitting, it is a paywall missing.
///
/// Splitting the models out means the layout can be handed worst-case content —
/// longest language, longest price, every optional line present — and measured
/// honestly, with no network and no account.
struct PaywallTierOption: Identifiable, Equatable {
    let allowance: Int
    let isMax: Bool
    /// The card's name, with the multiplier folded in for Max ("Max (5x usage)")
    /// when there is a meter to be a multiple of.
    let title: String
    /// "200 credits/month". Nil while the credits meter is dark — a credit
    /// number for a meter that is not running is a claim about something the
    /// user cannot spend.
    let creditsLine: String?
    /// The same allowance in videos, small, beneath the credits headline.
    let videosLine: String?
    /// This column's own bullets. TWO INDEPENDENT COLUMNS: nothing is shared,
    /// each side is a complete pitch read top to bottom, so a reader can take in
    /// one column and ignore the other. A shared list above the cards made
    /// "Everything in Pro" appear inside a list of Pro's own features, which
    /// only parsed once it was captioned — the columns say it themselves now.
    let features: [String]
    /// The MONTHLY price, storefront-formatted.
    ///
    /// Both cards quote the same billing period on purpose. A weekly price
    /// beside a monthly one is not a comparison — the smaller number wins on
    /// sight while buying less, which reads as a trick once the user works it
    /// out and understates the more expensive tier in the meantime.
    let monthlyPrice: String?
    var id: Int { allowance }
}

/// One duration choice inside a chosen tier.
struct PaywallDurationOption: Identifiable, Equatable {
    let id: String
    let label: String
    let price: String
    /// The annual plan expressed per month ("$24.16/mo, billed yearly"). This is
    /// what makes a yearly plan legible: $289.99 next to $29.99 reads as ten
    /// times more expensive, when it is in fact cheaper per month. Nil for
    /// non-annual rows, which need no restatement.
    let perMonthLine: String?
    /// Computed from live per-territory prices by `PlanSavings`, never a literal.
    let percentOff: Int?
    /// A PAID introductory offer, already phrased. Never a free-trial phrasing.
    let introLine: String?
    let isAnnual: Bool
}

/// A store product reduced to what the paywall actually renders.
///
/// WHY NOT JUST USE `Package`. RevenueCat's `Package` cannot be constructed —
/// it only ever arrives from a live offering. That makes every mapping decision
/// below (which tier, which is Max, what the card quotes, whether a saving
/// badge appears) unreachable anywhere the store is unreachable: a simulator
/// with no App Store account returns zero packages, so the paywall renders
/// empty and any capture of it is a picture of nothing.
///
/// Reducing to a value type means the DERIVATION runs for real — with real
/// product ids and real storefront prices — and only RevenueCat's own object is
/// out of the picture. That is the difference between a screenshot of a layout
/// and a screenshot of the paywall.
struct PaywallProduct: Equatable {
    let id: String
    let localizedPrice: String
    /// RevenueCat's own per-month string when it has one.
    let localizedPricePerMonth: String?
    let price: Decimal
    /// The product's own formatter locale, so a computed per-month figure is
    /// formatted in the storefront's currency rather than the device's.
    let currencyLocale: Locale?
    let unit: PaywallPeriodUnit
    /// A PAID introductory offer, already phrased by `PaywallView.introOfferLine`.
    let introLine: String?
}

enum PaywallPeriodUnit { case year, month, week, other }

/// The mapping from products to what the two paywall steps show. Pure, static,
/// and total — no store, no flags read from singletons, no view state.
enum PaywallMapping {
    /// Tiers present, ASCENDING by allowance, so Pro is read first and prices
    /// climb left to right. Derived from `CreditAllowance`, so a tier
    /// configured later sorts itself in without a build.
    static func tierAllowances(_ products: [PaywallProduct]) -> [Int] {
        Array(Set(products.compactMap { CreditAllowance.monthly(forProductId: $0.id) })).sorted()
    }

    static func productsInTier(_ all: [PaywallProduct], _ allowance: Int) -> [PaywallProduct] {
        all.filter { CreditAllowance.monthly(forProductId: $0.id) == allowance }
    }

    /// Whole-percent saving of a tier's annual plan against twelve of its own
    /// monthly plan, floored. Under 1% shows no badge — there is no deal to
    /// advertise.
    ///
    /// PERIOD, NOT PACKAGE TYPE, and this is a bug fix rather than a
    /// preference. `PlanSavings.percentOff` selects its two plans with
    /// `packageType == .annual/.monthly`, and RevenueCat classifies the Max
    /// products as `.custom` — so for Max both lookups miss, the function
    /// returns nil, and the yearly row shows no badge at all. Max annual is
    /// $799.99 against $1,079.88 for twelve monthly: a real 25% saving,
    /// silently withheld on the tier the redesign exists to sell.
    static func percentOff(in tierProducts: [PaywallProduct]) -> Int? {
        guard let a = tierProducts.first(where: { $0.unit == .year }),
              let m = tierProducts.first(where: { $0.unit == .month }) else { return nil }
        let yearly = (a.price as NSDecimalNumber).doubleValue
        let monthly12 = (m.price as NSDecimalNumber).doubleValue * 12.0
        guard monthly12 > 0 else { return nil }
        let pct = Int(((1.0 - yearly / monthly12) * 100.0).rounded(.down))
        return pct >= 1 ? pct : nil
    }

    /// "$24.17/mo, billed yearly" — RevenueCat's own per-month price when it has
    /// one, otherwise the yearly price divided by twelve in the storefront's
    /// currency. Nil rather than wrong: a missing line costs a little
    /// persuasion, a made-up one is a misquoted price.
    static func perMonthLine(_ p: PaywallProduct) -> String? {
        if let per = p.localizedPricePerMonth {
            return String(localized: "\(per)/mo, billed yearly")
        }
        let f = NumberFormatter()
        f.numberStyle = .currency
        if let loc = p.currencyLocale { f.locale = loc }
        guard p.price > 0, let s = f.string(from: (p.price / 12) as NSDecimalNumber) else { return nil }
        return String(localized: "\(s)/mo, billed yearly")
    }

    /// The price a tier card quotes: the MONTHLY product, so both cards are read
    /// at the same billing period. A tier with no monthly SKU states its period
    /// explicitly rather than quietly comparing unlike things.
    static func cardPrice(_ tierProducts: [PaywallProduct]) -> String? {
        if let m = tierProducts.first(where: { $0.unit == .month }) {
            return String(localized: "\(m.localizedPrice)/mo")
        }
        guard let any = tierProducts.first else { return nil }
        return "\(any.localizedPrice) / \(periodLabel(any.unit))"
    }

    static func periodLabel(_ unit: PaywallPeriodUnit) -> String {
        switch unit {
        case .year:  return String(localized: "Year")
        case .month: return String(localized: "Month")
        case .week:  return String(localized: "Week")
        case .other: return String(localized: "Plan")
        }
    }

    /// The benefits both tiers share. From ProBenefits, the one file allowed to
    /// write a promise — a phrasing invented here would be a second copy of the
    /// pitch, the drift benefits-parity-gate exists to catch.
    @MainActor
    static func sharedFeatures(_ products: [PaywallProduct], creditsEnabled: Bool) -> [String] {
        ProBenefits.cardFeatures(creditsEnabled: creditsEnabled,
                                 monthlyCredits: tierAllowances(products).first)
    }

    /// What Max adds, shown immediately above the cards.
    @MainActor
    static func maxFeatures(_ products: [PaywallProduct], creditsEnabled: Bool) -> [String] {
        let allowances = tierAllowances(products)
        guard allowances.count > 1 else { return [] }
        return ProBenefits.maxCardList(proAllowance: allowances.first,
                                       maxAllowance: allowances.last,
                                       creditsEnabled: creditsEnabled)
    }

    @MainActor
    static func tierOptions(_ products: [PaywallProduct], creditsEnabled: Bool) -> [PaywallTierOption] {
        let allowances = tierAllowances(products)
        let proAllowance = allowances.first
        let maxAllowance = allowances.count > 1 ? allowances.last : nil
        return allowances.map { allowance in
            let isMax = allowances.count > 1 && allowance == maxAllowance
            // Claims come from ProBenefits in both cases — the one file allowed
            // Claims from ProBenefits, the one file allowed to write a promise.
            let features: [String] = isMax
                ? ProBenefits.maxCardList(proAllowance: proAllowance,
                                          maxAllowance: maxAllowance,
                                          creditsEnabled: creditsEnabled)
                : ProBenefits.cardFeatures(creditsEnabled: creditsEnabled,
                                           monthlyCredits: allowance)
            let title = isMax ? String(localized: "Max") : String(localized: "Pro")
            return PaywallTierOption(
                allowance: allowance,
                isMax: isMax,
                title: title,
                creditsLine: ProBenefits.creditsLine(allowance: allowance,
                                                     creditsEnabled: creditsEnabled),
                videosLine: ProBenefits.videosLine(allowance: allowance,
                                                   creditsEnabled: creditsEnabled),
                features: features,
                monthlyPrice: cardPrice(productsInTier(products, allowance)))
        }
    }

    static func durationOptions(_ products: [PaywallProduct], allowance: Int) -> [PaywallDurationOption] {
        let inTier = productsInTier(products, allowance)
        let pct = percentOff(in: inTier)
        // ORDER IS GUARANTEED HERE, not inherited. This used to return the
        // caller's order, which happened to be right in the app (packages
        // arrive through `sortedByDuration`) and wrong everywhere else — the
        // pre-selected annual row rendered LAST, under two plans nobody had
        // chosen. A list whose correctness depends on how it was handed in is a
        // list that will eventually be handed in differently.
        let order: [PaywallPeriodUnit: Int] = [.year: 0, .month: 1, .week: 2, .other: 3]
        return inTier
            .sorted { (order[$0.unit] ?? 3) < (order[$1.unit] ?? 3) }
            .map { p in
            let isAnnual = p.unit == .year
            return PaywallDurationOption(
                id: p.id,
                label: periodLabel(p.unit),
                price: p.localizedPrice,
                perMonthLine: isAnnual ? perMonthLine(p) : nil,
                percentOff: isAnnual ? pct : nil,
                introLine: p.introLine,
                isAnnual: isAnnual)
        }
    }
}

// MARK: - Layout

/// The paywall as TWO decisions instead of one list — pure layout, no store.
///
/// WHY TWO DECISIONS. Four products in one column is four prices to compare
/// across two independent axes — which tier, and how long — and the reader has
/// to hold both in their head at once. This asks one question at a time: WHICH
/// TIER (two cards, what you get, one price each at the same billing period),
/// and only then HOW LONG, revealed in place beneath the cards. Nothing is
/// hidden and nothing navigates away; the second axis simply is not on screen
/// until the first is answered.
///
/// AND IT HAS TO FIT. The smallest supported device is the iPhone SE at
/// 375x667 — iOS 18 is the deployment target and the SE 3rd generation is the
/// shortest phone that runs it. After the status bar that is 647pt of usable
/// height, measured, not assumed. The feature lists are the space pressure, so
/// the title stands down once a tier is chosen: by then it has been read, and
/// the durations are what the screen is for.
///
/// NOT REVENUECAT'S HOSTED BUILDER, deliberately. Their Pro/Max layout is the
/// reference for the SHAPE, not the implementation: it stacks the tiers
/// vertically and still scrolls on a small phone, and adopting the hosted
/// paywall would mean giving up every computed thing this screen already does —
/// per-territory percentages floored from live prices, intro-eligibility gating
/// that fails closed, the referral row, twelve languages, and claims that flip
/// with the credits flag. None of that survives a template.
struct PaywallLayout: View {
    let title: String
    let tiers: [PaywallTierOption]
    /// Durations for a tier, shown INSIDE that tier's card.
    let durations: (Int) -> [PaywallDurationOption]
    /// The benefits both tiers include.
    let sharedFeatures: [String]
    /// What Max adds, immediately above the cards.
    let maxFeatures: [String]
    var onClose: () -> Void = {}
    var onPurchase: (String) -> Void = { _ in }

    /// Capture aid: start with a duration already chosen, so the CTA state can
    /// be photographed. A real user reaches it by tapping.
    var initialSelectionId: String? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// ONE selection across BOTH cards — the tier and the duration are the same
    /// decision now, not two. Nil means nothing chosen and no CTA.
    @State private var selectedId: String?

    var body: some View {
        VStack(spacing: 0) {
            header

            Image("PromptlyLogo")
                .renderingMode(.original)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 28, height: 28)
                .padding(.bottom, 6)

            Text(displayTitle)
                .cType(22, .bold)
                .foregroundColor(.white)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 16)
                .padding(.bottom, 8)

            // The columns start under the title and TAKE the height. They used
            // to be content-sized with spacers either side, so the pitch sat in
            // the bottom 40% under an empty band and every element had been
            // shrunk to fit a space that was never the constraint.
            tierCards
                .padding(.top, 12)

            Spacer(minLength: 6)

            // NO REFERRAL HERE (ruled 2026-09-02). It lives on the 50%-off
            // offer screen only — a free-Pro alternative on the purchase surface
            // competes with the decision this screen exists to close.

            // NO CTA UNTIL A CHOICE IS MADE. A button that sits there greyed is
            // a control answering a question the cards are still asking; one
            // that ARRIVES is a response to something the user did. It names the
            // purchase, so the last thing before a charge says what is being
            // charged for.
            if let pick = selectedPick {
                VStack(spacing: 5) {
                    Button {
                        onPurchase(pick.option.id)
                    } label: {
                        Text(ctaTitle(for: pick))
                            .cType(16, .bold)
                            .foregroundColor(.black)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                            .frame(maxWidth: .infinity)
                            .frame(height: 46)
                            .background(Capsule().fill(Color.white))
                    }
                    .buttonStyle(.plain)

                    Text(TrialCopy.fineprint)
                        .cType(9)
                        .foregroundColor(.white.opacity(0.4))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)

                    // REQUIRED BY APPLE on any surface that sells a
                    // subscription: a link to the Terms (the EULA) and to the
                    // Privacy Policy. Their absence is a rejection, and this
                    // screen is about to become every upgrade entry point.
                    HStack(spacing: 14) {
                        Button("Terms of Use") { openLegal("https://usepromptly.app/terms.html") }
                        Button("Privacy Policy") { openLegal("https://usepromptly.app/privacy.html") }
                    }
                    .cType(9)
                    .foregroundColor(.white.opacity(0.45))
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
                .transition(reduceMotion ? .opacity
                            : .move(edge: .bottom).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity)
        .animation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.85),
                   value: selectedId)
        .background(Color.black.ignoresSafeArea())
        .onAppear {
            // PRO YEAR PRESELECTED. Nothing recommended is decision paralysis,
            // and the previous default landed on Pro WEEK — the worst outcome
            // available: $10.99 weekly annualises to about $571 against $289.99
            // for the year, on the SKU that retains worst. A default that costs
            // the user twice as much is not a neutral default.
            selectedId = initialSelectionId ?? recommendedId
        }
    }

    /// The title follows the SELECTED TIER once there is one.
    ///
    /// Derived, not switched. `tier.title` comes from the same resolution the
    /// rest of this file uses — `isMax` is `allowance == maxAllowance`, read
    /// through `CreditAllowance` — so a third tier names itself with no edit
    /// here. Two hardcoded strings behind an `if isMax` would have been a second
    /// place that has to know Max exists, and keying off a product id would hit
    /// the `.custom` trap that has already produced three defects.
    ///
    /// Before a selection the reason-derived title stands: a user who arrived
    /// from the export gate should still see why they are here, and overriding
    /// that on arrival would throw the routing away.
    private var displayTitle: String {
        guard let pick = selectedPick else { return title }
        return String(localized: "Unlock Promptly \(pick.tier.title)")
    }

    /// BENEFIT-LED, and derived from what is actually selected.
    ///
    /// "Continue to Purchase" leads with the word for the part the user is
    /// wary of. When the selection carries a computed saving the button states
    /// it — the saving is the reason to take that row — and otherwise it names
    /// what they get. Both forms come from the selection, so neither can
    /// describe a plan that is not chosen.
    private func ctaTitle(for pick: (tier: PaywallTierOption, option: PaywallDurationOption)) -> String {
        if pick.option.isAnnual, let pct = pick.option.percentOff {
            return String(localized: "Start Yearly — Save \(pct)%")
        }
        return String(localized: "Get Promptly \(pick.tier.title)")
    }

    /// Pro's yearly row — the recommendation, DERIVED rather than named. Pro is
    /// the lowest allowance (`tiers` is ascending) and yearly is the row flagged
    /// `isAnnual`, so a repricing or a new tier cannot leave this pointing at a
    /// product that no longer exists.
    private func openLegal(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        UIApplication.shared.open(url)
    }

    private var recommendedId: String? {
        guard let pro = tiers.first(where: { !$0.isMax }) ?? tiers.first else { return nil }
        return durations(pro.allowance).first(where: { $0.isAnnual })?.id
    }

    /// The chosen row and the card it belongs to.
    private var selectedPick: (tier: PaywallTierOption, option: PaywallDurationOption)? {
        guard let id = selectedId else { return nil }
        for tier in tiers {
            if let opt = durations(tier.allowance).first(where: { $0.id == id }) {
                return (tier, opt)
            }
        }
        return nil
    }


    // MARK: Header

    private var header: some View {
        HStack {
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                onClose()
            } label: {
                ZStack {
                    Circle().fill(Color.white).frame(width: 30, height: 30)
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundColor(.black)
                }
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Spacer()
        }
        .padding(.horizontal, 8)
    }

    // MARK: Bullets

    /// The checkmark treatment the rest of the product uses for a promise. The
    /// bullets ARE the sell, so when this screen runs out of room the spacing
    /// gives before they do.
    private func bullets(_ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(lines, id: \.self) { line in
                HStack(alignment: .top, spacing: 9) {
                    ZStack {
                        Circle().fill(Color.white).frame(width: 16, height: 16)
                        Image(systemName: "checkmark")
                            .font(.system(size: 9, weight: .heavy))
                            .foregroundColor(.black)
                    }
                    Text(line)
                        .cType(13, .medium)
                        .foregroundColor(.white)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Cards, each holding its own durations

    private var tierCards: some View {
        HStack(alignment: .top, spacing: 10) {
            ForEach(tiers) { tier in
                tierCard(tier)
            }
        }
        .frame(maxHeight: .infinity)
        .padding(.horizontal, 16)
    }

    /// A tier as a bordered card: heading, credits, its own bullets, its own
    /// durations.
    ///
    /// The card is back by preference (2026-09-02) after a bare-on-black pass.
    /// What is KEPT from that pass is the part that was actually wrong before
    /// it: the columns take the available height instead of floating in the
    /// bottom 40%, and the type is sized to read rather than shrunk to fit. The
    /// container was never the reason things were small — the layout was.
    private func tierCard(_ tier: PaywallTierOption) -> some View {
        let rows = durations(tier.allowance)
        let isActive = selectedPick?.tier.allowance == tier.allowance
        // WHICH TIER IS RECOMMENDED IS DERIVED — the card that owns the
        // recommended row, not a hardcoded "Pro".
        let isRecommended = recommendedId.map { rid in
            durations(tier.allowance).contains { $0.id == rid }
        } ?? false
        return VStack(alignment: .leading, spacing: 0) {
            Text(tier.title)
                .cType(21, .bold)
                .foregroundColor(.white)

            if let credits = tier.creditsLine {
                Text(credits)
                    .cType(14, .semibold)
                    .foregroundColor(.white.opacity(0.7))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
            }
            if let videos = tier.videosLine {
                Text(videos)
                    .cType(11)
                    .foregroundColor(.white.opacity(0.45))
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: 7) {
                ForEach(tier.features, id: \.self) { line in
                    HStack(alignment: .top, spacing: 8) {
                        ZStack {
                            Circle().fill(Color.white).frame(width: 18, height: 18)
                            Image(systemName: "checkmark")
                                .font(.system(size: 10, weight: .heavy))
                                .foregroundColor(.black)
                        }
                        Text(line)
                            .cType(14, .medium)
                            .foregroundColor(.white)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                }
            }
            .padding(.top, 10)

            // SPACERS BOTH SIDES. With one spacer the durations were pinned to
            // the bottom, so the shorter card — Max, with three bullets against
            // Pro's five — showed a long gap that read as unfinished. Two
            // spacers split the slack, centring the block in whatever room the
            // taller card leaves. On the full card they collapse to nothing.
            Spacer(minLength: 6)

            VStack(spacing: 4) {
                ForEach(rows) { row in
                    durationRow(row)
                }
            }

            // 3. THE BENEFIT, not the legal line. "Auto-renews until cancelled"
            // is a disclosure; this is a reason to say yes, so it sits with the
            // plan rather than in the fine print.
            Text("Cancel anytime · no commitment")
                .cType(9)
                .foregroundColor(.white.opacity(0.5))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6)

            // 1. SOCIAL PROOF, on Max only.
            if tier.isMax {
                Text("★ 4.8 · 25,000+ creators")
                    .cType(9, .semibold)
                    .foregroundColor(.white.opacity(0.55))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 3)
            }

            Spacer(minLength: 0)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(isRecommended ? Color(hex: "F4E4BC").opacity(0.07)
                                    : Color.white.opacity(isActive ? 0.10 : 0.05))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(isRecommended ? Color(hex: "F4E4BC").opacity(isActive ? 0.85 : 0.5)
                                            : Color.white.opacity(isActive ? 0.55 : 0.12),
                              lineWidth: isRecommended ? 1.5 : 1)
        )
        // The badge overhangs the top edge, the way a recommendation should read
        // — attached to the card rather than another row inside it.
        .overlay(alignment: .top) {
            if isRecommended {
                Text("RECOMMENDED")
                    .cType(8, .heavy)
                    .foregroundColor(.black)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Color(hex: "F4E4BC")))
                    .offset(y: -8)
            }
        }
    }

    /// A duration row inside its card. Selection is a fill and a border — the
    /// row is a control, so it looks like one.
    private func durationRow(_ option: PaywallDurationOption) -> some View {
        let isSelected = selectedId == option.id
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            selectedId = option.id
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(option.label)
                        .cType(14, .semibold)
                        .foregroundColor(.white.opacity(isSelected ? 1 : 0.8))
                    Spacer(minLength: 2)
                    Text(option.price)
                        .cType(13)
                        .foregroundColor(.white.opacity(isSelected ? 0.95 : 0.55))
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                }
                .frame(height: 24)

                // The saving and the per-month restatement, on their own line
                // because a column this narrow cannot carry them inline.
                //
                // BOTH COMPUTED. The percentage is floored from live storefront
                // prices by `PaywallMapping.percentOff`, which selects its two
                // plans by PERIOD — `packageType` returns `.custom` for Max, so
                // the old selection missed both of Max's plans and silently
                // withheld a real 25%. The per-month figure is the live yearly
                // price over twelve, rounded rather than truncated: rounding up
                // never understates what someone will pay.
                if option.percentOff != nil || option.perMonthLine != nil {
                    // STACKED, NOT INLINE. Side by side in a column this
                    // narrow, Max's line rendered "$66.67/mo, billed yea…" —
                    // cut mid-word on the sentence whose whole job is making
                    // the yearly plan legible as the cheaper one. A clipped
                    // price reads as an app that cannot state its own terms,
                    // and it is the second time this exact line has truncated.
                    VStack(alignment: .leading, spacing: 2) {
                        if let pct = option.percentOff {
                            Text("\(pct)% OFF")
                                .cType(9, .heavy)
                                .foregroundColor(.white)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .overlay(Capsule().strokeBorder(Color.white.opacity(0.8), lineWidth: 1))
                        }
                        if let perMonth = option.perMonthLine {
                            Text(perMonth)
                                .cType(9)
                                .foregroundColor(.white.opacity(0.6))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 2)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Color.white.opacity(isSelected ? 0.16 : 0.05)))
            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(Color.white.opacity(isSelected ? 0.85 : 0), lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("\(option.label), \(option.price)"))
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

// MARK: - Store wiring

/// Binds the live offering to `TwoStepPaywallLayout`.
///
/// EVERYTHING COMPUTED STAYS COMPUTED. Percentages come from `PlanSavings`
/// against live storefront prices, never a literal. The per-month restatement of
/// the annual plan comes from `TrialCopy`, which divides the CURRENT yearly price
/// by twelve using the product's own formatter — so it tracks a repricing with
/// no code edit. Intro lines come from `PaywallView.introOfferLine`, the same
/// body the existing paywall renders, so the two screens cannot state different
/// terms for one product. Tier ordering is derived from the allowance a product
/// maps to, so a fourth tier sorts itself without a build.
struct TwoStepPaywall: View {
    @Binding var isPresented: Bool
    let reason: PaywallReason

    @ObservedObject private var subscription = SubscriptionService.shared
    @ObservedObject private var onboarding = OnboardingState.shared

    private var packages: [Package] {
        SubscriptionService.sortedByDuration(
            subscription.offerings?.current?.availablePackages ?? [])
    }

    /// Adapt RevenueCat's packages into the value type the mapping runs on.
    ///
    /// This is the ONLY place that touches `Package`. Everything the screen
    /// shows is derived past this line, which is what makes the derivation
    /// runnable — and therefore reviewable — without a live store.
    private var products: [PaywallProduct] {
        packages.map { pkg in
            let sp = pkg.storeProduct
            // One resolver, shared with every other paywall surface.
            let unit: PaywallPeriodUnit = {
                switch pkg.planPeriod {
                case .year:  return .year
                case .month: return .month
                case .week:  return .week
                case .other: return .other
                }
            }()
            // offer_surfacing: gated on the flag and the export-gate reason,
            // resolved here because the phrasing needs the StoreKit offer.
            let intro: String? = (onboarding.offerSurfacingEnabled
                                  && reason == .exportGate
                                  && (unit == .year || unit == .month))
                ? PaywallView.introOfferLine(for: pkg) : nil
            return PaywallProduct(
                id: sp.productIdentifier,
                localizedPrice: sp.localizedPriceString,
                localizedPricePerMonth: sp.localizedPricePerMonth,
                price: sp.price,
                currencyLocale: sp.priceFormatter?.locale,
                unit: unit,
                introLine: intro)
        }
    }

    var body: some View {
        let prods = products
        return PaywallLayout(
            title: PaywallView.title(
                for: reason,
                personalisationEnabled: onboarding.exportGatePersonalizationEnabled,
                personalisedNoun: PaywallView.exportContentNoun(from: onboarding)),
            tiers: PaywallMapping.tierOptions(prods, creditsEnabled: onboarding.creditsEnabled),
            durations: { PaywallMapping.durationOptions(prods, allowance: $0) },
            sharedFeatures: PaywallMapping.sharedFeatures(prods, creditsEnabled: onboarding.creditsEnabled),
            maxFeatures: PaywallMapping.maxFeatures(prods, creditsEnabled: onboarding.creditsEnabled),
            onClose: { isPresented = false },
            onPurchase: { id in
                guard let pkg = packages.first(where: {
                    $0.storeProduct.productIdentifier == id
                }) else { return }
                Task {
                    let ok = await subscription.purchase(pkg, context: "two_step_paywall")
                    if ok { isPresented = false }
                }
            })
        .task { if packages.isEmpty { await subscription.refreshOfferings() } }
    }
}

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
    let showsReferral: Bool
    let referralSource: String
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
                .frame(width: 34, height: 34)
                .padding(.bottom, 8)

            Text(title)
                .cType(22, .bold)
                .foregroundColor(.white)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 16)
                .padding(.bottom, 12)

            // The columns start under the title and TAKE the height. They used
            // to be content-sized with spacers either side, so the pitch sat in
            // the bottom 40% under an empty band and every element had been
            // shrunk to fit a space that was never the constraint.
            tierCards
                .padding(.top, 10)

            Spacer(minLength: 6)

            if showsReferralNow {
                ReferralProgressRow(source: referralSource, compact: true,
                                    style: .invite, chromeless: true)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 6)
            }

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
                        Text("Continue to Purchase · \(pick.tier.title) \(pick.option.label)")
                            .cType(16, .bold)
                            .foregroundColor(.black)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                            .frame(maxWidth: .infinity)
                            .frame(height: 48)
                            .background(Capsule().fill(Color.white))
                    }
                    .buttonStyle(.plain)

                    Text(TrialCopy.fineprint)
                        .cType(9)
                        .foregroundColor(.white.opacity(0.4))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
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
        .onAppear { if selectedId == nil { selectedId = initialSelectionId } }
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

    private var showsReferralNow: Bool {
        guard showsReferral, let pick = selectedPick else { return false }
        return !pick.tier.isMax
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
        HStack(alignment: .top, spacing: 20) {
            ForEach(tiers) { tier in
                tierCard(tier)
            }
        }
        .frame(maxHeight: .infinity)
        .padding(.horizontal, 16)
    }

    /// A column, bare on black. NO CONTAINER — no fill, no border, no rounded
    /// corners.
    ///
    /// The boxes were doing nothing except taking room: they forced padding on
    /// four sides, and everything inside had been shrunk to fit a frame that was
    /// never the constraint. Off black, the same content reads at a comfortable
    /// size in less space. The only rounded thing left on the screen is the
    /// Continue button, which is rounded because it is a button.
    private func tierCard(_ tier: PaywallTierOption) -> some View {
        let rows = durations(tier.allowance)
        return VStack(alignment: .leading, spacing: 0) {
            Text(tier.title)
                .cType(21, .bold)
                .foregroundColor(.white)

            if let credits = tier.creditsLine {
                Text(credits)
                    .cType(14, .semibold)
                    .foregroundColor(.white.opacity(0.65))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
            }

            VStack(alignment: .leading, spacing: 9) {
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
            .padding(.top, 14)

            Spacer(minLength: 12)

            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows) { row in
                    durationRow(row)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    /// A bare row. The only mark of selection is a thin rule under it and full
    /// white on the text — no capsule, no fill.
    private func durationRow(_ option: PaywallDurationOption) -> some View {
        let isSelected = selectedId == option.id
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            selectedId = option.id
        } label: {
            VStack(spacing: 0) {
                HStack(spacing: 6) {
                    Text(option.label)
                        .cType(15, .semibold)
                        .foregroundColor(.white.opacity(isSelected ? 1 : 0.72))
                    Spacer(minLength: 2)
                    Text(option.price)
                        .cType(14, .medium)
                        .foregroundColor(.white.opacity(isSelected ? 1 : 0.55))
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                }
                .frame(height: 34)

                Rectangle()
                    .fill(Color.white.opacity(isSelected ? 0.9 : 0.12))
                    .frame(height: isSelected ? 1.5 : 0.5)
            }
            .contentShape(Rectangle())
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
            showsReferral: onboarding.referralProgressEnabled,
            referralSource: "paywall_two_step",
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

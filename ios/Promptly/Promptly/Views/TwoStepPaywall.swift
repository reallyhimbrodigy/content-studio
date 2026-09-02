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
    // NO PER-CARD FEATURE LIST. The benefits are shared and sit ABOVE the
    // cards now, so each card carries only what actually differs between the
    // tiers: the allowance and the price. That is also what fixes the asymmetry
    // — Pro's list boxed inside its card while Max sat beside it in plain text
    // made the upsell read as the lesser product.
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

    @MainActor
    static func tierOptions(_ products: [PaywallProduct], creditsEnabled: Bool) -> [PaywallTierOption] {
        let allowances = tierAllowances(products)
        let proAllowance = allowances.first
        let maxAllowance = allowances.count > 1 ? allowances.last : nil
        return allowances.map { allowance in
            let isMax = allowances.count > 1 && allowance == maxAllowance
            // Claims come from ProBenefits in both cases — the one file allowed
            // No per-card list: the benefits are shared above the cards, so a
            // card is a name, an allowance and a price.
            let title = isMax ? String(localized: "Max") : String(localized: "Pro")
            return PaywallTierOption(
                allowance: allowance,
                isMax: isMax,
                title: title,
                creditsLine: ProBenefits.creditsLine(allowance: allowance,
                                                     creditsEnabled: creditsEnabled),
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
struct TwoStepPaywallLayout: View {
    let title: String
    let tiers: [PaywallTierOption]
    /// Durations for the chosen tier. Called only when a tier is chosen.
    let durations: (Int) -> [PaywallDurationOption]
    /// Whether to show the referral row. Off when the loop is unavailable.
    /// The benefits BOTH tiers include, shown once above the cards.
    let sharedFeatures: [String]
    let showsReferral: Bool
    let referralSource: String
    var onClose: () -> Void = {}
    var onPurchase: (String) -> Void = { _ in }

    /// Starts the layout with a tier already chosen. Exists so the fit probe can
    /// measure the EXPANDED state at all — the layout opens unexpanded, so a
    /// probe that supplies durations and never selects anything measures the
    /// collapsed screen and reports a comfortable PASS for a state it never
    /// rendered. That is not hypothetical; it is what the first step-two
    /// measurement did.
    var initialTier: Int? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var chosenTier: Int?
    @State private var selectedId: String?

    var body: some View {
        VStack(spacing: 0) {
            header

            // FILLS THE SCREEN, and the flexible room is placed on purpose.
            // Two equal spacers made the page a band floating in the middle
            // with gutters above and below; a spacer at the TOP then claimed an
            // equal share of the slack and left a dead zone over the mark. So
            // the column starts high on a fixed lead, and the growing space
            // sits BETWEEN the groups — title to list, list to cards — where it
            // reads as breathing room instead of a hole.
            if chosenTier == nil {
                Spacer(minLength: 0).frame(height: 12)

                Image("PromptlyLogo")
                    .renderingMode(.original)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 38, height: 38)
                    .padding(.bottom, 10)

                Text(title)
                    .cType(24, .bold)
                    .foregroundColor(.white)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16)

                Spacer(minLength: 16)

                sharedBenefits
                    .padding(.horizontal, 22)

                Spacer(minLength: 16)
            }

            tierCards

            if let tier = chosenTier {
                durationList(for: tier)
                    .padding(.top, 10)
                    .transition(reduceMotion ? .opacity
                                : .move(edge: .top).combined(with: .opacity))
            }

            Spacer(minLength: 8)

            if showsReferralNow {
                // PRO ONLY, AND ONLY ONCE CHOSEN. The reward is a week of Pro,
                // so offering it beside Max is offering a downgrade as a prize,
                // and offering it before a tier is picked competes with the
                // decision the screen is asking for.
                ReferralProgressRow(source: referralSource, compact: true, style: .invite)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
            }

            footer
        }
        .frame(maxWidth: .infinity)
        .animation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.86),
                   value: chosenTier)
        .background(Color.black.ignoresSafeArea())
        .onAppear {
            if let t = initialTier, chosenTier == nil { select(t) }
        }
    }

    /// ONE LIST, ABOVE THE CARDS, in the checkmark treatment the rest of the
    /// product uses for a promise.
    ///
    /// Boxed inside Pro's card these read as Pro's features and Max's absence of
    /// them read as less product — the opposite of what an upsell should do.
    /// Shared, they are what BOTH tiers include, and the cards are left carrying
    /// only the difference: 200 credits against 1,000, at two prices. That
    /// comparison is then the thing the eye lands on, which is the whole point
    /// of putting two tiers side by side.
    private var sharedBenefits: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(sharedFeatures, id: \.self) { line in
                HStack(alignment: .top, spacing: 10) {
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
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Choosing a tier pre-selects its ANNUAL plan.
    ///
    /// Pre-selecting the yearly plan is a recommendation, not a trap: it is the
    /// cheapest per month, it is labelled as billed yearly on the row itself,
    /// and both other durations are one tap away and equally visible. A default
    /// that the user can see and change is guidance; one they cannot is a
    /// dark pattern, and the difference is entirely whether the row states its
    /// own terms.
    private func select(_ allowance: Int) {
        chosenTier = allowance
        let list = durations(allowance)
        selectedId = (list.first { $0.isAnnual } ?? list.first)?.id
    }

    // MARK: Header

    /// Top LEFT, where a back control belongs on iOS — the system puts it
    /// there, so every user's hand already knows the corner. A white disc
    /// rather than a bare grey glyph: on a black screen a thin 14pt chevron at
    /// 60% opacity is close to invisible, and the one control that undoes a
    /// decision should never be the hardest thing on screen to find.
    private var header: some View {
        HStack {
            Button {
                // With a tier chosen, this collapses back to the comparison
                // rather than closing. A close button that dismisses from the
                // expanded state throws away a decision just made.
                if chosenTier != nil {
                    chosenTier = nil
                    selectedId = nil
                } else {
                    onClose()
                }
            } label: {
                ZStack {
                    Circle().fill(Color.white).frame(width: 32, height: 32)
                    Image(systemName: chosenTier != nil ? "chevron.left" : "xmark")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(.black)
                }
                .frame(width: 44, height: 44)      // full 44pt touch target
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(chosenTier != nil ? "Back" : "Close"))
            Spacer()
        }
        .padding(.horizontal, 8)
    }

    // MARK: Tier cards

    private var tierCards: some View {
        HStack(alignment: .top, spacing: 10) {
            ForEach(tiers) { tier in
                tierCard(tier)
            }
        }
        // Cards size to their CONTENT. Without this they split the screen's
        // leftover height with the layout's spacer and grow to ~1000pt, leaving
        // a long empty gap between the last feature and the price — the card
        // looked padded out to fill a hole. Fixing the height here also equalises
        // the two: the HStack proposes one height to both, so Pro's six rows and
        // Max's seven still line their prices up.
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 16)
    }

    private func tierCard(_ tier: PaywallTierOption) -> some View {
        let isSelected = chosenTier == tier.allowance
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            select(tier.allowance)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(tier.title)
                    .cType(17, .bold)
                    .foregroundColor(.white)

                // The allowance — the ONE thing that differs besides price, and
                // now the thing the eye lands on.
                if let credits = tier.creditsLine {
                    Text(credits)
                        .cType(12, .semibold)
                        .foregroundColor(.white.opacity(0.6))
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 10)

                if let price = tier.monthlyPrice {
                    Text(price)
                        .cType(19, .bold)
                        .foregroundColor(.white)
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.white.opacity(isSelected ? 0.13 : 0.055))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color.white.opacity(isSelected ? 0.9 : 0.13),
                                  lineWidth: isSelected ? 1.5 : 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    // MARK: Durations, in place

    private func durationList(for allowance: Int) -> some View {
        VStack(spacing: 6) {
            ForEach(durations(allowance)) { option in
                durationRow(option)
            }
        }
        .padding(.horizontal, 16)
    }

    private func durationRow(_ option: PaywallDurationOption) -> some View {
        let isSelected = selectedId == option.id
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            selectedId = option.id
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 10) {
                    ZStack {
                        Circle().strokeBorder(Color.white.opacity(isSelected ? 0.9 : 0.3), lineWidth: 1.5)
                            .frame(width: 20, height: 20)
                        if isSelected { Circle().fill(Color.white).frame(width: 11, height: 11) }
                    }
                    Text(option.label)
                        .cType(15, .semibold)
                        .foregroundColor(.white)
                    Spacer(minLength: 4)
                    if let pct = option.percentOff {
                        Text("\(pct)% OFF")
                            .cType(10, .heavy)
                            .foregroundColor(.black)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(Color.white))
                    }
                    Text(option.price)
                        .cType(15, .semibold)
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }

                // THE SECONDARY LINES GET THE WHOLE ROW WIDTH, and that is the
                // fix for a measured defect, not a preference. Nested in the
                // left column beside the badge and the price, the per-month
                // line rendered as "CHF 24.16/Mt., jährlich…" — truncated
                // mid-word, in German, on the one sentence whose entire job is
                // to make the annual plan legible as the cheaper option. A
                // clipped price line is worse than no price line: it looks like
                // the app cannot state its own terms. Full width, wrapping
                // allowed, never a lineLimit.
                if option.perMonthLine != nil || option.introLine != nil {
                    VStack(alignment: .leading, spacing: 2) {
                        if let perMonth = option.perMonthLine {
                            Text(perMonth)
                                .cType(11)
                                .foregroundColor(.white.opacity(0.62))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let intro = option.introLine {
                            Text(intro)
                                .cType(10)
                                .foregroundColor(.white.opacity(0.55))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 30)   // aligned under the label, past the radio
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(minHeight: 48)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(isSelected ? 0.10 : 0.045)))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.white.opacity(isSelected ? 0.85 : 0.10),
                              lineWidth: isSelected ? 1.5 : 1))
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: Footer

    private var footer: some View {
        VStack(spacing: 6) {
            // NO DEAD BUTTON. A greyed "Choose a plan" sitting under two cards
            // is a control that answers a question the cards are already
            // asking, and after a card is tapped it was still greyed for an
            // instant beside a decision the user had just made. Until a tier is
            // chosen the CARDS are the call to action; once one is, this is a
            // live CTA and nothing else.
            if canContinue {
                Button {
                    if let id = selectedId { onPurchase(id) }
                } label: {
                    Text(continueTitle)
                        .cType(17, .bold)
                        .foregroundColor(.black)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .background(Capsule().fill(Color.white))
                }
                .buttonStyle(.plain)
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.98)))
            }

            // The auto-renewal disclosure. Legally fixed wording, and it stays
            // whole — this is the one line on the screen that may not be
            // shortened to save height.
            Text(TrialCopy.fineprint)
                .cType(10)
                .foregroundColor(.white.opacity(0.4))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private var canContinue: Bool { chosenTier != nil && selectedId != nil }

    /// Names the tier being bought, so the last control before a charge says
    /// what it is charging for.
    private var continueTitle: String {
        guard let t = chosenTier, let opt = tiers.first(where: { $0.allowance == t })
        else { return String(localized: "Continue") }
        return opt.isMax ? String(localized: "Continue with Max")
                         : String(localized: "Continue with Pro")
    }

    /// The referral offer belongs to Pro and only after Pro is chosen.
    private var showsReferralNow: Bool {
        guard showsReferral, let t = chosenTier,
              let opt = tiers.first(where: { $0.allowance == t }) else { return false }
        return !opt.isMax
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
        return TwoStepPaywallLayout(
            title: PaywallView.title(
                for: reason,
                personalisationEnabled: onboarding.exportGatePersonalizationEnabled,
                personalisedNoun: PaywallView.exportContentNoun(from: onboarding)),
            tiers: PaywallMapping.tierOptions(prods, creditsEnabled: onboarding.creditsEnabled),
            durations: { PaywallMapping.durationOptions(prods, allowance: $0) },
            sharedFeatures: PaywallMapping.sharedFeatures(prods, creditsEnabled: onboarding.creditsEnabled),
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

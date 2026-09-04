import SwiftUI
import RevenueCat
import StoreKit

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
    /// The BIG figure: each plan expressed at its own billing cadence —
    /// "$24.16/mo", "$29.99/mo", "$10.99/wk". Normalising the year to a month
    /// is what makes the ladder legible: $289.99 beside $29.99 reads as ten
    /// times more expensive when it is in fact cheaper per month.
    ///
    /// THE WEEK IS NEVER NORMALISED. It is billed weekly, and showing "/mo" on
    /// a weekly charge misrepresents what the card is charged — the
    /// misleading-pricing line Apple actually enforces. Its own cadence, or
    /// nothing.
    let rate: String
    /// The sub-line: what is actually billed, and when. The year carries its
    /// full charge here so the per-month figure above can never be mistaken
    /// for the amount taken.
    let billingLine: String
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

    /// Each plan at its OWN cadence. Every figure is derived from the live
    /// storefront price — never a literal — the same rule that keeps the
    /// percentage claims correct per territory.
    static func rateLine(_ p: PaywallProduct) -> String {
        switch p.unit {
        case .year:
            guard let per = perMonthAmount(p) else { return p.localizedPrice }
            return String(localized: "\(per)/mo")
        case .month:
            return String(localized: "\(p.localizedPrice)/mo")
        case .week:
            // NOT converted to a monthly figure. See `rate`.
            return String(localized: "\(p.localizedPrice)/wk")
        case .other:
            return p.localizedPrice
        }
    }

    /// What is billed, and when. The year names its full charge so the /mo
    /// figure above cannot be read as the amount taken.
    static func billingLine(_ p: PaywallProduct) -> String {
        switch p.unit {
        case .year:  return String(localized: "billed yearly at \(p.localizedPrice)")
        case .month: return String(localized: "billed monthly")
        case .week:  return String(localized: "billed weekly")
        case .other: return ""
        }
    }

    /// yearly / 12, ROUNDED — not RevenueCat's `localizedPricePerMonth`, which
    /// TRUNCATES: $799.99/12 is $66.6658, and that helper reports $66.66 while
    /// the honest rounding is $66.67. A rounded-down rate understates by a cent
    /// in the user's favour, which is harmless, but the two figures disagreeing
    /// across surfaces is not — so this computes it once, explicitly.
    ///
    /// Formatted in the PRODUCT's currency locale, never the device's: a user
    /// on a US storefront with a French device must see dollars.
    static func perMonthAmount(_ p: PaywallProduct) -> String? {
        guard p.price > 0 else { return nil }
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.roundingMode = .halfUp
        f.maximumFractionDigits = 2
        if let loc = p.currencyLocale { f.locale = loc }
        return f.string(from: (p.price / 12) as NSDecimalNumber)
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
    static func tierOptions(_ products: [PaywallProduct], creditsEnabled: Bool,
                            maxEnabled: Bool = true) -> [PaywallTierOption] {
        // MAX IS DROPPED AT THE SOURCE when it is not approved, so it cannot
        // appear in the toggle, the CTA, or a percentage computed across tiers.
        // Filtering in the view would leave it in every derived value.
        var allowances = tierAllowances(products)
        if !maxEnabled, allowances.count > 1 { allowances = [allowances[0]] }
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
                rate: rateLine(p),
                billingLine: billingLine(p),
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
    let durations: (Int) -> [PaywallDurationOption]
    var onClose: () -> Void = {}
    var onPurchase: (String) -> Void = { _ in }

    /// Capture aid: open on this tier. A real user taps the toggle.
    var initialTierAllowance: Int? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// A TIER TOGGLE, not two columns.
    ///
    /// The dead space moved from Max to Pro and back through three attempts at
    /// centring, which is the signal that it was never a spacing bug: two
    /// columns of unequal content cannot both fill a shared height. Showing one
    /// tier at a time removes the geometry that caused it, and it drops the
    /// prices on screen from five to two or three — the reader compares
    /// durations within a tier instead of a five-price grid.
    @State private var tierAllowance: Int?
    @State private var selectedId: String?

    /// Read for the personalised lead only. `PaywallLayout` is otherwise a pure
    /// function of its inputs — which is what makes it renderable in the
    /// harness without a store — so this is the one singleton it touches, and
    /// it degrades to nothing when the flag is off or the questions were
    /// skipped rather than changing any other part of the layout.
    @ObservedObject private var onboarding = OnboardingState.shared

    /// `-preselectPlan <productId>` — DEBUG only, nil in Release.
    static var debugPreselectedPlan: String? {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-preselectPlan"), i + 1 < args.count else { return nil }
        return args[i + 1]
        #else
        return nil
        #endif
    }

    /// The CTA's accent. Saturated, and used by NOTHING else here — white reads
    /// as neutral or dismiss on iOS, which is the wrong signal for the one
    /// control the screen exists for. The recommended badge is gold, so this is
    /// deliberately not gold.
    private static let accent = Color(hex: "6C5CE7")

    var body: some View {
        VStack(spacing: 0) {
            header

            Image("PromptlyLogo")
                .renderingMode(.original)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 24, height: 24)
                .padding(.bottom, 6)

            // OUTCOME-LED. It sells the result; the tier name is carried by the
            // toggle directly beneath and by the CTA at the bottom, so naming it
            // here too would spend the largest type on the screen restating
            // something already said twice.
            // PERSONALISED LEAD, from Q1 and Q2. It could not fire before:
            // the paywall was a root branch ABOVE the question flow, so
            // `v2Audience` and `v2VideoType` were always nil by the time this
            // drew. The questions now run first, so the copy that was already
            // built has something to read.
            //
            // ABOVE the headline and never inside it, matching OfferRevealView:
            // the headline is the product's own claim, and user-derived text
            // has no business inside it. Nil when the questions were skipped —
            // and nil means it simply is not drawn, because a generic fallback
            // reads as personalisation that failed, which is worse than none.
            if onboarding.paywallPersonalizationEnabled,
               let lead = PaywallPersonalization.lead(audience: onboarding.v2Audience,
                                                      videoType: onboarding.v2VideoType) {
                Text(lead)
                    .cType(14, .medium)
                    .foregroundColor(.white.opacity(0.6))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 4)
            }

            Text("Edit any video just by typing")
                .cType(21, .bold)
                .foregroundColor(.white)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 20)
                .padding(.bottom, 10)

            // A one-tier toggle is a control with nothing to choose. While Max
            // is unapproved this is a Pro-only paywall, so the segmented row
            // does not draw at all.
            if tiers.count > 1 {
                tierToggle
                    .padding(.horizontal, 20)
            }

            if let tier = activeTier {
                tierBody(tier)
                    .padding(.horizontal, 20)
                    .padding(.top, 10)
                    .frame(maxHeight: .infinity)
                    .transition(reduceMotion ? .opacity : .opacity)
            }

            // Was `Spacer(minLength: 8)` — the single pool the whole band came
            // from. The tier body now takes the slack, so this is only the
            // fixed breathing room above the social-proof line.
            Spacer(minLength: 0)
                .frame(height: 8)

            Text("★ 4.8 · 25,000+ creators")
                .cType(11, .semibold)
                .foregroundColor(.white.opacity(0.6))
                .frame(maxWidth: .infinity)
                .padding(.bottom, 6)

            footer
        }
        .frame(maxWidth: .infinity)
        .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.88),
                   value: tierAllowance)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: selectedId)
        .background(Color.black.ignoresSafeArea())
        .onAppear { applyDefaults() }
        // The offering loads AFTER first render, so a one-shot default resolved
        // against an empty list and left the screen with nothing selected and no
        // CTA. Re-applied when the tiers arrive; idempotent, so it cannot yank a
        // row out from under a choice already made.
        .onChange(of: tiers) { _, _ in applyDefaults() }
    }

    // MARK: Defaults — everything agrees on Pro Year

    private func applyDefaults() {
        if tierAllowance == nil {
            tierAllowance = initialTierAllowance ?? recommendedTier?.allowance
        }
        if selectedId == nil, let t = activeTier {
            // APP REVIEW ARTIFACT (DEBUG). Apple wants one capture PER PRODUCT,
            // and a subscription group's products differ only by the duration
            // row selected here — so the tier arg alone cannot produce a
            // monthly shot. Release ignores this entirely.
            if let want = Self.debugPreselectedPlan,
               let row = durations(t.allowance).first(where: { $0.id == want }) {
                selectedId = row.id
            } else {
                selectedId = preferredRow(in: t)?.id
            }
        }
    }

    /// Pro — the lowest allowance, derived. `tiers` is ascending.
    private var recommendedTier: PaywallTierOption? {
        tiers.first(where: { !$0.isMax }) ?? tiers.first
    }

    /// Yearly if the tier has one. Never weekly by default: $10.99 a week
    /// annualises to about $571 against $289.99 for the year, on the SKU that
    /// retains worst — a default that costs roughly twice as much is not
    /// neutral.
    private func preferredRow(in tier: PaywallTierOption) -> PaywallDurationOption? {
        let rows = durations(tier.allowance)
        return rows.first(where: { $0.isAnnual }) ?? rows.first
    }

    private var activeTier: PaywallTierOption? {
        tiers.first(where: { $0.allowance == tierAllowance }) ?? tiers.first
    }

    private var selectedRow: PaywallDurationOption? {
        guard let t = activeTier else { return nil }
        return durations(t.allowance).first(where: { $0.id == selectedId })
    }

    /// The recommended row: Pro's yearly. The badge marks the RECOMMENDATION,
    /// not the selection, so it stays put when the user moves.
    private var recommendedRowId: String? {
        guard let pro = recommendedTier else { return nil }
        return preferredRow(in: pro)?.id
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

    // MARK: Toggle

    private var tierToggle: some View {
        HStack(spacing: 4) {
            ForEach(tiers) { tier in
                let isOn = tier.allowance == tierAllowance
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    tierAllowance = tier.allowance
                    // Moving tier moves the selection with it, so the CTA can
                    // never name a row from the tier the user just left.
                    selectedId = preferredRow(in: tier)?.id
                } label: {
                    Text(tier.title)
                        .cType(15, .bold)
                        .foregroundColor(isOn ? .black : .white.opacity(0.75))
                        .frame(maxWidth: .infinity)
                        .frame(height: 34)
                        .background(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(isOn ? Color.white : Color.clear)
                        )
                        .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .fill(Color.white.opacity(0.08)))
    }

    // MARK: The selected tier

    /// THE TAB FILLS ITS COLUMN. Reported three times as "an empty band below
    /// the plans", worst on Max.
    ///
    /// The cause was a single `Spacer(minLength: 8)` in the outer stack, between
    /// this body and the social proof. One spacer means ALL the slack pools in
    /// ONE gap, so whatever the tier did not use appeared as a dead band in that
    /// exact spot — and Max, with three bullets against Pro's five and two
    /// duration rows against three, had the most left over. Nothing was wrong
    /// with either tier's content; the layout simply had one place to put the
    /// remainder.
    ///
    /// The gaps BETWEEN groups are flexible now, with their old fixed values as
    /// minimums, so the remainder is shared across the three seams instead of
    /// collected at the bottom. A tab with less content spreads; a tab with more
    /// keeps today's spacing. On a short screen every spacer collapses to its
    /// minimum and the layout is byte-identical to before — which is what keeps
    /// the SE fit intact rather than trading one device's problem for another's.
    private func tierBody(_ tier: PaywallTierOption) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let credits = tier.creditsLine {
                Text(credits)
                    .cType(16, .bold)
                    .foregroundColor(.white)
            }
            if let videos = tier.videosLine {
                Text(videos)
                    .cType(12)
                    .foregroundColor(.white.opacity(0.5))
                    .padding(.top, 1)
            }

            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(tier.features.enumerated()), id: \.element) { idx, line in
                    if idx > 0 { Spacer(minLength: 0).frame(maxHeight: 22) }
                    HStack(alignment: .top, spacing: 9) {
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

            // Capped seams. Uncapped, the remainder collected in whichever gap
            // came first and the screen read as two voids instead of one — the
            // same defect moved, not fixed. Caps let each seam take a share and
            // stop, so a short tier reads as generously spaced rather than
            // broken apart, and any true remainder lands once, above the CTA,
            // where a margin is expected.
            Spacer(minLength: 0).frame(maxHeight: 46)

            VStack(spacing: 6) {
                ForEach(Array(durations(tier.allowance).enumerated()), id: \.element.id) { idx, row in
                    if idx > 0 { Spacer(minLength: 0).frame(maxHeight: 14) }
                    durationRow(row)
                }
            }
            .padding(.top, 10)

            Spacer(minLength: 0).frame(maxHeight: 46)

            Text("Cancel anytime · no commitment")
                .cType(10)
                .foregroundColor(.white.opacity(0.5))
                .frame(maxWidth: .infinity)
                .padding(.top, 8)
        }
        // .topLeading, not .leading. With only a horizontal alignment the
        // expanded frame centred the column vertically, which opened a gap
        // under the toggle — "content starting near the title" is the half of
        // the brief that alignment decides, and the seams below take the rest.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// UNMISTAKABLE WHEN SELECTED: a filled row with a full-strength border, not
    /// a faint outline. It should be obvious at arm's length which row is
    /// chosen, because the CTA is about to charge for it.
    private func durationRow(_ option: PaywallDurationOption) -> some View {
        let isSelected = selectedId == option.id
        let isRecommended = option.id == recommendedRowId
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            selectedId = option.id
        } label: {
            HStack(spacing: 10) {
                ZStack {
                    Circle().strokeBorder(Color.white.opacity(isSelected ? 1 : 0.35), lineWidth: 2)
                        .frame(width: 20, height: 20)
                    if isSelected { Circle().fill(Color.white).frame(width: 11, height: 11) }
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(option.label)
                            .cType(15, .semibold)
                            .foregroundColor(.white)
                        if let pct = option.percentOff {
                            Text("\(pct)% OFF")
                                .cType(9, .heavy)
                                .foregroundColor(.black)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .background(Capsule().fill(Color.white))
                        }
                    }
                    if !option.billingLine.isEmpty {
                        Text(option.billingLine)
                            .cType(10)
                            .foregroundColor(.white.opacity(0.6))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    // The store's own intro terms, stated rather than applied
                    // silently.
                    if let intro = option.introLine {
                        Text(intro)
                            .cType(10, .semibold)
                            .foregroundColor(Color(hex: "F4E4BC").opacity(0.9))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 6)
                VStack(alignment: .trailing, spacing: 2) {
                    if isRecommended {
                        Text("RECOMMENDED")
                            .cType(8, .heavy)
                            .foregroundColor(.black)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(Color(hex: "F4E4BC")))
                    }
                    Text(option.rate)
                        .cType(15, .bold)
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                }
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 8)
            // SELECTED READS AT ARM'S LENGTH. The border already carried the
            // state, but a 2pt white stroke against a 0.16 fill is a difference
            // you have to look for — on the one control that decides what the
            // CTA charges. Fill does the work at a glance and the border
            // confirms it up close; both move together so the state is legible
            // at either distance.
            .background(RoundedRectangle(cornerRadius: 13, style: .continuous)
                .fill(isSelected ? Color.white.opacity(0.30) : Color.white.opacity(0.04)))
            .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(isSelected ? Color.white : Color.white.opacity(0.10),
                              lineWidth: isSelected ? 2.5 : 1))
            .contentShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    // MARK: Footer

    private var footer: some View {
        VStack(spacing: 6) {
            Button {
                if let id = selectedId { onPurchase(id) }
            } label: {
                Text(ctaTitle)
                    .cType(17, .bold)
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
                    .background(Capsule().fill(Self.accent))
            }
            .buttonStyle(.plain)
            .disabled(selectedId == nil)
            .opacity(selectedId == nil ? 0.5 : 1)

            Text(TrialCopy.fineprint)
                .cType(9)
                .foregroundColor(.white.opacity(0.4))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            // Apple requires both on a surface that sells a subscription.
            HStack(spacing: 14) {
                Button("Terms of Use") { openLegal("https://usepromptly.app/terms.html") }
                Button("Privacy Policy") { openLegal("https://usepromptly.app/privacy.html") }
            }
            .cType(9)
            .foregroundColor(.white.opacity(0.45))
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
    }

    /// Names the tier AND the duration, so the last control before a charge says
    /// exactly what is being charged for.
    private var ctaTitle: String {
        guard let tier = activeTier, let row = selectedRow else {
            return String(localized: "Choose a plan")
        }
        return String(localized: "Get \(tier.title) · \(row.label)")
    }

    private func openLegal(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        UIApplication.shared.open(url)
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

    /// `-preselectTier <allowance>` — DEBUG only, nil in Release, so the
    /// shipping paywall always opens on its own recommended tier.
    static var debugPreselectedTier: Int? {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-preselectTier"), i + 1 < args.count else { return nil }
        return Int(args[i + 1])
        #else
        return nil
        #endif
    }

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
        #if DEBUG
        // `-dumpOffering` — KEPT, not scaffolding. "Why is a plan missing?" has
        // three candidate answers (absent package / detached product / client
        // filter) and only the offering itself separates them. Answering it
        // twice by hand cost a code round-trip each time.
        if ProcessInfo.processInfo.arguments.contains("-dumpOffering") {
            let raw = subscription.offerings?.current?.availablePackages ?? []
            print("[OFFER] current=\(subscription.offerings?.current?.identifier ?? "nil") raw=\(raw.count) afterGate=\(packages.count)")
            for p in raw {
                let sp = p.storeProduct
                let per = sp.subscriptionPeriod
                print("[OFFER]  pkg=\(p.identifier) type=\(p.packageType) product=\(sp.productIdentifier) period=\(per.map { "\($0.value)\($0.unit)" } ?? "nil") planPeriod=\(p.planPeriod) allowance=\(String(describing: CreditAllowance.monthly(forProductId: sp.productIdentifier)))")
            }
            // ASK STOREKIT DIRECTLY. `availablePackages` is already
            // POST-filter: RevenueCat drops any package whose underlying
            // StoreKit product did not resolve, so an attached package and a
            // count of 4 are not a contradiction — they are the signature of a
            // product StoreKit will not return. Reading the offering alone
            // cannot tell "not attached" from "attached but unresolvable", and
            // this session spent eight reads unable to separate them.
            //
            // This asks the store itself, so the poll reports WHICH of the two
            // it is and goes green the moment resolution starts working.
            Task {
                let ids = ["promptly_max_yearly", "promptly_max_monthly",
                           "promptly_topup_5", "promptly_topup_10", "promptly_topup_20"]
                do {
                    let found = try await Product.products(for: ids)
                    let got = Set(found.map(\.id))
                    for id in ids {
                        print("[STOREKIT] \(id) = \(got.contains(id) ? "RESOLVES" : "NOT RETURNED BY STOREKIT")")
                    }
                } catch {
                    print("[STOREKIT] query failed: \(error.localizedDescription)")
                }
            }
        }
        #endif
        return packages.map { pkg in
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
            // SURFACED ON EVERY ENTRY POINT, not just the export gate.
            //
            // Both Pro SKUs carry a PAY_AS_YOU_GO introductory offer in App
            // Store Connect — $14.99 for a first month against $29.99, $145.99
            // for a first year against $289.99, configured across 175
            // territories. StoreKit applies it to eligible users whatever the
            // paywall says, so gating the LINE to one reason meant the discount
            // was being given away silently on every other surface: up to $144
            // on a yearly, with none of the conversion lift of having said so.
            //
            // It is not a free trial and there is no trial claim here — the line
            // states the store's own paid terms, which is what
            // `introOfferLine` renders (it returns nil for `.freeTrial`
            // offers, so the no-trial ruling still holds by construction).
            let intro: String? = (onboarding.offerSurfacingEnabled
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
            tiers: PaywallMapping.tierOptions(prods, creditsEnabled: onboarding.creditsEnabled,
                                              maxEnabled: onboarding.maxTierEnabled),
            durations: { PaywallMapping.durationOptions(prods, allowance: $0) },
            onClose: { isPresented = false },
            onPurchase: { id in
                guard let pkg = packages.first(where: {
                    $0.storeProduct.productIdentifier == id
                }) else { return }
                Task {
                    // CONTEXT IS THE ENTRY, not the view. "two_step_paywall"
                    // named the screen, so every purchase from every entry
                    // collapsed into one bucket and could not be compared with
                    // the view events, which split by entry. A funnel needs both
                    // ends keyed the same way or the ratio is meaningless.
                    // Kept on ONE line: purchase-context-gate scans the call
                    // line for `context:`, so wrapping the argument hid it and
                    // read as an unstamped purchase. The gate is right — an
                    // unstamped purchase is invisible in the by-surface cut —
                    // so the formatting moves, not the rule.
                    let ok = await subscription.purchase(pkg, context: PaywallView.reasonKey(for: reason))
                    if ok { isPresented = false }
                }
            },
            // APP REVIEW ARTIFACT ONLY (DEBUG), nil in Release. Apple wants the
            // purchase in context — Max's tier with its real plan options — and
            // simctl has no tap primitive to select the Max segment, so this
            // preselects a tier by allowance and makes the capture deterministic.
            //
            // It drives the REAL paywall on REAL StoreKit prices, which is the
            // point: the posed harness states run on HarnessPaywallMock's
            // hardcoded prices, and a review screenshot showing prices Apple
            // cannot match against the product is worse than none.
            initialTierAllowance: Self.debugPreselectedTier)
        // THE SHARED PAYWALL WAS SILENT. It emitted no view event at all, while
        // the legacy PaywallView it replaces emits `upgrade_wall_viewed` — so
        // the moment this ships, every paywall view metric would drop to the
        // surfaces that still had their own emitters and read as a collapse.
        //
        // Emitted HERE rather than in each host, because the three wrappers
        // (first launch, trial wall, second paywall) each had their own
        // emitter and would otherwise double-count every view now that they
        // render this view. One screen, one event, keyed by the same
        // `reasonKey` the legacy paywall uses — so the two are directly
        // comparable across the cutover instead of restarting the series.
        .onAppear {
            Analytics.track("upgrade_wall_viewed",
                            props: (["context": PaywallView.reasonKey(for: reason)] as [String: Any])
                                .merging(SubscriptionService.cachedStorefrontProps) { a, _ in a })
        }
        .task { if packages.isEmpty { await subscription.refreshOfferings() } }
    }
}

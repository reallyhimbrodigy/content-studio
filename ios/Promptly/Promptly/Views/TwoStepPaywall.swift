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
    /// What the tier includes, short lines, in reading order. Pro lists what you
    /// get; Max leads with "Everything in Pro, plus".
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

            // The title steps aside once a tier is chosen. It is the framing for
            // the first decision and pure overhead for the second, and on a
            // 667pt screen its two bold lines are the difference between the
            // duration rows fitting and not.
            if chosenTier == nil {
                Text(title)
                    .cType(24, .bold)
                    .foregroundColor(.white)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
            }

            tierCards

            if let tier = chosenTier {
                durationList(for: tier)
                    .padding(.top, 10)
                    .transition(reduceMotion ? .opacity
                                : .move(edge: .top).combined(with: .opacity))
            }

            Spacer(minLength: 8)

            if showsReferral {
                // Compact: the paywall has one row of space for this, and the
                // reward line is the first thing worth dropping. The COUNT is
                // not optional — a user who already referred someone must see
                // it here, which is the drift this component was built to stop.
                ReferralProgressRow(source: referralSource, compact: true)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
            }

            footer
        }
        .animation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.86),
                   value: chosenTier)
        .background(Color.black.ignoresSafeArea())
        .onAppear {
            if let t = initialTier, chosenTier == nil { select(t) }
        }
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

    private var header: some View {
        HStack {
            Spacer()
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
                Image(systemName: chosenTier != nil ? "chevron.left" : "xmark")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.white.opacity(0.6))
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
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
        .padding(.horizontal, 16)
    }

    private func tierCard(_ tier: PaywallTierOption) -> some View {
        let isSelected = chosenTier == tier.allowance
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            select(tier.allowance)
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                Text(tier.isMax ? String(localized: "Max") : String(localized: "Pro"))
                    .cType(17, .bold)
                    .foregroundColor(.white)

                // WHAT YOU GET, ABOVE THE PRICE. The price is the cost of the
                // thing; showing it first asks the reader to judge a number
                // before they know what it buys.
                //
                // THE LISTS STAND DOWN ONCE A TIER IS CHOSEN, and this is a
                // measurement, not a preference: at worst case — German, Swiss
                // francs, an intro line on the annual row — the expanded screen
                // came to 658pt against 647pt available. Eleven points over.
                // Shaving spacing would have bought those eleven points and
                // handed the same failure to whichever language is longest next
                // time. The lists answer "which tier"; by the time the duration
                // rows are on screen that question is answered, and the back
                // chevron restores them in one tap. Costs ~100pt, in every
                // language.
                if chosenTier == nil {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(tier.features, id: \.self) { line in
                        HStack(alignment: .top, spacing: 5) {
                            Image(systemName: "checkmark")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundColor(.white.opacity(0.55))
                                .padding(.top, 3)
                            Text(line)
                                .cType(11)
                                .foregroundColor(.white.opacity(0.78))
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                        }
                    }
                }
                }

                Spacer(minLength: 6)

                if let price = tier.monthlyPrice {
                    Text(price)
                        .cType(19, .bold)
                        .foregroundColor(.white)
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .topLeading)
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
            Button {
                if let id = selectedId { onPurchase(id) }
            } label: {
                Text(chosenTier == nil ? String(localized: "Choose a plan")
                                       : String(localized: "Continue"))
                    .cType(17, .bold)
                    .foregroundColor(.black)
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .background(Capsule().fill(Color.white.opacity(canContinue ? 1 : 0.35)))
            }
            .buttonStyle(.plain)
            .disabled(!canContinue)

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

    /// Tiers present in the offering, ASCENDING by allowance, so Pro is read
    /// first and the prices climb left to right. Still derived — a tier
    /// configured later sorts itself into place without a build.
    private var tierAllowances: [Int] {
        Array(Set(packages.compactMap {
            CreditAllowance.monthly(forProductId: $0.storeProduct.productIdentifier)
        })).sorted()
    }

    private func packages(inTier allowance: Int) -> [Package] {
        packages.filter {
            CreditAllowance.monthly(forProductId: $0.storeProduct.productIdentifier) == allowance
        }
    }

    /// The MONTHLY product for a tier — the price both cards quote.
    ///
    /// Falls back to the annual only when a tier genuinely has no monthly SKU;
    /// in that case the card would be quoting a different period from its
    /// neighbour, so it says which period it is rather than quietly comparing
    /// unlike things.
    private func monthlyPackage(for allowance: Int) -> Package? {
        let inTier = packages(inTier: allowance)
        return inTier.first { $0.storeProduct.subscriptionPeriod?.unit == .month }
    }

    private func cardPrice(for allowance: Int) -> String? {
        if let m = monthlyPackage(for: allowance) {
            return String(localized: "\(m.storeProduct.localizedPriceString)/mo")
        }
        guard let any = packages(inTier: allowance).first else { return nil }
        return "\(any.storeProduct.localizedPriceString) / \(TwoStepPaywall.periodLabel(any))"
    }

    private var tierOptions: [PaywallTierOption] {
        let allowances = tierAllowances
        let proAllowance = allowances.first
        let maxAllowance = allowances.count > 1 ? allowances.last : nil
        return allowances.map { allowance in
            let isMax = allowances.count > 1 && allowance == maxAllowance
            let features: [String] = isMax
                ? ProBenefits.maxCardFeatures(proAllowance: proAllowance,
                                              maxAllowance: maxAllowance,
                                              creditsEnabled: onboarding.creditsEnabled)
                // The Pro list is `ProBenefits.core` — the SAME six claims the
                // existing paywall renders, already flag-gated on its first row
                // and already translated. A card-specific list would be a
                // second copy of the product's promises, which is the exact
                // drift benefits-parity-gate exists to catch.
                : ProBenefits.core.map(\.text)
            return PaywallTierOption(
                allowance: allowance,
                isMax: isMax,
                features: features,
                monthlyPrice: cardPrice(for: allowance))
        }
    }

    private func durationOptions(_ allowance: Int) -> [PaywallDurationOption] {
        let inTier = packages(inTier: allowance)
        return inTier.map { pkg in
            let unit = pkg.storeProduct.subscriptionPeriod?.unit
            let isAnnual = unit == .year
            // offer_surfacing: the gate derives duration from
            // `subscriptionPeriod` rather than `packageType`. RevenueCat
            // classifies the Max products as `.custom`, so a packageType test
            // would silently hide the intro line on exactly the tier this
            // redesign adds.
            let intro: String? = (onboarding.offerSurfacingEnabled
                                  && reason == .exportGate
                                  && (isAnnual || unit == .month))
                ? PaywallView.introOfferLine(for: pkg) : nil
            return PaywallDurationOption(
                id: pkg.identifier,
                label: Self.periodLabel(pkg),
                price: pkg.storeProduct.localizedPriceString,
                perMonthLine: isAnnual ? Self.perMonthLine(pkg) : nil,
                percentOff: isAnnual ? PlanSavings.percentOff(in: inTier) : nil,
                introLine: intro,
                isAnnual: isAnnual)
        }
    }

    /// "$24.16/mo, billed yearly" — RevenueCat's own per-month price when it has
    /// one, otherwise the yearly price divided by twelve with the PRODUCT'S
    /// formatter, so currency and locale come from StoreKit. Nil rather than
    /// wrong: a missing line costs a little persuasion, a made-up one is a
    /// misquoted price.
    private static func perMonthLine(_ pkg: Package) -> String? {
        if let per = pkg.storeProduct.localizedPricePerMonth {
            return String(localized: "\(per)/mo, billed yearly")
        }
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.locale = pkg.storeProduct.priceFormatter?.locale ?? Locale.current
        guard pkg.storeProduct.price > 0,
              let s = f.string(from: (pkg.storeProduct.price / 12) as NSDecimalNumber)
        else { return nil }
        return String(localized: "\(s)/mo, billed yearly")
    }

    var body: some View {
        TwoStepPaywallLayout(
            title: PaywallView.title(
                for: reason,
                personalisationEnabled: onboarding.exportGatePersonalizationEnabled,
                personalisedNoun: PaywallView.exportContentNoun(from: onboarding)),
            tiers: tierOptions,
            durations: durationOptions,
            showsReferral: onboarding.referralProgressEnabled,
            referralSource: "paywall_two_step",
            onClose: { isPresented = false },
            onPurchase: { id in
                guard let pkg = packages.first(where: { $0.identifier == id }) else { return }
                Task {
                    let ok = await subscription.purchase(pkg, context: "two_step_paywall")
                    if ok { isPresented = false }
                }
            })
        .task { if packages.isEmpty { await subscription.refreshOfferings() } }
    }

    /// "Year" / "Month" / "Week", from the product's own subscription period so
    /// it is correct for a product RevenueCat classifies as `.custom` — which is
    /// what the Max products arrive as.
    static func periodLabel(_ pkg: Package) -> String {
        if let p = pkg.storeProduct.subscriptionPeriod {
            switch p.unit {
            case .year:  return String(localized: "Year")
            case .month: return String(localized: "Month")
            case .week:  return String(localized: "Week")
            default: break
            }
        }
        switch pkg.packageType {
        case .annual:  return String(localized: "Year")
        case .monthly: return String(localized: "Month")
        case .weekly:  return String(localized: "Week")
        default:       return String(localized: "Plan")
        }
    }
}

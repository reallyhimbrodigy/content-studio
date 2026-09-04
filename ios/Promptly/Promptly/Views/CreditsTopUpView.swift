import SwiftUI
import RevenueCat

/// One top-up pack, reduced to what the row draws.
///
/// SOLD IN VIDEOS, HELD IN CREDITS, and the split is deliberate. A balance is a
/// currency — it decrements by ten a render and the number has to survive
/// arithmetic, so it is credits. A purchase is a decision, and nobody decides to
/// buy 200 credits; they decide to make 20 more videos. So the pack is named and
/// priced in videos and the balance stays in credits, and the one place the two
/// meet is this screen, where the conversion is stated rather than assumed.
struct CreditPack: Identifiable, Equatable {
    let id: String            // product id
    let videos: Int
    let price: String         // storefront-formatted, never a literal
    var credits: Int { videos * CreditsService.perVideo }
}

/// Maps a consumable product id to the number of videos it buys.
///
/// N PRODUCTS, NOT THREE. The list is the mapping and the PRODUCTS come from
/// StoreKit, exactly as `CreditAllowance` does for the subscription tiers — so a
/// fourth pack configured in the dashboard appears with no client build, and the
/// three planned SKUs can be created in any order. Longest match first so
/// `credits_20` is never shadowed by `credits_2`.
///
/// An unrecognised id returns nil and the pack is skipped: showing an invented
/// video count is a claim about what someone gets for money.
enum CreditPackCatalog {
    /// THE REAL IDS. This matched `credits_20` / `credits_10` / `credits_5`,
    /// and the products Zac created are `promptly_topup_20` / `_10` / `_5`.
    /// Neither string contains the other, so every lookup returned nil, every
    /// pack was skipped, and the screen would have rendered its empty state
    /// with all three products present and resolving — a silent zero rather
    /// than a visible failure, which is the shape that survives review.
    ///
    /// 5 -> 50 credits, 10 -> 100, 20 -> 200, at 10 credits a video.
    private static let known: [(match: String, videos: Int)] = [
        ("topup_20", 20),
        ("topup_10", 10),
        ("topup_5", 5),
    ]

    /// The largest pack the catalogue KNOWS about, not the largest that
    /// happens to have resolved. The Max upsell hangs off this: with only the
    /// 5 and 10 packs live during a staggered rollout, "the largest available"
    /// is the 10-pack, and the upsell would fire on a pack that is not the one
    /// it argues against.
    static var largestKnownVideos: Int { known.map(\.videos).max() ?? 0 }

    static func videos(forProductId id: String) -> Int? {
        let lower = id.lowercased()
        // SUFFIX, NOT SUBSTRING — and longest-match-first does not fix this,
        // which is why it is worth stating. `contains` maps `promptly_topup_50`
        // to FIVE videos, because "topup_5" is a prefix of "topup_50" and no
        // ordering of the table changes that: the longer key is not in the
        // table at all. Ordering only disambiguates keys that both match.
        //
        // The id ends with its size, so anchoring at the end is the property
        // that actually holds: "promptly_topup_50".hasSuffix("topup_5") is
        // false. A 50-pack added later reads as unrecognised and is SKIPPED —
        // which is the correct failure, because skipping a pack costs a sale
        // and mislabelling one is a false claim about what money buys.
        for entry in known where lower.hasSuffix(entry.match) { return entry.videos }
        return nil
    }

    /// Packs present in the offering, smallest first so the price ladder climbs.
    static func packs(from products: [PaywallProduct]) -> [CreditPack] {
        products.compactMap { p in
            guard let v = videos(forProductId: p.id) else { return nil }
            return CreditPack(id: p.id, videos: v, price: p.localizedPrice)
        }
        .sorted { $0.videos < $1.videos }
    }
}

// MARK: - The screen

/// The Credits section: what you hold, what you can buy, and what arrives
/// anyway.
///
/// ORDER IS THE ARGUMENT. Balance first, because someone arriving here tapped a
/// number and wants to see it. Packs second, because that is the action. The
/// monthly allowance last, because it is the reason most people will decide they
/// do NOT need a pack — and burying it would be selling a top-up to someone
/// whose credits refresh on Thursday.
struct CreditsTopUpView: View {
    var onClose: () -> Void = {}
    /// Posed packs, for a review capture only. The SKUs do not exist yet, so a
    /// live build has zero products and correctly shows the empty state — which
    /// is honest but shows nothing of the design. Labelled as posed wherever it
    /// is used, because a screenshot of invented prices presented as real is the
    /// worst kind of review artifact.
    var posedPacks: [CreditPack]? = nil
    /// Capture aid: start on the largest pack, the state that fires the Max
    /// upsell. Selecting it is the user's action; this only reaches it.
    var preselectLargest: Bool = false

    @ObservedObject private var credits = CreditsService.shared
    @ObservedObject private var onboarding = OnboardingState.shared
    @ObservedObject private var subscription = SubscriptionService.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var selectedId: String?
    @State private var isPurchasing = false

    private var products: [PaywallProduct] {
        (subscription.offerings?.current?.availablePackages ?? []).map { pkg in
            let sp = pkg.storeProduct
            return PaywallProduct(id: sp.productIdentifier,
                                  localizedPrice: sp.localizedPriceString,
                                  localizedPricePerMonth: nil,
                                  price: sp.price,
                                  currencyLocale: sp.priceFormatter?.locale,
                                  unit: pkg.planPeriod == .other ? .other : .month,
                                  introLine: nil)
        }
    }

    private var packs: [CreditPack] { posedPacks ?? CreditPackCatalog.packs(from: products) }

    /// The Max allowance, for the upsell — derived, never typed.
    private var maxAllowance: Int? {
        let ids = (subscription.offerings?.current?.availablePackages ?? [])
            .map(\.storeProduct.productIdentifier)
        return ids.compactMap { CreditAllowance.monthly(forProductId: $0) }.max()
    }

    private var maxMonthlyPrice: String? {
        guard let m = maxAllowance else { return nil }
        return (subscription.offerings?.current?.availablePackages ?? [])
            .first { CreditAllowance.monthly(forProductId: $0.storeProduct.productIdentifier) == m
                     && $0.isMonthlyPlan }?
            .storeProduct.localizedPriceString
    }

    var body: some View {
        VStack(spacing: 0) {
            header

            ScrollView {
                VStack(spacing: 22) {
                    balanceBlock
                    if !packs.isEmpty { packList } else { packsUnavailable }
                    if showsMaxUpsell { maxUpsell }
                    allowanceFooter
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                // Clears the pinned CTA. Without it the scroll content runs
                // UNDER the button and the Max upsell — the one line on this
                // screen that is supposed to change the decision — sat behind
                // it, half legible.
                .padding(.bottom, selectedPack != nil ? 96 : 24)
            }

            if selectedPack != nil { buyButton }
        }
        .background(Color.black.ignoresSafeArea())
        .task {
            await credits.refresh()
            if subscription.offerings == nil { await subscription.refreshOfferings() }
            // MIDDLE PACK PRE-SELECTED. The smallest reads as not really
            // committing and the largest as committing a lot; the middle is the
            // one that reads as a sensible amount, which is the choice most
            // people are actually looking for.
            if selectedId == nil { selectedId = defaultPackId }
        }
        .onChange(of: packs) { _, _ in
            if selectedId == nil { selectedId = defaultPackId }
        }
    }

    private var defaultPackId: String? {
        guard !packs.isEmpty else { return nil }
        if preselectLargest { return packs.last?.id }
        return packs[packs.count / 2].id
    }

    private var selectedPack: CreditPack? { packs.first { $0.id == selectedId } }

    private var showsMaxUpsell: Bool {
        guard let p = selectedPack, let largest = packs.last else { return false }
        // The 20-pack specifically — see `largestKnownVideos`. During a
        // staggered rollout the largest RESOLVED pack may be the 10.
        guard p.videos == CreditPackCatalog.largestKnownVideos else { return false }
        guard p.id == largest.id else { return false }
        return posedPacks != nil || (maxAllowance != nil && maxMonthlyPrice != nil)
    }

    // MARK: Header

    private var header: some View {
        HStack {
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                onClose()
            } label: {
                ZStack {
                    Circle().fill(Color.white).frame(width: 32, height: 32)
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .bold))
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

    // MARK: Balance

    private var balanceBlock: some View {
        VStack(spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: "bolt.fill")
                    .font(.system(size: 30, weight: .bold))
                    .foregroundStyle(
                        LinearGradient(colors: [Color(hex: "9FE8FF"), Color(hex: "4C8DFF")],
                                       startPoint: .top, endPoint: .bottom)
                    )
                    .shadow(color: Color(hex: "9FE8FF").opacity(0.45), radius: 6)
                // SILENT WHEN UNKNOWN. `balance == nil` is an unread balance,
                // not zero — the same rule the header badge follows, and the
                // reason this shows a dash rather than a confident 0.
                if let b = credits.balance {
                    Text(b, format: .number)
                        .font(.system(size: 44, weight: .bold))
                        .foregroundColor(.white)
                        .monospacedDigit()
                        .contentTransition(.numericText())
                } else {
                    Text("—")
                        .font(.system(size: 44, weight: .bold))
                        .foregroundColor(.white.opacity(0.35))
                }
            }
            Text("credits")
                .font(.system(size: 14))
                .foregroundColor(.white.opacity(0.5))
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
    }

    // MARK: Packs

    private var packList: some View {
        VStack(spacing: 10) {
            ForEach(packs) { pack in
                packRow(pack)
            }
        }
    }

    private func packRow(_ pack: CreditPack) -> some View {
        let isSelected = selectedId == pack.id
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            selectedId = pack.id
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    Circle().strokeBorder(Color.white.opacity(isSelected ? 0.9 : 0.3), lineWidth: 1.5)
                        .frame(width: 22, height: 22)
                    if isSelected { Circle().fill(Color.white).frame(width: 12, height: 12) }
                }
                VStack(alignment: .leading, spacing: 2) {
                    // NAMED IN VIDEOS. Nobody decides to buy 200 credits.
                    Text("\(pack.videos) videos")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(.white)
                    Text("\(pack.credits) credits")
                        .font(.system(size: 12))
                        .foregroundColor(.white.opacity(0.45))
                        .monospacedDigit()
                }
                Spacer(minLength: 8)
                Text(pack.price)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(isSelected ? 0.10 : 0.05)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.white.opacity(isSelected ? 0.85 : 0.10),
                              lineWidth: isSelected ? 1.5 : 1))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    /// The SKUs are configured in App Store Connect, not here. Until they exist
    /// this says so plainly instead of rendering an empty list that reads as a
    /// broken screen.
    private var packsUnavailable: some View {
        Text("Top-up packs aren't available yet.")
            .font(.system(size: 14))
            .foregroundColor(.white.opacity(0.5))
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
    }

    // MARK: Max upsell

    /// Fires on the LARGEST pack only, which is the moment the comparison
    /// actually converts: someone about to spend the most on a one-off is the
    /// one person for whom the subscription is obviously better value, and
    /// saying so anywhere earlier would just be an ad.
    ///
    /// Both numbers are derived — the allowance from `CreditAllowance`, the
    /// price from the storefront — so a repricing cannot leave a stale claim.
    private var maxUpsell: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            AppState.shared.presentPaywall(.manual)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "sparkles")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(Color(hex: "F4E4BC"))
                Text(upsellLine)
                    .font(.system(size: 13))
                    .foregroundColor(.white.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(hex: "F4E4BC").opacity(0.08)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color(hex: "F4E4BC").opacity(0.25), lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var upsellLine: String {
        let allowance = maxAllowance ?? 1000
        let price = maxMonthlyPrice ?? "$89.99"
        return String(localized: "Max is \(allowance) credits a month for \(price).")
    }

    // MARK: Allowance

    private var allowanceFooter: some View {
        Group {
            if let monthly = onboarding.creditsMonthlyAllowance, monthly > 0 {
                Text("Your plan adds \(monthly) credits every month.")
                    .font(.system(size: 13))
                    .foregroundColor(.white.opacity(0.5))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    // MARK: Buy

    private var buyButton: some View {
        VStack(spacing: 6) {
            Button {
                guard let pack = selectedPack,
                      let pkg = (subscription.offerings?.current?.availablePackages ?? [])
                        .first(where: { $0.storeProduct.productIdentifier == pack.id })
                else { return }
                isPurchasing = true
                Task {
                    // The same guarded call the paywall uses, so a signed-out
                    // top-up is refused and routed to sign-in like every other
                    // purchase — consumables are not an exception to that.
                    _ = await subscription.purchase(pkg, context: "credits_topup")
                    await credits.refresh()
                    isPurchasing = false
                }
            } label: {
                Text(selectedPack.map { String(localized: "Buy \($0.videos) videos") }
                     ?? String(localized: "Choose a pack"))
                    .font(.system(size: 17, weight: .bold))
                    .foregroundColor(.black)
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .background(Capsule().fill(Color.white))
            }
            .buttonStyle(.plain)
            .disabled(isPurchasing)

            Text("One-time purchase. Credits never expire.")
                .font(.system(size: 10))
                .foregroundColor(.white.opacity(0.4))
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 10)
    }
}

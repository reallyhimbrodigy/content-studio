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

    /// The same price as a NUMBER, for the per-video comparison.
    ///
    /// The comparison used to re-find the pack's `StoreProduct` by id at the
    /// moment it needed the amount. That lookup can fail while the pack itself
    /// renders perfectly — the pack was built FROM a product, so a nil here
    /// means the two views of the same offering disagreed — and when it failed
    /// the hero silently dropped its second line. A pack that knows its own
    /// price cannot disagree with itself.
    var amount: Decimal? = nil

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
            return CreditPack(id: p.id, videos: v, price: p.localizedPrice, amount: p.price)
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
    @Environment(\.conversionScale) private var k
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
    /// Capture aid: start on a SPECIFIC pack, by video count. App Review wants
    /// one screenshot per product showing that product, and the three packs
    /// differ only by which row is selected.
    var preselectPackVideos: Int? = nil

    /// The funnel's primary accent — the same purple as the paywall CTA,
    /// the reveal and the invite rung.
    private static let accent = Color(hex: "6C5CE7")

    @ObservedObject private var credits = CreditsService.shared
    @ObservedObject private var onboarding = OnboardingState.shared
    @ObservedObject private var subscription = SubscriptionService.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var hSize

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
        VStack(spacing: 0 * k) {
            header

            ScrollView {
                VStack(spacing: 18 * k) {
                    balanceBlock

                    Text(headline)
                        .cType(24, .bold)
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)

                    // UPGRADE FIRST. The recurring allowance is the better
                    // answer for anyone who hit this wall once and will hit it
                    // again; the one-time pack is the fallback, and it now
                    // reads as one.
                    upgradeHero

                    VStack(alignment: .leading, spacing: 10 * k) {
                        Text("Or top up once")
                            .cType(13, .semibold)
                            .foregroundColor(.white.opacity(0.55))
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if !packs.isEmpty { packList } else { packsUnavailable }
                        // 4. THE TRUST LINE, on the purchase it applies to.
                        // It was footer text under the button, which is where
                        // disclaimers live — and this is the opposite of a
                        // disclaimer: it is the reason a one-time buy is safe.
                        if !packs.isEmpty {
                            HStack(spacing: 6 * k) {
                                Image(systemName: "infinity")
                                    .cType(11, .bold)
                                    .foregroundColor(.white.opacity(0.6))
                                Text("Credits never expire")
                                    .cType(12, .medium)
                                    .foregroundColor(.white.opacity(0.6))
                            }
                        }
                    }

                    if showsMaxUpsell { maxUpsell }
                    allowanceFooter
                }
                .padding(.horizontal, 20 * k)
                .padding(.top, 8 * k)
                // Clears the pinned CTA. Without it the scroll content runs
                // UNDER the button and the Max upsell — the one line on this
                // screen that is supposed to change the decision — sat behind
                // it, half legible.
                .padding(.bottom, selectedPack != nil ? 96 * k : 24 * k)
            }

            if selectedPack != nil { buyButton }
        }
        // Same cap as every other money surface. The top-up screen was built
        // after the iPad pass and ran the full width there.
        .conversionColumn(ConversionColumn.content)
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

    /// THE HEADLINE MUST NOT ASSERT A ZERO IT HAS NOT READ.
    ///
    /// It was the flat sentence "You're out of credits", which is true for the
    /// credit wall — the path that sends most people here — and false for the
    /// other two. `CreditBadge` opens this screen on tap at ANY balance,
    /// deliberately ("checking what you hold is asking to add to it"), so a user
    /// with 140 credits tapped their balance and was told they had none. And an
    /// UNREAD balance rendered the same sentence, which is the confident-zero
    /// mistake the badge and the balance block above both refuse to make, made
    /// two inches higher in 24pt bold.
    ///
    /// Only nil-safe states say it. Unknown gets the neutral form, because
    /// "add more" is true whatever the number turns out to be.
    private var headline: String {
        if credits.balance == 0 { return String(localized: "You're out of credits") }
        return String(localized: "Add more credits")
    }

    private var defaultPackId: String? {
        guard !packs.isEmpty else { return nil }
        if let want = preselectPackVideos,
           let hit = packs.first(where: { $0.videos == want }) { return hit.id }
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
                    Circle().fill(Color.white).frame(width: 32 * k, height: 32 * k)
                    Image(systemName: "xmark")
                        .font(.system(size: 14 * k, weight: .bold))
                        .foregroundColor(.black)
                }
                .frame(width: 44 * k, height: 44 * k)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Spacer()
        }
        .padding(.horizontal, 8 * k)
    }

    // MARK: Balance

    /// THE BALANCE, as a component rather than a number floating over a label.
    ///
    /// It was a 44pt figure above the word "credits", and with an unread
    /// balance that renders as a grey dash over grey text — a placeholder bar,
    /// which is what it looked like. One line, the brand glyph, and the state
    /// said in words.
    ///
    /// STILL SILENT WHEN UNKNOWN. `balance == nil` is unread, not zero — the
    /// same rule the header badge follows — so it says "Checking your balance"
    /// rather than asserting a confident 0 the server never returned.
    private var balanceBlock: some View {
        HStack(spacing: 10 * k) {
            // THE SHARED MARK — see `CreditMark`. Not a local image and not a
            // system bolt: the same object the chat header and the composer
            // strip draw, so a balance reads as one currency across the app.
            CreditMark(size: 30 * k, isSpent: credits.balance == 0)
            if let b = credits.balance {
                Text("^[\(b) credit](inflect: true) left")
                    .cType(17, .semibold)
                    .foregroundColor(.white)
                    .monospacedDigit()
                    .contentTransition(.numericText())
            } else {
                Text("Checking your balance")
                    .cType(17, .medium)
                    .foregroundColor(.white.opacity(0.45))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12 * k)
        .background(RoundedRectangle(cornerRadius: 14 * k, style: .continuous)
            .fill(Color.white.opacity(0.06)))
    }

    /// THE HERO. This screen is reached by someone who just hit the wall — the
    /// highest-intent upgrade moment in the app — and it led with the cheapest
    /// thing on it. A subscriber gets the allowance every month; a top-up buys
    /// it once. Selling the top-up first answers "how do I unblock this render"
    /// and never asks the better question.
    ///
    /// EVERY FIGURE IS DERIVED. The allowance, the price and both per-video
    /// numbers come from the live products; nothing here is typed, so it stays
    /// true per territory the same way the percentage claims do.
    @ViewBuilder private var upgradeHero: some View {
        if let allowance = proAllowance, let price = proMonthlyPrice {
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                Analytics.track("credits_topup_upgrade_tap", props: ["source": "credit_wall"])
                onClose()
                AppState.shared.presentPaywall(.manual)
            } label: {
                VStack(alignment: .leading, spacing: 6 * k) {
                    Text("Pro gives you ^[\(allowance) credit](inflect: true) a month for \(price)")
                        .cType(16, .semibold)
                        .foregroundColor(.white)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if let cmp = perVideoComparison {
                        cmp
                            .cType(13)
                            .foregroundColor(.white.opacity(0.7))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14 * k)
                .background(RoundedRectangle(cornerRadius: 16 * k, style: .continuous)
                    .fill(Self.accent))
            }
            .buttonStyle(.plain)
        }
    }

    /// "That's $1.50 a video, against $2.00 one-time - plus 200 credits every
    /// month." Both prices computed from live products — the subscription's
    /// per-video cost and the SMALLEST pack's, which is the one a hesitant
    /// buyer reaches for.
    ///
    /// THE THIRD CLAUSE IS THE ONE THAT MATTERS. Cheaper-per-video is an
    /// argument about this purchase; the allowance is an argument about the
    /// NEXT wall. Someone who just hit zero is about to hit it again, and a
    /// comparison that only talks about unit price answers the smaller of the
    /// two questions they have.
    ///
    /// PER VIDEO, NOT PER CREDIT. The brief's example figures — "$0.15 a video
    /// versus $0.20" — are the per-CREDIT numbers: $29.99 over 200 credits is
    /// $0.15, but a video costs ten credits, so the per-video figures are
    /// $1.50 and $2.00. Videos are the unit this screen sells in and the unit
    /// the packs are named in, so the comparison stays in videos; quoting
    /// credit prices against a row labelled "5 videos" invites the reader to
    /// divide by ten twice.
    ///
    /// Nil unless every side is known: half a comparison is worse than none,
    /// because the reader supplies the missing half themselves.
    ///
    /// A `Text`, not a `String`, so the allowance can carry inflection markup —
    /// `String(localized:)` would hand that back verbatim. The two rules
    /// compose: anything with a count wants inflection, and anything with
    /// inflection has to be rendered rather than produced.
    private var perVideoComparison: Text? {
        guard let allowance = proAllowance,
              let sub = proMonthlyProduct,
              let pack = packs.first,
              let packAmount = pack.amount else { return nil }
        let videosPerMonth = allowance / CreditsService.perVideo
        guard videosPerMonth > 0, pack.videos > 0 else { return nil }
        let subPer = (sub.price as NSDecimalNumber).doubleValue / Double(videosPerMonth)
        let packPer = (packAmount as NSDecimalNumber).doubleValue / Double(pack.videos)
        guard packPer > subPer else { return nil }
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.roundingMode = .halfUp
        if let loc = sub.priceFormatter?.locale { f.locale = loc }
        guard let a = f.string(from: subPer as NSNumber),
              let b = f.string(from: packPer as NSNumber) else { return nil }
        // THE FIRST FIGURE IS BOLD, via markdown in the key rather than a
        // concatenation of styled fragments. Concatenating would hard-code
        // English word order — "$1.50" leads the sentence here and does not in
        // German or Japanese — so each translation places its own emphasis and
        // the bold lands on that language's equivalent phrase.
        return Text("That's **\(a) a video**, against \(b) one-time - plus ^[\(allowance) credit](inflect: true) every month.")
    }

    private var proAllowance: Int? {
        let ids = (subscription.offerings?.current?.availablePackages ?? [])
            .map(\.storeProduct.productIdentifier)
        return ids.compactMap { CreditAllowance.monthly(forProductId: $0) }.min()
    }

    private var proMonthlyProduct: StoreProduct? {
        guard let a = proAllowance else { return nil }
        return (subscription.offerings?.current?.availablePackages ?? [])
            .first { CreditAllowance.monthly(forProductId: $0.storeProduct.productIdentifier) == a
                     && $0.isMonthlyPlan }?
            .storeProduct
    }

    private var proMonthlyPrice: String? { proMonthlyProduct?.localizedPriceString }

    private var packList: some View {
        VStack(spacing: 10 * k) {
            ForEach(packs) { pack in
                packRow(pack)
            }
        }
    }

    /// WHY THERE IS NO BADGE ON THE LARGEST PACK, so it is not re-added.
    ///
    /// The obvious way to make the 20-pack attractive is a volume discount, and
    /// it has been proposed twice. It breaks the 2x rule: if credits get
    /// cheaper in bulk, someone stacks top-ups to buy Max's allowance for less
    /// than Max costs, and the tier the hero argues for becomes the worst deal
    /// on the screen. Per-video price stays flat at every size.
    ///
    /// Every substitute badge was then hollow. "Most popular" asserts evidence
    /// that does not exist — nothing has been sold. "Most videos" is true and
    /// redundant: it restates the row's own label. With flat pricing there is
    /// no honest value claim to make, and decoration standing where an argument
    /// would go is worse than an empty space, because the reader spends a beat
    /// discovering it means nothing. The argument for buying more lives in the
    /// hero, where it is about the subscription.

    private func packRow(_ pack: CreditPack) -> some View {
        let isSelected = selectedId == pack.id
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            selectedId = pack.id
        } label: {
            HStack(spacing: 12 * k) {
                ZStack {
                    Circle().strokeBorder(isSelected ? Self.accent : Color.white.opacity(0.3), lineWidth: 1.5 * k)
                        .frame(width: 22 * k, height: 22 * k)
                    if isSelected { Circle().fill(Self.accent).frame(width: 12 * k, height: 12 * k) }
                }
                VStack(alignment: .leading, spacing: 2 * k) {
                    // NAMED IN VIDEOS. Nobody decides to buy 200 credits.
                    //
                    // NO BADGE. The 20-pack carried one, and every version of
                    // it was hollow. "Most popular" was unevidenced — nothing
                    // has been sold. "Most videos" was true and useless: it
                    // restates the number immediately to its left, on a row
                    // that already reads "20 videos". With flat per-video
                    // pricing there is no value claim available to make here,
                    // and a badge that says nothing still costs the reader a
                    // beat working out that it says nothing.
                    Text("\(pack.videos) videos")
                        .font(.system(size: 16 * k, weight: .semibold))
                        .foregroundColor(.white)
                    Text("^[\(pack.credits) credit](inflect: true)")
                        .font(.system(size: 12 * k))
                        .foregroundColor(.white.opacity(0.45))
                        .monospacedDigit()
                }
                Spacer(minLength: 8 * k)
                Text(pack.price)
                    .font(.system(size: 16 * k, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .padding(.horizontal, 14 * k)
            .padding(.vertical, 12 * k)
            .background(RoundedRectangle(cornerRadius: 14 * k, style: .continuous)
                // PURPLE, not a lighter grey. Greyscale selection is what made
                // this read as a debug view rather than a purchase screen, and
                // the accent is the same one every other primary in the funnel
                // uses.
                .fill(isSelected ? Self.accent.opacity(0.22) : Color.white.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 14 * k, style: .continuous)
                .strokeBorder(isSelected ? Self.accent : Color.white.opacity(0.10),
                              lineWidth: isSelected ? 2 : 1))
            .contentShape(RoundedRectangle(cornerRadius: 14 * k, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    /// The SKUs are configured in App Store Connect, not here. Until they exist
    /// this says so plainly instead of rendering an empty list that reads as a
    /// broken screen.
    private var packsUnavailable: some View {
        Text("Top-up packs aren't available yet.")
            .font(.system(size: 14 * k))
            .foregroundColor(.white.opacity(0.5))
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24 * k)
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
            HStack(spacing: 10 * k) {
                Image(systemName: "sparkles")
                    .font(.system(size: 13 * k, weight: .semibold))
                    .foregroundColor(Color(hex: "F4E4BC"))
                upsellLine
                    .font(.system(size: 13 * k))
                    .foregroundColor(.white.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0 * k)
            }
            .padding(14 * k)
            .background(RoundedRectangle(cornerRadius: 14 * k, style: .continuous)
                .fill(Color(hex: "F4E4BC").opacity(0.08)))
            .overlay(RoundedRectangle(cornerRadius: 14 * k, style: .continuous)
                .strokeBorder(Color(hex: "F4E4BC").opacity(0.25), lineWidth: 1 * k))
            .contentShape(RoundedRectangle(cornerRadius: 14 * k, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    /// A `Text`, not a `String` — see the buy CTA. Inflected markup handed
    /// through `String(localized:)` renders as literal markup.
    private var upsellLine: Text {
        let allowance = maxAllowance ?? 1000
        let price = maxMonthlyPrice ?? "$89.99"
        return Text("Max is ^[\(allowance) credit](inflect: true) a month for \(price).")
    }

    // MARK: Allowance

    private var allowanceFooter: some View {
        Group {
            if let monthly = onboarding.creditsMonthlyAllowance, monthly > 0 {
                Text("Your plan adds ^[\(monthly) credit](inflect: true) every month.")
                    .font(.system(size: 13 * k))
                    .foregroundColor(.white.opacity(0.5))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    // MARK: Buy

    private var buyButton: some View {
        VStack(spacing: 6 * k) {
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
                // INFLECTION IS RESOLVED AT RENDER, NOT AT LOOKUP.
                // `String(localized:)` returns the markup VERBATIM — the button
                // read "Buy ^[10 video](inflect: true)" on a live capture — so
                // any inflected key must reach a `Text` as a
                // LocalizedStringKey, never through a String round-trip.
                Group {
                    if let p = selectedPack {
                        Text("Buy ^[\(p.videos) video](inflect: true)")
                    } else {
                        Text("Choose a pack")
                    }
                }
                    .font(.system(size: 17 * k, weight: .bold))
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .cControl(50)
                    .background(Capsule().fill(Self.accent))
            }
            .buttonStyle(.plain)
            .disabled(isPurchasing)

            Text("One-time purchase.")
                .font(.system(size: 10 * k))
                .foregroundColor(.white.opacity(0.4))
        }
        .padding(.horizontal, 20 * k)
        .padding(.bottom, 10 * k)
    }
}

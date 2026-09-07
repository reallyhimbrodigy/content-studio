import SwiftUI
import RevenueCat

/// THE CHECKOUT STEP — United States storefront only, after a plan is chosen.
///
/// Two ways to pay, in the thumb zone: on the web (preselected, cheaper, no
/// in-app purchase fees) or in-app through Apple. Apple's option is never
/// removed or demoted: same row height, same tap target, always available.
/// The totals update with the selection so the number the user pays is on
/// screen before the button is. One CTA. Web opens Safari — the full browser,
/// `UIApplication.open` — never a web view. Apple opens StoreKit exactly as
/// before this sheet existed.
///
/// Every string reads at a fifth-grade level and ships in twelve languages,
/// though only the US storefront ever renders the sheet (StorefrontService).
struct CheckoutItem: Identifiable {
    let productId: String
    /// The RevenueCat PACKAGE identifier, e.g. `$rc_annual`. Sent as the
    /// `package_id` QUERY parameter — the checkout page needs to be told what
    /// it is selling, and the path segment is spoken for by the app_user_id.
    let packageId: String
    let tierNoun: String            // "Pro" / "Max" / "credits" (localized by the caller)
    /// "Year" / "Month" / "Week" — the CTA names the duration being bought.
    let durationNoun: String
    /// WHAT IS CHARGED NOW, on each side. A first-time buyer is quoted intro
    /// against intro; a returning one base against base. Quoting one side's
    /// intro against the other's standard price invents a saving that does not
    /// exist, in either direction.
    let applePrice: Decimal
    let applePriceText: String
    let webPrice: Decimal
    let webPriceText: String
    /// True when BOTH sides are quoting a first-period price.
    let isIntro: Bool
    let priceLocale: Locale
    let web: WebCheckoutConfig.Product
    let surface: String
    var id: String { productId }

    /// Apple's commission, as money: the gap between the two quotes. Derived,
    /// never configured — a hand-set percentage is how the sheet came to read
    /// "Save 15%" over a price that was higher.
    var appleFee: Decimal { max(applePrice - webPrice, 0) }
    var savedPct: Int {
        guard applePrice > 0, appleFee > 0 else { return 0 }
        let pct = (appleFee / applePrice) * 100
        return Int(NSDecimalNumber(decimal: pct).doubleValue.rounded())
    }
}

struct CheckoutSheet: View {
    @Environment(\.conversionScale) private var k
    let item: CheckoutItem
    let onApple: () -> Void
    let onDismiss: () -> Void
    @State private var method: Method = .web
    /// The Apple-selected state is half the spec — the fee live, the total the
    /// higher number — and a snapshot cannot tap the row to reach it.
    private static var posedApple: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("-poseMethodApple")
        #else
        return false
        #endif
    }

    enum Method { case web, apple }

    private var saved: Decimal? { item.appleFee > 0 ? item.appleFee : nil }
    private func money(_ d: Decimal) -> String {
        let f = NumberFormatter(); f.numberStyle = .currency; f.locale = item.priceLocale
        return f.string(from: d as NSDecimalNumber) ?? "\(d)"
    }
    /// The base being bought — the same on both rows. What changes underneath
    /// it is the fee, and that is the point of showing the block at all.
    private var subtotalText: String { item.webPriceText }
    private var totalText: String { method == .apple ? item.applePriceText : item.webPriceText }

    var body: some View {
        VStack(spacing: 0) {
            Capsule().fill(Color.white.opacity(0.25)).frame(width: 36 * k, height: 5 * k).padding(.top, 8 * k)
            Text("Choose how to pay.")
                .font(.system(size: 22 * k, weight: .bold)).foregroundColor(.white)
                .padding(.top, 18 * k).padding(.bottom, 14 * k)
                .accessibilityIdentifier("checkout.title")

            VStack(spacing: 10 * k) {
                methodRow(.web, title: String(localized: "Pay on the web"),
                          subtitle: String(localized: "No in-app purchase fees"),
                          badge: saved.map { String(localized: "\(money($0)) saved") },
                          cards: true)
                    .accessibilityIdentifier("checkout.web")
                methodRow(.apple, title: String(localized: "Pay in-app"),
                          subtitle: String(localized: "Includes in-app purchase fees"),
                          badge: nil, cards: false)
                    .accessibilityIdentifier("checkout.apple")
            }
            .padding(.horizontal, 20 * k)

            VStack(spacing: 8 * k) {
                totalLine(String(localized: "Subtotal"), subtotalText)
                feeLine
                Divider().overlay(Color.white.opacity(0.15))
                totalLine(String(localized: "Total"), totalText, bold: true)
                    .accessibilityIdentifier("checkout.total")
            }
            .padding(.horizontal, 24 * k).padding(.top, 18 * k)

            HStack(spacing: 10 * k) {
                Image(systemName: "tag.fill").foregroundColor(Self.accent)
                // The percentage is DERIVED from the two quotes, never read from
                // a configured `saved_pct` — the configured one read "Save 15%"
                // over a web price that was higher than Apple's, and later
                // "Save 0%", because nothing tied it to the numbers above it.
                Text("Save \(item.savedPct)% when you pay on usepromptly.app.")
                    .font(.system(size: 14 * k, weight: .semibold)).foregroundColor(.white)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(14 * k)
            .background(RoundedRectangle(cornerRadius: 14 * k).fill(Color.white.opacity(0.06)))
            .padding(.horizontal, 20 * k).padding(.top, 16 * k)

            Spacer(minLength: 12 * k)

            if method == .web {
                Text("You’ll finish paying in Safari.")
                    .font(.system(size: 12 * k)).foregroundColor(.white.opacity(0.55))
                    .padding(.bottom, 8 * k)
            }
            Button {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                Analytics.track("checkout_method_chosen", props: ["method": method == .web ? "web" : "apple",
                                                                  "surface": item.surface, "product": item.productId])
                if method == .web { openWeb() } else { onApple() }
            } label: {
                Text("Get \(item.tierNoun) · \(item.durationNoun)")
                    .font(.system(size: 17 * k, weight: .bold)).foregroundColor(.white)
                    .frame(maxWidth: .infinity).frame(height: 54 * k)
                    .background(Capsule().fill(Self.accent))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("checkout.cta")
            .padding(.horizontal, 20 * k).padding(.bottom, 12 * k)
        }
        .background(Color(white: 0.07).ignoresSafeArea())
        .onAppear {
            if Self.posedApple { method = .apple }
            Analytics.track("checkout_sheet_shown", props: ["surface": item.surface, "product": item.productId])
        }
    }

    private func methodRow(_ m: Method, title: String, subtitle: String, badge: String?, cards: Bool) -> some View {
        let selected = method == m
        return Button {
            method = m
        } label: {
            HStack(spacing: 12 * k) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 22 * k)).foregroundColor(selected ? Self.accent : .white.opacity(0.4))
                VStack(alignment: .leading, spacing: 4 * k) {
                    HStack(spacing: 8 * k) {
                        Text(title).font(.system(size: 16 * k, weight: .semibold)).foregroundColor(.white)
                        if let badge {
                            // THE SAVING WEARS THE BRAND COLOUR. Gold reads as a
                            // store-promo sticker from someone else's app; the
                            // purple is the same accent as the selected row and
                            // the CTA, so the badge belongs to the choice being
                            // recommended rather than shouting next to it.
                            Text(badge)
                                .font(.system(size: 11 * k, weight: .bold)).foregroundColor(.white)
                                .padding(.horizontal, 7 * k).padding(.vertical, 3 * k)
                                .background(Capsule().fill(Self.accent))
                        }
                    }
                    Text(subtitle).font(.system(size: 13 * k)).foregroundColor(.white.opacity(0.6))
                    if cards {
                        HStack(spacing: 6 * k) {
                            ForEach(["Visa", "Mastercard", "Amex"], id: \.self) { name in
                                HStack(spacing: 3 * k) {
                                    Image(systemName: "creditcard.fill").font(.system(size: 10 * k))
                                    Text(name).font(.system(size: 10 * k, weight: .semibold))
                                }
                                .foregroundColor(.white.opacity(0.7))
                                .padding(.horizontal, 6 * k).padding(.vertical, 3 * k)
                                .background(RoundedRectangle(cornerRadius: 5 * k).fill(Color.white.opacity(0.1)))
                            }
                        }
                        .padding(.top, 2 * k)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(14 * k)
            .frame(maxWidth: .infinity, minHeight: 72 * k)   // equal height: Apple is never the smaller row
            .background(RoundedRectangle(cornerRadius: 16 * k).fill(Color.white.opacity(selected ? 0.10 : 0.05)))
            .overlay(RoundedRectangle(cornerRadius: 16 * k).stroke(selected ? Self.accent : Color.white.opacity(0.12), lineWidth: selected ? 2 : 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// THE MOMENT THE SAVING BECOMES CONCRETE. On web the Apple amount is
    /// struck through with $0.00 beside it, so the fee is shown being removed
    /// rather than merely absent. On Apple it stands, and the total below is
    /// the higher number. Neutral wording throughout: this is a fee the price
    /// includes, not something anyone is accused of charging extra.
    private var feeLine: some View {
        HStack {
            Text("Apple service fees")
                .font(.system(size: 14 * k)).foregroundColor(.white.opacity(0.7))
            Spacer()
            if method == .web {
                Text(saved.map(money) ?? "—")
                    .font(.system(size: 14 * k)).foregroundColor(.white.opacity(0.45))
                    .strikethrough(true, color: .white.opacity(0.45))
                    .monospacedDigit()
                Text(money(0))
                    .font(.system(size: 14 * k, weight: .semibold)).foregroundColor(Self.accent)
                    .monospacedDigit()
                    .padding(.leading, 8 * k)
            } else {
                Text(saved.map(money) ?? "—")
                    .font(.system(size: 14 * k)).foregroundColor(.white)
                    .monospacedDigit()
            }
        }
        .accessibilityIdentifier("checkout.fee")
    }

    private func totalLine(_ label: String, _ value: String, bold: Bool = false) -> some View {
        HStack {
            Text(label).font(.system(size: 14 * k, weight: bold ? .bold : .regular)).foregroundColor(.white.opacity(bold ? 1 : 0.7))
            Spacer()
            Text(value).font(.system(size: 14 * k, weight: bold ? .bold : .regular)).foregroundColor(.white)
                .monospacedDigit()
        }
    }

    /// The checkout URL for this item, composed the one way that works.
    ///
    /// THE APP_USER_ID GOES IN THE PATH, substituted into the template's
    /// `{app_user_id}`. Appending it as a query parameter instead leaves the
    /// path segment empty, so RevenueCat mints a NEW anonymous customer for the
    /// checkout and the purchase it completes is granted to nobody the app can
    /// see — the user pays and stays free.
    ///
    /// THE PACKAGE GOES IN THE QUERY, because the path is already spoken for.
    /// Without it the page cannot know which package it is selling.
    static func checkoutURL(template: String, appUserId: String, packageId: String) -> URL? {
        let path = template.replacingOccurrences(
            of: "{app_user_id}",
            with: appUserId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? appUserId)
        guard var c = URLComponents(string: path) else { return nil }
        var items = c.queryItems ?? []
        items.removeAll { $0.name == "package_id" }
        items.append(URLQueryItem(name: "package_id", value: packageId))
        c.queryItems = items
        return c.url
    }

    private func openWeb() {
        let appUserId = Purchases.shared.appUserID
        guard let url = Self.checkoutURL(template: item.web.url,
                                         appUserId: appUserId,
                                         packageId: item.packageId) else { return }
        Analytics.track("external_link_tap", props: ["surface": item.surface, "product": item.productId], durable: true)
        UIApplication.shared.open(url)   // Safari, the full browser — never SFSafariViewController
        onDismiss()
    }

    static let accent = Color(red: 0.42, green: 0.36, blue: 0.95)
}

/// Routes a purchase tap through the checkout step when the web option
/// applies to this storefront and product; straight to Apple otherwise.
enum CheckoutRouter {
    /// The smallest saving worth putting a badge on. Matches the server's
    /// floor so there is ONE definition of "worth claiming" across the two.
    static let minimumClaimablePct = 5

    /// Whether the web price beats the App Store price by enough to say so.
    /// Shared with the harness so the capture exercises the shipping decision
    /// rather than a copy of it. Fails closed on anything it cannot compute:
    /// the surface's whole claim is that the number is lower, so an unknown
    /// number is Apple only.
    static func savingIsWorthClaiming(applePrice: Decimal, webPrice: Decimal) -> Bool {
        guard applePrice > 0, webPrice < applePrice else { return false }
        let pct = ((applePrice - webPrice) / applePrice) * 100
        return Int(NSDecimalNumber(decimal: pct).doubleValue.rounded()) >= minimumClaimablePct
    }

    @MainActor
    static func item(for pkg: Package, tierNoun: String, surface: String) -> CheckoutItem? {
        guard let cfg = OnboardingState.shared.webCheckout,
              let web = cfg.product(forPackage: pkg.identifier) else { return nil }
        let sp = pkg.storeProduct

        // INTRO AGAINST INTRO, OR BASE AGAINST BASE — never one of each.
        // A first-time buyer is choosing between two first-period prices; a
        // returning one between two standard prices. Quoting Apple's intro
        // against the web's standard price manufactures a discount out of a
        // billing-period mismatch, and quoting it the other way hides a real
        // one. Intro applies only when BOTH sides have one and this customer
        // is eligible — eligibility is per-customer and only the client knows
        // it, which is why the server cannot decide this.
        let appleIntro = SubscriptionService.shared.isEligibleForIntro(sp)
            ? sp.introductoryDiscount : nil
        let useIntro = appleIntro != nil && web.webIntroPriceMicros != nil && web.webIntroPrice != nil
        let applyPrice: Decimal = useIntro ? (appleIntro?.price ?? sp.price) : sp.price
        let applyPriceText: String = useIntro
            ? (appleIntro?.localizedPriceString ?? sp.localizedPriceString)
            : sp.localizedPriceString
        let webMicros: Int? = useIntro ? web.webIntroPriceMicros : web.webPriceMicros
        let webText: String = useIntro ? (web.webIntroPrice ?? web.webPrice) : web.webPrice
        guard let micros = webMicros else { return nil }
        let webValue = Decimal(micros) / 1_000_000

        // A TRUE SAVING TOO SMALL TO CLAIM IS STILL NOT A CLAIM. Today the
        // annual web intro is $144.99 against Apple's $145.99 — a real 0.68%
        // that rounds to "save 1%", which reads as a gimmick and invites the
        // comparison it loses. Below the floor the step stays dark and the
        // purchase goes straight to Apple.
        guard savingIsWorthClaiming(applePrice: applyPrice, webPrice: webValue) else { return nil }
        return CheckoutItem(productId: sp.productIdentifier, packageId: pkg.identifier,
                            tierNoun: tierNoun, durationNoun: durationNoun(for: sp),
                            applePrice: applyPrice, applePriceText: applyPriceText,
                            webPrice: webValue, webPriceText: webText, isIntro: useIntro,
                            priceLocale: sp.priceFormatter?.locale ?? .current,
                            web: web, surface: surface)
    }

    /// "Year" / "Month" / "Week", from the product's own period — the CTA has
    /// to name what is being bought, not just the tier.
    static func durationNoun(for sp: StoreProduct) -> String {
        switch sp.subscriptionPeriod?.unit {
        case .year:  return String(localized: "Year")
        case .month: return String(localized: "Month")
        case .week:  return String(localized: "Week")
        case .day:   return String(localized: "Day")
        default:     return String(localized: "Plan")
        }
    }
}

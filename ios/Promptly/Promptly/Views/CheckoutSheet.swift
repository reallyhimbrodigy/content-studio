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
    let tierNoun: String            // "Pro" / "Max" / "credits" (localized by the caller)
    let applePrice: Decimal
    let applePriceText: String
    let priceLocale: Locale
    let web: WebCheckoutConfig.Product
    let savedPct: Int
    let surface: String
    var id: String { productId }
}

struct CheckoutSheet: View {
    @Environment(\.conversionScale) private var k
    let item: CheckoutItem
    let onApple: () -> Void
    let onDismiss: () -> Void
    @State private var method: Method = .web

    enum Method { case web, apple }

    private var webPrice: Decimal? { item.web.webPriceMicros.map { Decimal($0) / 1_000_000 } }
    private var saved: Decimal? { webPrice.map { item.applePrice - $0 } .flatMap { $0 > 0 ? $0 : nil } }
    private func money(_ d: Decimal) -> String {
        let f = NumberFormatter(); f.numberStyle = .currency; f.locale = item.priceLocale
        return f.string(from: d as NSDecimalNumber) ?? "\(d)"
    }
    private var subtotalText: String { item.web.webPrice }
    private var feesText: String { method == .apple ? (saved.map(money) ?? "—") : money(0) }
    private var totalText: String { method == .apple ? item.applePriceText : item.web.webPrice }

    var body: some View {
        VStack(spacing: 0) {
            Capsule().fill(Color.white.opacity(0.25)).frame(width: 36 * k, height: 5 * k).padding(.top, 8 * k)
            Text("Choose how to pay.")
                .font(.system(size: 22 * k, weight: .bold)).foregroundColor(.white)
                .padding(.top, 18 * k).padding(.bottom, 14 * k)
                .accessibilityIdentifier("checkout.title")

            VStack(spacing: 10 * k) {
                methodRow(.web, title: String(localized: "Pay on web"),
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
                totalLine(String(localized: "Apple fees"), feesText)
                Divider().overlay(Color.white.opacity(0.15))
                totalLine(String(localized: "Total"), totalText, bold: true)
                    .accessibilityIdentifier("checkout.total")
            }
            .padding(.horizontal, 24 * k).padding(.top, 18 * k)

            HStack(spacing: 10 * k) {
                Image(systemName: "tag.fill").foregroundColor(Self.accent)
                Text("Save \(item.savedPct)% when you pay on promptly.com.")
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
                Text("Pay and get \(item.tierNoun)")
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
                            Text(badge)
                                .font(.system(size: 11 * k, weight: .bold)).foregroundColor(.black)
                                .padding(.horizontal, 7 * k).padding(.vertical, 3 * k)
                                .background(Capsule().fill(Color(red: 0.98, green: 0.85, blue: 0.35)))
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

    private func totalLine(_ label: String, _ value: String, bold: Bool = false) -> some View {
        HStack {
            Text(label).font(.system(size: 14 * k, weight: bold ? .bold : .regular)).foregroundColor(.white.opacity(bold ? 1 : 0.7))
            Spacer()
            Text(value).font(.system(size: 14 * k, weight: bold ? .bold : .regular)).foregroundColor(.white)
                .monospacedDigit()
        }
    }

    private func openWeb() {
        let appUserId = Purchases.shared.appUserID
        let urlString = item.web.url.replacingOccurrences(of: "{app_user_id}", with: appUserId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? appUserId)
        guard let url = URL(string: urlString) else { return }
        Analytics.track("external_link_tap", props: ["surface": item.surface, "product": item.productId], durable: true)
        UIApplication.shared.open(url)   // Safari, the full browser — never SFSafariViewController
        onDismiss()
    }

    static let accent = Color(red: 0.42, green: 0.36, blue: 0.95)
}

/// Routes a purchase tap through the checkout step when the web option
/// applies to this storefront and product; straight to Apple otherwise.
enum CheckoutRouter {
    @MainActor
    static func item(for pkg: Package, tierNoun: String, surface: String) -> CheckoutItem? {
        guard let cfg = OnboardingState.shared.webCheckout,
              let web = cfg.product(for: pkg.storeProduct.productIdentifier) else { return nil }
        let sp = pkg.storeProduct
        return CheckoutItem(productId: sp.productIdentifier, tierNoun: tierNoun,
                            applePrice: sp.price, applePriceText: sp.localizedPriceString,
                            priceLocale: sp.priceFormatter?.locale ?? .current,
                            web: web, savedPct: cfg.savedPct, surface: surface)
    }
}

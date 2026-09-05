import Foundation
import StoreKit

/// THE STOREFRONT, from StoreKit and nothing else.
///
/// The web checkout is offered on the United States storefront only. That
/// decision is made on `Storefront.current` — the store the device's Apple
/// Account buys from — never on locale, language, or IP. A UK account on a
/// phone set to English (US) in New York is not a US storefront and sees
/// nothing (3.1.1 rejection if it did).
///
/// `-storefront XXX` (DEBUG) poses a code so both branches can be executed on
/// a simulator, whose store has no country.
@MainActor
final class StorefrontService: ObservableObject {
    static let shared = StorefrontService()
    /// ISO 3166-1 alpha-3, as StoreKit reports it ("USA"). nil until resolved.
    @Published private(set) var countryCode: String?
    private init() {}

    func resolve() async {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-storefront"), i + 1 < args.count {
            countryCode = args[i + 1].uppercased()
            return
        }
        #endif
        countryCode = await Storefront.current?.countryCode
    }
}

/// What the server says about paying on the web: dark unless it parses.
struct WebCheckoutConfig: Equatable {
    struct Product: Equatable {
        let webPrice: String          // display string from the web offering, e.g. "$246.99"
        let webPriceMicros: Int?      // for arithmetic; nil → no savings math, badge omitted
        let currency: String?
        let url: String               // "{app_user_id}" is substituted at tap time
    }
    let storefronts: [String]
    let savedPct: Int
    let products: [String: Product]

    init?(json: Any?) {
        guard let o = json as? [String: Any], let prods = o["products"] as? [String: Any] else { return nil }
        var map: [String: Product] = [:]
        for (id, v) in prods {
            guard let d = v as? [String: Any], let price = d["web_price"] as? String, let url = d["url"] as? String,
                  !price.isEmpty, !url.isEmpty else { continue }
            let micros = (d["web_price_micros"] as? Int) ?? (d["web_price_micros"] as? Double).map { Int($0) }
            map[id] = Product(webPrice: price, webPriceMicros: micros, currency: d["currency"] as? String, url: url)
        }
        guard !map.isEmpty else { return nil }
        storefronts = (o["storefronts"] as? [String])?.map { $0.uppercased() } ?? ["USA"]
        savedPct = (o["saved_pct"] as? Int) ?? (o["saved_pct"] as? Double).map { Int($0) } ?? 15
        products = map
    }

    /// The web product for `productId` on the CURRENT storefront, or nil.
    /// nil means: Apple only, exactly as before this feature existed.
    /// Main-actor: it reads StorefrontService, and every caller is a view.
    @MainActor
    func product(for productId: String) -> Product? {
        guard let sf = StorefrontService.shared.countryCode, storefronts.contains(sf) else { return nil }
        return products[productId]
    }
}

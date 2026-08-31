import Foundation
import RevenueCat

/// Credit balance — READ AND DISPLAY ONLY.
///
/// THE CLIENT CANNOT SPEND. RevenueCat's iOS SDK (5.75.0, confirmed in the tree)
/// exposes Virtual Currencies read-only: `virtualCurrencies()` and
/// `invalidateVirtualCurrenciesCache()`, and nothing else — no spend, debit,
/// adjust or grant anywhere in the SDK. The 10-credit debit happens server-side
/// at render dispatch and the refund happens server-side on failure
/// (SERVER_CREDITS_CONTRACT.md).
///
/// That split is right rather than merely imposed: a client-side debit is
/// trivially spoofable, and it would drift from the server's own render
/// accounting the first time a dispatch succeeded while the client died
/// mid-write. This type therefore never mutates a balance — it reads one, and
/// every number it shows came from RevenueCat.
@MainActor
final class CreditsService: ObservableObject {
    static let shared = CreditsService()

    /// The RevenueCat virtual-currency code. Dashboard-configured; if it is
    /// renamed there this stops resolving and the balance goes nil, which
    /// surfaces as "unknown" rather than as a confident zero. A zero we did not
    /// read is the one number that must never be displayed — it would tell a
    /// paying user they have nothing left.
    static let currencyCode = "CREDITS"

    /// Cost of one video. Flat, regardless of source length or route.
    static let perVideo = 10

    /// nil = not yet read, or unreadable. NOT zero. Every surface must treat
    /// nil as "don't know" and decline to block on it.
    @Published private(set) var balance: Int?
    @Published private(set) var lastReadFailed = false

    private init() {}

    /// Read the balance fresh. Called before showing the composer so the number
    /// is visible BEFORE the action rather than only after it — the spec's
    /// requirement, and the difference between a meter and a surprise.
    ///
    /// The cache is invalidated first: RevenueCat caches virtual currencies, and
    /// a stale balance shown before an action is worse than no balance, because
    /// the user makes a decision on it.
    func refresh() async {
        do {
            Purchases.shared.invalidateVirtualCurrenciesCache()
            let vc = try await Purchases.shared.virtualCurrencies()
            balance = vc[Self.currencyCode]?.balance
            lastReadFailed = (balance == nil)
        } catch {
            // A failed read is NOT a zero balance. Leave the last known value
            // in place and mark the failure — this project has already paid for
            // treating an unreadable metric as a confident zero.
            lastReadFailed = true
        }
    }

    /// Videos the current balance affords. nil when the balance is unknown.
    var videosRemaining: Int? {
        guard let b = balance else { return nil }
        return b / Self.perVideo
    }

    /// True only when we have READ a balance and it cannot cover one video.
    /// Deliberately false when the balance is unknown: an unread balance must
    /// never block a render.
    var isExhausted: Bool {
        guard let b = balance else { return false }
        return b < Self.perVideo
    }
}

/// Monthly allowance per tier, for display on the paywall.
///
/// Derived from the PRODUCTS StoreKit actually returns rather than a hardcoded
/// two-tier switch, so a third tier configured in the dashboard appears without
/// a client build — the spec's requirement for Max. The mapping lives here as a
/// lookup keyed on product identifier substring, with an explicit nil for
/// anything unrecognised: showing a made-up allowance for an unknown product is
/// worse than showing none, because it is a claim about what someone gets for
/// money.
enum CreditAllowance {
    static let free = 30
    private static let known: [(match: String, monthly: Int)] = [
        ("max", 1000),
        ("pro", 200),
    ]

    /// Monthly credits for a product id, or nil if we do not recognise it.
    static func monthly(forProductId id: String) -> Int? {
        let lower = id.lowercased()
        // Longest match first so "max" is not shadowed by a "pro" substring in
        // a product id like "promptly_pro_max_yearly".
        return known.first { lower.contains($0.match) }?.monthly
    }

    /// Videos per month for a product, for the paywall claim. nil = unknown, and
    /// the caller falls back to the non-numeric claim rather than inventing one.
    static func videos(forProductId id: String) -> Int? {
        monthly(forProductId: id).map { $0 / CreditsService.perVideo }
    }
}

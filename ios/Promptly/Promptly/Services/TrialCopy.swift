import Foundation

/// Pure, dependency-free paywall copy: the live monthly-equivalent anchor, the
/// post-purchase confirmation, and the fineprint. FREEMIUM model — there is NO
/// trial, so no trial-end reminder, no "start free trial", no trial dates.
///
/// (Type name kept as `TrialCopy` only so existing call sites don't churn; it
/// holds no trial copy.) Imports ONLY Foundation so it compiles and unit-tests
/// standalone with `swiftc` (see `Tests/run.sh`). The money-facing copy is the
/// last thing a user reads before committing, so it is verified independently.
enum TrialCopy {

    // MARK: - Monthly-equivalent anchor on the yearly plan (LIVE from StoreKit)

    /// The secondary line under a YEARLY plan: the honest per-month divisor of
    /// the annual sticker, so the full number stays but the sticker shock does
    /// not. `perMonthPrice` is RevenueCat's `localizedPricePerMonth` — already
    /// currency-formatted for the user's storefront (e.g. "$4.99", "₹499").
    /// Returns nil when unavailable so the caller renders nothing rather than a
    /// wrong or "$0.00/mo" line (the promise never exceeds the number).
    static func monthlyEquivalent(perMonthPrice: String?) -> String? {
        guard let p = perMonthPrice?.trimmingCharacters(in: .whitespacesAndNewlines),
              !p.isEmpty else { return nil }
        return "that's \(p)/mo, billed yearly"
    }

    /// Fallback anchor when RevenueCat's `localizedPricePerMonth` is nil: divide
    /// the CURRENT yearly price by 12 and format with the PRODUCT'S OWN formatter
    /// — currency + locale come from StoreKit, and the number tracks whatever the
    /// live yearly price is ($199.99→"$16.67" today; $399.99→"$33.33" after the
    /// scheduled change, with NO code edit). Never a hardcoded amount.
    static func monthlyEquivalent(fromYearlyPrice yearly: Decimal, using formatter: NumberFormatter) -> String? {
        guard yearly > 0 else { return nil }
        let perMonth = yearly / 12
        guard let formatted = formatter.string(from: perMonth as NSDecimalNumber) else { return nil }
        return monthlyEquivalent(perMonthPrice: formatted)
    }

    // MARK: - Weekly-equivalent anchor (conversion workstream: BOTH SKUs read
    // in weekly terms — the smallest honest unit leads; ruled 2026-08-21)

    /// The secondary line under the YEARLY plan in weekly terms. `perWeekPrice`
    /// is RevenueCat's `localizedPricePerWeek` — storefront-formatted. Same
    /// nil-over-wrong contract as the monthly anchor.
    static func weeklyEquivalent(perWeekPrice: String?) -> String? {
        guard let p = perWeekPrice?.trimmingCharacters(in: .whitespacesAndNewlines),
              !p.isEmpty else { return nil }
        return "that's \(p)/week, billed yearly"
    }

    /// Fallback when RC's `localizedPricePerWeek` is nil: yearly ÷ 52 with the
    /// product's own formatter — currency + locale from StoreKit, no literals.
    static func weeklyEquivalent(fromYearlyPrice yearly: Decimal, using formatter: NumberFormatter) -> String? {
        guard yearly > 0 else { return nil }
        let perWeek = yearly / 52
        guard let formatted = formatter.string(from: perWeek as NSDecimalNumber) else { return nil }
        return weeklyEquivalent(perWeekPrice: formatted)
    }

    // MARK: - Post-purchase confirmation (replaces the silent dismiss)

    static let confirmationTitle = "You're Pro"

    /// The unified post-purchase celebration title. One line, one voice — shared
    /// by every purchase surface (paywall sheet + upgrade wall) via
    /// ProCelebrationView so the "moment" reads identically no matter which
    /// surface triggered the buy.
    static let proMomentTitle = "You're on Promptly Pro"

    /// A direct purchase (no trial): name the exact recurring charge and the
    /// honest renewal note. `price` is the full localized price from StoreKit.
    static func confirmationBody(price: String) -> String {
        "You're all set — \(price) auto-renews until you cancel in Settings."
    }

    // MARK: - Fineprint (the required auto-renew disclosure)

    /// The legally required auto-renew disclosure. No trial, so no reminder line.
    static let fineprint = "Auto-renews until cancelled. Cancel anytime in Settings."
}

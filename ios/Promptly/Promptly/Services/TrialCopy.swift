import Foundation

/// Pure, dependency-free copy + date logic for the paywall "trust package":
/// the monthly-equivalent anchor, the trial-end reminder, the post-purchase
/// confirmation, and the fineprint.
///
/// Deliberately imports ONLY Foundation — no RevenueCat, SwiftUI, or
/// UserNotifications — so it compiles and unit-tests standalone with `swiftc`
/// (see `Tests/run.sh`). The money-facing copy is the last thing a user reads
/// before committing, so it is verified independently of the UI it renders in.
enum TrialCopy {

    /// Lead time before the trial expiry to fire the reminder. ~24h is the
    /// documented sweet spot: long enough to act, close enough to feel real.
    static let reminderLead: TimeInterval = 24 * 60 * 60

    // MARK: - Fix 1 · Monthly-equivalent anchor on the yearly plan

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
    /// the yearly price by 12 and format with the PRODUCT'S OWN formatter — so the
    /// currency and locale come from StoreKit ($199.99→"$16.67", ₹19,900→"₹1,658"),
    /// never an assumed `$`. A hardcoded currency here would re-commit the exact
    /// presentation sin the Trust Package exists to fix.
    static func monthlyEquivalent(fromYearlyPrice yearly: Decimal, using formatter: NumberFormatter) -> String? {
        guard yearly > 0 else { return nil }
        let perMonth = yearly / 12
        guard let formatted = formatter.string(from: perMonth as NSDecimalNumber) else { return nil }
        return monthlyEquivalent(perMonthPrice: formatted)
    }

    // MARK: - Fix 2 · Trial-end reminder

    /// When the local reminder should fire: `reminderLead` before the trial
    /// ends. Returns nil when that instant is already in the past (a trial with
    /// less remaining time than the lead) — the caller then skips scheduling
    /// instead of firing a notification in the past.
    static func reminderFireDate(trialEnd: Date, now: Date, lead: TimeInterval = reminderLead) -> Date? {
        let fire = trialEnd.addingTimeInterval(-lead)
        return fire > now ? fire : nil
    }

    static let reminderTitle = "Your Promptly trial ends tomorrow"

    /// Body of the pre-charge reminder. `price` is the full localized price
    /// that will be charged when the trial converts (e.g. "$59.99").
    static func reminderBody(price: String) -> String {
        "You'll be charged \(price) when your free trial ends — cancel in Settings before then to avoid it."
    }

    // MARK: - Fix 3 · Post-purchase confirmation (replaces the silent dismiss)

    static let confirmationTitle = "You're Pro 🎉"

    /// Certainty is the product here. For a trial we name the end date, the
    /// exact charge, and — only when a reminder was actually scheduled — the
    /// reminder promise, so the copy never claims a reminder we can't deliver.
    /// For a direct purchase, a plain renewal note.
    static func confirmationBody(isTrial: Bool,
                                 price: String,
                                 trialEnd: Date?,
                                 reminderScheduled: Bool,
                                 calendar: Calendar = .current,
                                 locale: Locale = .current) -> String {
        guard isTrial, let end = trialEnd else {
            return "You're all set — \(price) auto-renews until you cancel in Settings."
        }
        let day = longDate(end, calendar: calendar, locale: locale)
        let reminder = reminderScheduled ? " We'll remind you the day before." : ""
        return "Your free trial is active until \(day). You'll be charged \(price) on \(day) unless you cancel in Settings first.\(reminder)"
    }

    /// Shown on the confirmation screen only when the reminder could NOT be
    /// scheduled (notifications off) — an honest offer instead of a broken
    /// promise. Nil when a reminder is set (no nudge needed).
    static func confirmationReminderFallback(reminderScheduled: Bool, isTrial: Bool) -> String? {
        guard isTrial, !reminderScheduled else { return nil }
        return "Turn on notifications to get a reminder before your trial ends."
    }

    // MARK: - Fix 4 · Fineprint tone (disclosure + reassurance)

    /// Keeps the legally required auto-renew disclosure, but for a trial pairs
    /// it with the reminder reassurance so the last line read before committing
    /// isn't only a warning.
    static func fineprint(isTrial: Bool) -> String {
        isTrial
            ? "We'll remind you before your free trial ends. Auto-renews until cancelled — cancel anytime in Settings."
            : "Auto-renews until cancelled. Cancel anytime in Settings."
    }

    /// The short reassurance line under the CTA (trial only).
    static let ctaReassurance = "We'll remind you before your free trial ends — cancel anytime."

    // MARK: - Helpers

    /// Storefront-localized "July 20"-style date (month + day, no year).
    static func longDate(_ date: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        let f = DateFormatter()
        f.calendar = calendar
        f.locale = locale
        f.timeZone = calendar.timeZone
        f.setLocalizedDateFormatFromTemplate("MMMMd")
        return f.string(from: date)
    }
}

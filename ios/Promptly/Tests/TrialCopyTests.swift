import Foundation

// Standalone unit tests for the pure TrialCopy paywall-trust logic. No test
// target needed — TrialCopy is Foundation-only, so we compile it together with
// this file and run natively:
//
//   swiftc ../Promptly/Promptly/Services/TrialCopy.swift TrialCopyTests.swift -o /tmp/trialcopytest && /tmp/trialcopytest
//
// (or: ios/Promptly/Tests/run.sh). Exit code is non-zero if any check fails.

var failures = 0
var checks = 0

func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond { print("ok   - \(msg)") } else { failures += 1; print("FAIL - \(msg)") }
}

// Deterministic clock + calendar. UTC + en_US so date strings are stable
// regardless of the machine's region.
// Closure-initialized `let` (not a top-level statement) so it coexists with @main.
let utc: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "UTC")!
    return c
}()
let enUS = Locale(identifier: "en_US")

func date(_ y: Int, _ m: Int, _ d: Int, _ hh: Int = 12) -> Date {
    utc.date(from: DateComponents(year: y, month: m, day: d, hour: hh))!
}

@main
struct TrialCopyTestMain {
static func main() {

// MARK: Fix 1 — monthly-equivalent anchor
check(TrialCopy.monthlyEquivalent(perMonthPrice: "$4.99") == "that's $4.99/mo, billed yearly",
      "monthlyEquivalent formats a valid per-month price")
check(TrialCopy.monthlyEquivalent(perMonthPrice: "₹499") == "that's ₹499/mo, billed yearly",
      "monthlyEquivalent is currency-agnostic (uses RC's localized string verbatim)")
check(TrialCopy.monthlyEquivalent(perMonthPrice: nil) == nil,
      "monthlyEquivalent returns nil when RC gives no per-month price (no wrong line)")
check(TrialCopy.monthlyEquivalent(perMonthPrice: "   ") == nil,
      "monthlyEquivalent returns nil for a blank string")

// Fallback anchor (price ÷ 12 via the PRODUCT'S formatter) at the REAL prices —
// proves currency + locale come from StoreKit, never an assumed "$".
let usd = NumberFormatter()
usd.numberStyle = .currency; usd.currencyCode = "USD"; usd.locale = Locale(identifier: "en_US")
check(TrialCopy.monthlyEquivalent(fromYearlyPrice: Decimal(string: "399.99")!, using: usd)
      == "that's $33.33/mo, billed yearly",
      "$399.99/yr divides to $33.33/mo (real Promptly yearly price)")

let inr = NumberFormatter()
inr.numberStyle = .currency; inr.currencyCode = "INR"; inr.locale = Locale(identifier: "en_IN")
let inrExpectedPerMonth = inr.string(from: (Decimal(string: "19900")! / 12) as NSDecimalNumber)!
let inrLine = TrialCopy.monthlyEquivalent(fromYearlyPrice: Decimal(string: "19900")!, using: inr)!
check(inrLine == "that's \(inrExpectedPerMonth)/mo, billed yearly",
      "₹19,900/yr anchors via the product's own INR formatter, not a hardcoded currency")
check(inrLine.contains("₹") && !inrLine.contains("$"),
      "INR anchor renders ₹ and never a $ (India honesty, for free)")
check(TrialCopy.monthlyEquivalent(fromYearlyPrice: 0, using: usd) == nil,
      "zero/invalid yearly price yields no anchor")

// MARK: Fix 2 — reminder fire date
let end = date(2026, 7, 20, 13)          // trial ends Jul 20 13:00 UTC
let fire = TrialCopy.reminderFireDate(trialEnd: end, now: date(2026, 7, 17))
check(fire == end.addingTimeInterval(-24 * 3600), "reminderFireDate is exactly 24h before expiry")
check(fire! == date(2026, 7, 19, 13), "reminderFireDate lands on Jul 19 13:00 UTC")
// A trial with less than the lead remaining must NOT schedule a past notification.
check(TrialCopy.reminderFireDate(trialEnd: end, now: date(2026, 7, 20, 6)) == nil,
      "reminderFireDate is nil when the 24h mark already passed")
check(TrialCopy.reminderFireDate(trialEnd: end, now: end) == nil,
      "reminderFireDate is nil at/after expiry")
check(TrialCopy.reminderBody(price: "$59.99").contains("$59.99"),
      "reminderBody names the exact charge")
check(TrialCopy.reminderBody(price: "$59.99").lowercased().contains("cancel"),
      "reminderBody tells the user how to avoid the charge")

// MARK: Fix 3 — post-purchase confirmation
let bodyWithReminder = TrialCopy.confirmationBody(isTrial: true, price: "$59.99", trialEnd: end,
                                                  reminderScheduled: true, calendar: utc, locale: enUS)
check(bodyWithReminder.contains("July 20"), "confirmation names the trial-end date")
check(bodyWithReminder.contains("$59.99"), "confirmation names the exact charge")
check(bodyWithReminder.contains("remind you the day before"),
      "confirmation includes the reminder promise WHEN a reminder was scheduled")

let bodyNoReminder = TrialCopy.confirmationBody(isTrial: true, price: "$59.99", trialEnd: end,
                                                reminderScheduled: false, calendar: utc, locale: enUS)
check(!bodyNoReminder.contains("remind you the day before"),
      "confirmation OMITS the reminder promise when no reminder was scheduled (promise never exceeds mechanism)")

let paidBody = TrialCopy.confirmationBody(isTrial: false, price: "$59.99", trialEnd: nil,
                                          reminderScheduled: false, calendar: utc, locale: enUS)
check(paidBody.contains("auto-renews") && !paidBody.contains("trial"),
      "direct-purchase confirmation uses renewal copy, not trial copy")

check(TrialCopy.confirmationReminderFallback(reminderScheduled: false, isTrial: true) != nil,
      "confirmation offers a notifications nudge when the reminder couldn't be scheduled")
check(TrialCopy.confirmationReminderFallback(reminderScheduled: true, isTrial: true) == nil,
      "no notifications nudge when the reminder IS scheduled")
check(TrialCopy.confirmationReminderFallback(reminderScheduled: false, isTrial: false) == nil,
      "no notifications nudge for a non-trial purchase")

// MARK: Fix 4 — fineprint tone
let trialFine = TrialCopy.fineprint(isTrial: true)
check(trialFine.contains("remind you") && trialFine.contains("Auto-renews"),
      "trial fineprint pairs the reminder reassurance WITH the auto-renew disclosure")
check(!trialFine.hasSuffix("Settings.") || trialFine.contains("remind you"),
      "trial fineprint does not end on a bare warning")
check(TrialCopy.fineprint(isTrial: false) == "Auto-renews until cancelled. Cancel anytime in Settings.",
      "non-trial fineprint keeps the plain required disclosure")

// MARK: date helper
check(TrialCopy.longDate(date(2026, 12, 5), calendar: utc, locale: enUS) == "December 5",
      "longDate renders month + day, no year")

print("\n\(checks) checks, \(failures) failures")
if failures > 0 { exit(1) }
}
}

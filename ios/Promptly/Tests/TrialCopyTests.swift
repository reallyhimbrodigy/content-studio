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

// MARK: Weekly-equivalent anchor (ruled 2026-08-21: both SKUs in weekly terms)

check(TrialCopy.weeklyEquivalent(perWeekPrice: "$7.69") == "that's $7.69/week, billed yearly",
      "weeklyEquivalent formats a valid per-week price")
check(TrialCopy.weeklyEquivalent(perWeekPrice: "₹383") == "that's ₹383/week, billed yearly",
      "weeklyEquivalent is currency-agnostic (RC's localized string verbatim)")
check(TrialCopy.weeklyEquivalent(perWeekPrice: nil) == nil,
      "weeklyEquivalent returns nil when RC gives no per-week price (no wrong line)")
check(TrialCopy.weeklyEquivalent(perWeekPrice: "  ") == nil,
      "weeklyEquivalent returns nil for a blank string")
check(TrialCopy.weeklyEquivalent(fromYearlyPrice: Decimal(string: "399.99")!, using: usd)
      == "that's $7.69/week, billed yearly",
      "$399.99/yr divides to $7.69/week (real Promptly yearly price, ÷52)")
check(TrialCopy.weeklyEquivalent(fromYearlyPrice: 0, using: usd) == nil,
      "zero/invalid yearly price yields no weekly anchor")

// MARK: Post-purchase confirmation (FREEMIUM — no trial)
let paidBody = TrialCopy.confirmationBody(price: "$39.99")
check(paidBody.contains("$39.99"), "confirmation names the exact recurring charge")
check(paidBody.contains("auto-renews") && paidBody.lowercased().contains("cancel"),
      "confirmation uses plain renewal copy + how to cancel")
check(!paidBody.lowercased().contains("trial"),
      "confirmation contains NO trial language")
check(TrialCopy.confirmationTitle == "You're Pro",
      "confirmation title is the Pro celebration, no trial")

// MARK: Fineprint — the required auto-renew disclosure, no trial
check(TrialCopy.fineprint == "Auto-renews until cancelled. Cancel anytime in Settings.",
      "fineprint is the plain required disclosure")
check(!TrialCopy.fineprint.lowercased().contains("trial") && !TrialCopy.fineprint.lowercased().contains("remind"),
      "fineprint has NO trial / reminder language")

print("\n\(checks) checks, \(failures) failures")
if failures > 0 { exit(1) }
}
}

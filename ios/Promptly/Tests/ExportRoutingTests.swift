import Foundation

// Regression guard for the export-gate whitelist Zac flagged as the one thing
// that must be right before the 225 cut: a 402 must present the paywall and
// NEVER fall back to the free public save. If a 402 ever lands in a catch-all
// "error → fall back" arm, the shipped client defeats the paywall for every
// user until the next release — unfixable server-side.
//
// The Xcode project has no test target and APIService.swift can't compile
// standalone (URLSession + singleton deps), so this does two things with zero
// deps (the sanctioned pattern here — see UsageMeterRegressionTests.swift):
//   1. Asserts the pure decision INVARIANT the router must obey.
//   2. Greps the REAL APIService.exportAction(for:) so neither the "402 → paywall"
//      guarantee nor the "default is surfaceError, never fallback" catch-all
//      safety can silently regress.
//
//   swiftc ExportRoutingTests.swift -o /tmp/exporttest && /tmp/exporttest
// (wired into Tests/run.sh)

var failures = 0, checks = 0
func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond { print("ok   - \(msg)") } else { failures += 1; print("FAIL - \(msg)") }
}

// ── 1. The invariant, re-stated purely (mirrors APIService.exportAction) ──
// Four inputs the export-prep can fail with; exactly one action each.
enum Outcome { case entitlementRequired /*402*/, notAvailable /*404*/, network, other /*5xx/decode*/ }
enum Action: Equatable { case save, paywall, fallbackPublicSave, surfaceError }
func action(for o: Outcome) -> Action {
    switch o {
    case .entitlementRequired: return .paywall            // NEVER fallback
    case .notAvailable:        return .fallbackPublicSave // NULL key, old job
    case .network:             return .fallbackPublicSave
    case .other:               return .surfaceError       // do NOT silently free-save
    }
}
// The money assertion: a 402 goes to the paywall and is NOT a fallback.
check(action(for: .entitlementRequired) == .paywall, "402 → paywall")
check(action(for: .entitlementRequired) != .fallbackPublicSave,
      "402 NEVER falls back to the free public save")
check(action(for: .notAvailable) == .fallbackPublicSave, "404 (NULL key) → fall back to public save")
check(action(for: .network) == .fallbackPublicSave, "network error → fall back to public save")
check(action(for: .other) == .surfaceError, "5xx/decode → surface error, never free-save")
// Only the two explicit whitelist cases may fall back — nothing else.
for o in [Outcome.entitlementRequired, .notAvailable, .network, .other] {
    let fellBack = action(for: o) == .fallbackPublicSave
    let isWhitelisted: Bool
    switch o { case .notAvailable, .network: isWhitelisted = true; default: isWhitelisted = false }
    check(fellBack == isWhitelisted, "fallback happens for exactly the whitelist (404/network), not \(o)")
}

// ── 2. Grep the REAL router so the exact bug can't return ──
// #filePath = ios/Promptly/Tests/…  →  up twice = ios/Promptly/  →  Promptly/Services/…
let projectRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()   // Tests/
    .deletingLastPathComponent()   // ios/Promptly/
let apiPath = projectRoot.appendingPathComponent("Promptly/Services/APIService.swift")
if let src = try? String(contentsOf: apiPath, encoding: .utf8) {
    func has(_ pattern: String) -> Bool {
        src.range(of: pattern, options: .regularExpression) != nil
    }
    // The router exists and is the pure, total function under test.
    check(has(#"static func exportAction\(for error: Error\) -> ExportAction"#),
          "APIService.exportAction(for:) exists")
    check(has(#"enum ExportAction: Equatable \{ case save, paywall, fallbackPublicSave, surfaceError \}"#),
          "ExportAction has exactly the four expected cases")

    // 402 → paywall, and specifically NOT a fallback. This is the line whose
    // regression Zac said would defeat the paywall for every shipped client.
    check(has(#"case APIError\.paymentRequired:\s*return \.paywall"#),
          "402 (paymentRequired) → .paywall")
    check(!has(#"case APIError\.paymentRequired:\s*return \.fallbackPublicSave"#),
          "402 is NEVER wired to .fallbackPublicSave")

    // The catch-all is surfaceError — a 402 (or anything unrecognised) can never
    // slide into a fallback via `default`.
    check(has(#"default:\s*return \.surfaceError"#),
          "default arm is .surfaceError (unrecognised errors surface, never free-save)")
    check(!has(#"default:\s*return \.fallbackPublicSave"#),
          "default arm is NEVER .fallbackPublicSave (no catch-all free-save)")

    // The two explicit fallbacks are present and correctly targeted.
    check(has(#"case APIError\.exportNotAvailable:\s*return \.fallbackPublicSave"#),
          "404 (exportNotAvailable / NULL key) → .fallbackPublicSave")
    check(has(#"case is URLError:\s*return \.fallbackPublicSave"#),
          "network (URLError) → .fallbackPublicSave")
} else {
    check(false, "could not read APIService.swift at \(apiPath.path)")
}

print("\n\(checks - failures)/\(checks) passed")
exit(failures == 0 ? 0 : 1)

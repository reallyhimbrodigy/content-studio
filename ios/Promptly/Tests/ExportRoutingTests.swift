import Foundation

// Load-bearing unit test for the export-gate whitelist Zac flagged as the one
// thing that must be right before the 225 cut: a 402 must present the paywall and
// NEVER fall back to the public save. If a 402 ever lands in a catch-all
// "error → fall back" arm, the shipped client defeats the paywall for every user
// until the next release — unfixable server-side.
//
// ExportRouting + APIError were extracted into their own Foundation-only files
// (like PaywallRouting / EntitlementTier) so this test EXERCISES THE REAL router
// against the REAL error types — not a grepped copy:
//
//   swiftc ../Promptly/Promptly/Services/APIError.swift \
//          ../Promptly/Promptly/Services/ExportRouting.swift \
//          ExportRoutingTests.swift -o /tmp/exporttest && /tmp/exporttest
// (wired into Tests/run.sh). Exit code is non-zero if any check fails.

var failures = 0, checks = 0
func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond { print("ok   - \(msg)") } else { failures += 1; print("FAIL - \(msg)") }
}

@main
struct ExportRoutingTestMain {
static func main() {

// ── 1. Behavioural: feed the REAL error each HTTP outcome produces, assert action ──
// A 402 (server: not entitled) → paywall, and specifically NOT a fallback. This is
// the money assertion; the shipped client must never free-save on a 402.
let paymentErr = APIError.paymentRequired(kind: "export", limit: nil, message: "x")
check(ExportRouting.action(for: paymentErr) == .paywall,
      "402 (paymentRequired) → .paywall")
check(ExportRouting.action(for: paymentErr) != .fallbackPublicSave,
      "402 NEVER falls back to the public save")

// A 404 (server: clean_export_key is NULL, an old job) → fall back to public save.
check(ExportRouting.action(for: APIError.exportNotAvailable) == .fallbackPublicSave,
      "404 (exportNotAvailable) → .fallbackPublicSave")

// Network error → fall back (offline user can still save the public asset).
check(ExportRouting.action(for: URLError(.notConnectedToInternet)) == .fallbackPublicSave,
      "network (URLError.notConnectedToInternet) → .fallbackPublicSave")
check(ExportRouting.action(for: URLError(.timedOut)) == .fallbackPublicSave,
      "network (URLError.timedOut) → .fallbackPublicSave")

// A 500 / decode / anything unrecognised → surface an error, do NOT free-save.
check(ExportRouting.action(for: APIError.jobCreationFailed("500")) == .surfaceError,
      "5xx-class APIError → .surfaceError")
check(ExportRouting.action(for: APIError.jobCreationFailed("500")) != .fallbackPublicSave,
      "5xx-class APIError NEVER free-saves")
let foreign = NSError(domain: "SomeDecode", code: 99)
check(ExportRouting.action(for: foreign) == .surfaceError,
      "unrecognised error → .surfaceError (no catch-all free-save)")
check(ExportRouting.action(for: foreign) != .fallbackPublicSave,
      "unrecognised error NEVER free-saves")

// Only 404 + network may fall back — assert the whole whitelist behaviourally.
let cases: [(String, Error, Bool)] = [
    ("402", paymentErr, false),
    ("404", APIError.exportNotAvailable, true),
    ("network", URLError(.cannotConnectToHost), true),
    ("5xx", APIError.jobCreationFailed("500"), false),
    ("foreign", foreign, false),
]
for (name, err, mayFallBack) in cases {
    let fellBack = ExportRouting.action(for: err) == .fallbackPublicSave
    check(fellBack == mayFallBack, "fallback whitelist: \(name) fallBack=\(fellBack) (expected \(mayFallBack))")
}

// ── 2. Belt-and-braces grep — covers the ONE hop the behavioural test can't reach ──
// exportJob maps the HTTP status → APIError (needs URLSession, so not standalone).
// Pin that 402→paymentRequired / 404→exportNotAvailable mapping so a 402 can't be
// re-tagged into the fallback lane upstream of the router.
let root = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()   // Tests/
    .deletingLastPathComponent()   // ios/Promptly/
let apiPath = root.appendingPathComponent("Promptly/Services/APIService.swift")
if let src = try? String(contentsOf: apiPath, encoding: .utf8) {
    func has(_ p: String) -> Bool { src.range(of: p, options: .regularExpression) != nil }
    // 402 status → paymentRequired (kind "export"), NOT exportNotAvailable.
    check(has(#"statusCode == 402"#) && has(#"throw APIError\.paymentRequired"#),
          "exportJob maps HTTP 402 → APIError.paymentRequired")
    // 404 status → exportNotAvailable (the explicit NULL-key fallback).
    check(has(#"statusCode == 404"#) && has(#"throw APIError\.exportNotAvailable"#),
          "exportJob maps HTTP 404 → APIError.exportNotAvailable")
} else {
    check(false, "could not read APIService.swift at \(apiPath.path)")
}

print("\n\(checks - failures)/\(checks) passed")
if failures > 0 { exit(1) }
}
}

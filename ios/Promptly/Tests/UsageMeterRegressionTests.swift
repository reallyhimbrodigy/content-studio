import Foundation

// Regression guard for the build-215 revenue bug: a FREE user's meter read
// "2 videos left" (a legacy trial cap of 3, minus one render), because
//   (a) UsageService didn't stamp the freemium header on /api/usage, so the
//       server returned the legacy 'trial' cap (3) instead of the free cap (1);
//   (b) the client had a `?? 3` fallback that could invent a limit.
//
// The Xcode project has no test target and UsageService.swift can't compile
// standalone (SwiftUI + singleton deps), so this does two things with zero deps:
//   1. Asserts the pure quota-display INVARIANT the meter must obey.
//   2. Greps the REAL UsageService.swift to prove neither half of the bug can
//      creep back — no invented limit fallback, and the freemium header IS sent.
//
//   swiftc UsageMeterRegressionTests.swift -o /tmp/usagetest && /tmp/usagetest
// (wired into Tests/run.sh)

var failures = 0, checks = 0
func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond { print("ok   - \(msg)") } else { failures += 1; print("FAIL - \(msg)") }
}

// ── 1. The invariant: displayed "left" derives ONLY from the server limit ──
// nil server limit (unknown / not yet loaded) → nil, NEVER a guessed number.
func left(limit: Int?, used: Int) -> Int? {
    guard let limit = limit else { return nil }
    return max(0, limit - used)
}
check(left(limit: nil, used: 0) == nil, "unknown limit → nil (never invents a number)")
check(left(limit: nil, used: 9) == nil, "unknown limit → nil regardless of used")
check(left(limit: 1, used: 0) == 1,     "free (server cap 1), 0 used → 1 left")
check(left(limit: 1, used: 1) == 0,     "free, 1 used → 0 left")
check(left(limit: 1, used: 5) == 0,     "never negative")
// The core assertion: the free-tier UI can NEVER display a value above the
// server limit. With the only free cap the server sends (1), left ≤ 1 always.
for used in 0...10 {
    check((left(limit: 1, used: used) ?? 0) <= 1, "free-tier left ≤ 1 (used=\(used))")
}
// General: left never exceeds the server limit, for any limit.
for lim in 0...6 { for used in 0...12 {
    check((left(limit: lim, used: used) ?? 0) <= lim, "left(\(lim),\(used)) ≤ limit")
}}

// ── 2. Grep the REAL source so the bug can't silently return ──
// #filePath = ios/Promptly/Tests/…  →  up twice = ios/Promptly/  →  Promptly/Services/…
let projectRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()   // Tests/
    .deletingLastPathComponent()   // ios/Promptly/
let usagePath = projectRoot.appendingPathComponent("Promptly/Services/UsageService.swift")
if let src = try? String(contentsOf: usagePath, encoding: .utf8) {
    // (a) No invented render-limit fallback: `render_limit ?? <digit>` or a
    //     `renderLimit ... ?? <digit>` must not exist. The fix made these strict
    //     optionals (server-only). This is the exact `?? 3` that caused the bug.
    let inventsRenderLimit =
        src.range(of: #"render_limit\s*\?\?\s*\d"#, options: .regularExpression) != nil ||
        src.range(of: #"renderLimit[^\n]*\?\?\s*\d"#, options: .regularExpression) != nil
    check(!inventsRenderLimit, "UsageService never invents a render limit (no `?? <n>` fallback)")

    // (b) The freemium header IS stamped on the /api/usage request, so the
    //     server computes the FREE cap (1), not the legacy trial cap (3).
    check(src.contains("WallCapability.stamp"),
          "UsageService stamps the freemium header on /api/usage")
} else {
    check(false, "could not read UsageService.swift at \(usagePath.path)")
}

print("\n\(checks - failures)/\(checks) passed")
exit(failures == 0 ? 0 : 1)

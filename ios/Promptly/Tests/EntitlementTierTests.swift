import Foundation

// Standalone unit tests for the pure EntitlementTier composition rule. No test
// target needed — it's Foundation-only:
//
//   swiftc ../Promptly/Promptly/Services/EntitlementTier.swift EntitlementTierTests.swift -o /tmp/tiertest && /tmp/tiertest
//
// (or: ios/Promptly/Tests/run.sh). Exit code is non-zero if any check fails.

var failures = 0
var checks = 0
func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond { print("ok   - \(msg)") } else { failures += 1; print("FAIL - \(msg)") }
}

@main
struct EntitlementTierTestMain {
static func main() {

// The privilege ordering IS the case order.
check(EntitlementTier.none < .trial && EntitlementTier.trial < .paid,
      "ordering: none < trial < paid")

// Most-privileged wins — agreement cases.
check(EntitlementTier.resolve(rc: .paid, server: .paid) == .paid, "both paid → paid")
check(EntitlementTier.resolve(rc: .trial, server: .trial) == .trial, "both trial → trial")
check(EntitlementTier.resolve(rc: .none, server: .none) == .none,
      "both stale/expired (none, none) → none: the wall")

// The named disagreement cases — where the sync-gap history says reality pokes.
check(EntitlementTier.resolve(rc: .trial, server: .paid) == .paid,
      "RC trial vs server paid → paid (server ahead — never under-serve a payer)")
check(EntitlementTier.resolve(rc: .none, server: .trial) == .trial,
      "RC nil vs server trial → trial (RC cache cold; server knows the trial)")
check(EntitlementTier.resolve(rc: .paid, server: .trial) == .paid,
      "RC paid vs server trial → paid (RC ahead of a webhook lag)")
check(EntitlementTier.resolve(rc: .trial, server: .none) == .trial,
      "RC trial vs server none → trial (trial started RC-side before the webhook)")
check(EntitlementTier.resolve(rc: .paid, server: .none) == .paid,
      "RC paid vs server none → paid (just purchased; server not synced yet)")
check(EntitlementTier.resolve(rc: .none, server: .paid) == .paid,
      "RC nil vs server paid → paid (comp / legacy / server self-heal)")

// resolve is symmetric (it's a max) — argument order never changes the answer.
check(EntitlementTier.resolve(rc: .trial, server: .paid) == EntitlementTier.resolve(rc: .paid, server: .trial),
      "resolve is symmetric in rc/server")

// Server `/api/usage` string parse.
check(EntitlementTier.fromServer("paid") == .paid, "fromServer: paid")
check(EntitlementTier.fromServer("trial") == .trial, "fromServer: trial")
check(EntitlementTier.fromServer("none") == .none, "fromServer: none")
check(EntitlementTier.fromServer("  PAID ") == .paid, "fromServer: case-insensitive + trimmed")
check(EntitlementTier.fromServer(nil) == .none, "fromServer: nil → none (field absent on an old server)")
check(EntitlementTier.fromServer("garbage") == .none, "fromServer: unknown → none (server signal fails closed)")

print("\n\(checks) checks, \(failures) failures")
if failures > 0 { exit(1) }
}
}

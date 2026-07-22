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

// ── Capability truth table (mirrors lib/tier-capabilities.js, every cell) ──
check(EntitlementTier.none.appUsable == false && EntitlementTier.trial.appUsable && EntitlementTier.paid.appUsable,
      "appUsable: none=false (→wall), trial=true, paid=true")
check(EntitlementTier.none.uploadMax == 0 && EntitlementTier.trial.uploadMax == 1 && EntitlementTier.paid.uploadMax == 10,
      "upload max: none=0, trial=1, paid=10")
check(EntitlementTier.none.canUpload(1) == false && EntitlementTier.trial.canUpload(1) && !EntitlementTier.trial.canUpload(2)
      && EntitlementTier.paid.canUpload(10) && !EntitlementTier.paid.canUpload(11),
      "canUpload: none blocks all, trial exactly 1, paid up to 10")
check(EntitlementTier.none.canRender(todayRenders: 0) == false,
      "canRender: none blocked even at 0 used (the wall, not a cap)")
check(EntitlementTier.trial.canRender(todayRenders: 2) && !EntitlementTier.trial.canRender(todayRenders: 3),
      "canRender: trial allows the 3rd, blocks the 4th")
check(EntitlementTier.paid.canRender(todayRenders: 9999), "canRender: paid unlimited")
check(EntitlementTier.none.canChat(todayChats: 0) == false && EntitlementTier.trial.canChat(todayChats: 49)
      && !EntitlementTier.trial.canChat(todayChats: 50) && EntitlementTier.paid.canChat(todayChats: 100000),
      "canChat: none blocked, trial to 50, paid unlimited")
check(EntitlementTier.none.canReedit == false && EntitlementTier.trial.canReedit == false && EntitlementTier.paid.canReedit,
      "re-edit: paid only")
check(EntitlementTier.none.canUseLumen == false && EntitlementTier.trial.canUseLumen == false && EntitlementTier.paid.canUseLumen,
      "lumen: paid only")
check(EntitlementTier.none.limitHitRouting == .wall && EntitlementTier.trial.limitHitRouting == .paywall
      && EntitlementTier.paid.limitHitRouting == .unused,
      "limit-hit routing: none→wall, trial→paywall, paid→unused")

// ── FREEMIUM 'free' tier (2026-07-21) ──────────────────────────────────────
check(EntitlementTier.fromServer("free") == .free, "fromServer: 'free' → .free")
check(EntitlementTier.none < .free && EntitlementTier.free < .trial && EntitlementTier.trial < .paid,
      "privilege order: none < free < trial < paid")
check(EntitlementTier.free.appUsable, "free is USABLE (freemium is never a wall)")
check(EntitlementTier.free.capabilities.renderLimit == 2 && EntitlementTier.free.uploadMax == 1,
      "free: 2 renders/day, 1 upload")
check(!EntitlementTier.free.canReedit && !EntitlementTier.free.canUseLumen,
      "free: no re-edit, no Lumen")
check(EntitlementTier.free.canRender(todayRenders: 1) && !EntitlementTier.free.canRender(todayRenders: 2),
      "free: allows the 2nd, blocks the 3rd")
check(EntitlementTier.free.limitHitRouting == .paywall, "free: limit → upgrade paywall, never wall")
// The client composes RC(non-pro = .none) with server 'free' → .free (most-privileged wins).
check(EntitlementTier.resolve(rc: .none, server: .free) == .free, "resolve(.none, .free) → .free")
check(EntitlementTier.resolve(rc: .paid, server: .free) == .paid, "resolve(.paid, .free) → .paid (pro wins)")

print("\n\(checks) checks, \(failures) failures")
if failures > 0 { exit(1) }
}
}

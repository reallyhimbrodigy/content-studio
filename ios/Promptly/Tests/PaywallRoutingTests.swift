import Foundation

// Standalone unit tests for the pure PaywallRouting state machine — the
// wedge/deferral core of the RACE 1 / RACE 2 fixes. UI-free, so:
//
//   swiftc ../Promptly/Promptly/Services/PaywallRouting.swift PaywallRoutingTests.swift -o /tmp/prtest && /tmp/prtest
//
// (or: ios/Promptly/Tests/run.sh). Exit code is non-zero if any check fails.

var failures = 0
var checks = 0
func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond { print("ok   - \(msg)") } else { failures += 1; print("FAIL - \(msg)") }
}

@main
struct PaywallRoutingTestMain {
static func main() {

// Baseline present: nothing showing → shows directly, no re-drive.
var r = PaywallRouting<String>()
r.request("reedit")
check(r.reason == "reedit", "request on empty presents directly")
check(r.needsRedrive == false, "no re-drive needed from empty")
check(r.parked == nil, "nothing parked")

// RACE 2 shape — request after the blocking sheet has already dismissed
// (onDismiss deferral) is just a normal present.
var r2 = PaywallRouting<String>()
r2.request("reedit")
check(r2.reason == "reedit", "RACE2: onDismiss→request presents the paywall")

// RACE 1 shape — park behind the full-screen player, present on its dismissal.
var r1 = PaywallRouting<String>()
r1.park("reedit")
check(r1.reason == nil, "RACE1: parked request shows nothing while the player is up")
check(r1.parked == "reedit", "RACE1: request is parked, not dropped")
r1.flush()
check(r1.reason == "reedit", "RACE1: player dismissal flushes the parked paywall — presents EVERY time")
check(r1.parked == nil, "RACE1: parked cleared after flush")

// flush with nothing parked is a harmless no-op (normal player close).
var r3 = PaywallRouting<String>()
r3.flush()
check(r3.reason == nil && r3.parked == nil, "flush with nothing parked is a no-op")

// THE WEDGE: a stale reason left by a dropped sheet must not mute a later
// request — it flags a re-drive so the mirror forces a re-present.
var w = PaywallRouting<String>()
w.request("reedit")          // dropped sheet leaves this stale
w.request("dailyRenders")    // a later, different trigger
check(w.reason == "dailyRenders", "wedge: later trigger overwrites a stale reason")
check(w.needsRedrive == true, "wedge: non-nil→non-nil flags a re-drive (can't be muted)")
w.redriveHandled()
check(w.needsRedrive == false, "mirror clears the re-drive flag after re-driving")

// Re-requesting the SAME reason does not need a re-drive (no pointless flicker).
var s = PaywallRouting<String>()
s.request("manual")
s.request("manual")
check(s.needsRedrive == false, "same reason twice: no re-drive")

// Dismiss clears state; anything queued behind it is promoted, never lost.
var d = PaywallRouting<String>()
d.request("reedit")
d.park("manual")             // a second request arrived while the first was up
d.dismissed()
check(d.reason == "manual", "dismiss promotes a queued request instead of losing it")
check(d.parked == nil, "queued request cleared once promoted")

// Plain dismiss with nothing queued goes empty.
var d2 = PaywallRouting<String>()
d2.request("reedit")
d2.dismissed()
check(d2.reason == nil, "dismiss with nothing queued clears the paywall")

print("\n\(checks) checks, \(failures) failures")
if failures > 0 { exit(1) }
}
}

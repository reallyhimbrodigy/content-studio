import Foundation

// Export gate_probe — unit tests for the pure decision parser
// (SERVER_CONTRACTS_226 confirming line). No device, no server: this is exactly
// the "verify the paywall branch today, zero flips" the probe unlocks. The parser
// maps the dry-run (status, body) to allowed / gated / indeterminate, and
// `wouldGate` decides whether to present the paywall (fail-open on ambiguity).
//
//   swiftc ../Promptly/Services/ExportGateProbe.swift ExportGateDecisionTests.swift \
//          -o /tmp/gateprobetest && /tmp/gateprobetest
// (wired into Tests/run.sh)

var failures = 0, checks = 0
func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond { print("ok   - \(msg)") } else { failures += 1; print("FAIL - \(msg)") }
}

@main
struct ExportGateDecisionTestMain {
    static func main() {
        func body(_ s: String) -> Data { Data(s.utf8) }

        // 200 Pro → allowed, never a paywall.
        let pro = ExportGateDecision.from(status: 200, body: body(#"{"allowed":true,"tier":"paid","reason":"pro"}"#))
        check(pro == .allowed(tier: "paid"), "200 → allowed(paid)")
        check(!pro.wouldGate, "allowed never gates (no paywall for Pro)")
        check(pro.tier == "paid", "allowed carries tier")

        // 402 free → gated, present the paywall.
        let free = ExportGateDecision.from(status: 402, body: body(#"{"allowed":false,"tier":"free","reason":"out of free exports"}"#))
        check(free == .gated(tier: "free", reason: "out of free exports"), "402 → gated(free, reason)")
        check(free.wouldGate, "gated presents the paywall")
        check(free.tier == "free", "gated carries tier")

        // Bodies missing/partial → fall back to the tier the status implies.
        check(ExportGateDecision.from(status: 200, body: body("{}")) == .allowed(tier: "paid"),
              "200 with empty body defaults to allowed(paid)")
        check(ExportGateDecision.from(status: 402, body: body("{}")) == .gated(tier: "free", reason: nil),
              "402 with empty body defaults to gated(free, nil)")
        check(ExportGateDecision.from(status: 200, body: body("not json")) == .allowed(tier: "paid"),
              "unparseable body → status-implied (allowed)")

        // Gate-dark / auth / route / server → indeterminate, fail-OPEN (no paywall).
        for status in [401, 404, 500, 501, -1] {
            let d = ExportGateDecision.from(status: status, body: body(""))
            check(d == .indeterminate(status: status), "\(status) → indeterminate")
            check(!d.wouldGate, "indeterminate never gates (fail-open, status \(status))")
            check(d.tier == nil, "indeterminate has no tier (status \(status))")
        }

        print("\n\(checks - failures)/\(checks) passed")
        exit(failures == 0 ? 0 : 1)
    }
}

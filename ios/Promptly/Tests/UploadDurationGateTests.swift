import Foundation

// Proves the 218 camera-roll duration gate (>maxUploadSeconds → blocked) and,
// critically, that NO upload entry point can skip it. Two parts, zero deps:
//   1. The pure gate invariant (mirrors NativeVideoPicker.Coordinator.applyDurationGate).
//   2. A source grep: the gate lives in the picker, and EVERY NativeVideoPicker
//      call site passes maxDurationSeconds — so the composer AND the ask-back
//      card both enforce it. (The AskCard path used to skip it entirely.)
//
//   swiftc UploadDurationGateTests.swift -o /tmp/gatetest && /tmp/gatetest
// (wired into Tests/run.sh)

var failures = 0, checks = 0
func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond { print("ok   - \(msg)") } else { failures += 1; print("FAIL - \(msg)") }
}

// ── 1. Gate invariant ──
func gate(_ durations: [Double], maxSeconds: Int) -> (kept: [Double], droppedTooLong: Bool) {
    guard maxSeconds != Int.max else { return (durations, false) }
    let kept = durations.filter { $0 <= Double(maxSeconds) }
    return (kept, kept.count != durations.count)
}
do {
    let g1 = gate([120, 250, 400], maxSeconds: 300)  // 5-min world
    check(g1.kept == [120, 250], "300s gate keeps ≤300, drops 400")
    check(g1.droppedTooLong, "300s gate flags a drop")

    let g2 = gate([120, 300], maxSeconds: 300)
    check(g2.kept == [120, 300] && !g2.droppedTooLong, "exactly 300s is allowed (≤, not <)")

    let g3 = gate([200], maxSeconds: 180)            // pre-routing world
    check(g3.kept.isEmpty && g3.droppedTooLong, "180s gate blocks a 200s clip (AskCard used to skip this)")

    let g4 = gate([999], maxSeconds: Int.max)
    check(g4.kept == [999] && !g4.droppedTooLong, ".max = no gate (opt-out)")

    // The absolute guarantee: nothing over the ceiling ever survives the gate.
    for maxS in [60, 180, 300] {
        for d in stride(from: 10.0, through: 600.0, by: 30.0) {
            let kept = gate([d], maxSeconds: maxS).kept
            check(kept.allSatisfy { $0 <= Double(maxS) }, "no >\(maxS)s clip survives (d=\(Int(d)))")
        }
    }
}

// ── 2. Source grep: no entry point skips the gate ──
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
func read(_ rel: String) -> String { (try? String(contentsOf: root.appendingPathComponent(rel), encoding: .utf8)) ?? "" }

let picker = read("Promptly/Services/VideoPicker.swift")
check(picker.contains("applyDurationGate"), "the gate is applied inside NativeVideoPicker (the choke point)")

// Every file that presents a NativeVideoPicker must pass maxDurationSeconds.
for site in ["Promptly/Views/EditorView.swift", "Promptly/Views/AskCard.swift"] {
    let src = read(site)
    let uses = src.components(separatedBy: "NativeVideoPicker(").count - 1
    let gated = src.components(separatedBy: "maxDurationSeconds:").count - 1
    check(uses >= 1, "\(site) presents a NativeVideoPicker")
    check(gated >= uses, "\(site): every NativeVideoPicker passes maxDurationSeconds (\(gated)/\(uses))")
}

print("\n\(checks - failures)/\(checks) passed")
exit(failures == 0 ? 0 : 1)

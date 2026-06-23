import Foundation

// Standalone unit tests for the pure TricklePacing math. The Xcode project has
// no test target, and these need none — the type is Foundation-only, so we
// compile it together with this file and run natively:
//
//   swiftc ../Promptly/Views/TricklePacing.swift TricklePacingTests.swift -o /tmp/pacingtest && /tmp/pacingtest
//
// (or: ios/Promptly/Tests/run.sh). Exit code is non-zero if any check fails.

var failures = 0
var checks = 0

func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond {
        print("ok   - \(msg)")
    } else {
        failures += 1
        print("FAIL - \(msg)")
    }
}

func approx(_ a: Double, _ b: Double, _ tol: Double) -> Bool { abs(a - b) <= tol }

/// Run the animator forward `seconds` at 30fps, feeding time-varying backend
/// values and completion. Returns the full displayed-value trace plus the
/// largest single-frame increase seen.
func simulate(_ p: TricklePacing,
              seconds: Double,
              start: Double = 0,
              startElapsed: Double = 0,
              backend: (Double) -> Double,
              complete: (Double) -> Bool = { _ in false }) -> (trace: [Double], maxJump: Double, minDelta: Double) {
    let dt = 1.0 / 30.0
    var displayed = start
    var trace = [displayed]
    var maxJump = 0.0
    var minDelta = Double.greatestFiniteMagnitude
    var t = startElapsed
    let steps = Int(seconds * 30)
    for _ in 0..<steps {
        t += dt
        let next = p.advance(displayed: displayed,
                             elapsed: t,
                             backendBar: backend(t),
                             dt: dt,
                             isComplete: complete(t))
        let delta = next - displayed
        maxJump = max(maxJump, delta)
        minDelta = min(minDelta, delta)
        displayed = next
        trace.append(displayed)
    }
    return (trace, maxJump, minDelta)
}

// A realistic backend trace: the worker front-loads bar points, then crawls
// through the long render. Values are the post-mapping bar numbers and jump in
// big discrete steps — exactly the input that used to make the bar leap.
func realisticBackend(_ t: Double) -> Double {
    switch t {
    case ..<8:   return 0       // pre-first-heartbeat
    case ..<20:  return 33      // download
    case ..<35:  return 37      // transcribe
    case ..<70:  return 56      // plan  (big jump 37 -> 56)
    case ..<110: return 66      // broll (jump 56 -> 66)
    case ..<320: return 75      // render start (jump 66 -> 75), then crawls
    case ..<360: return 90      // render finishing
    case ..<380: return 94      // thumbnail
    default:     return 97      // upload
    }
}

let p = TricklePacing()

@main
struct TricklePacingTestMain {
static func main() {

// 1. Kickstart — the bar shows a small non-zero value immediately.
check(approx(p.target(elapsed: 0, backendBar: 0, isComplete: false), p.kickstart, 0.001),
      "target at t=0 equals kickstart (\(p.kickstart))")
let kick = simulate(p, seconds: 0.5, backend: { _ in 0 })
check(kick.trace.last! >= 1.5,
      "bar reaches >=1.5 within 0.5s from a dead 0 start (got \(kick.trace.last!))")

// 2. Monotonic — never reverses across a full realistic run.
let run = simulate(p, seconds: 390, backend: realisticBackend)
check(run.minDelta >= -1e-9,
      "bar never decreases across a 6.5min run (min frame delta \(run.minDelta))")

// 3. Smoothness — no big per-frame jump even though backend leaps 37->56->66->75.
//    This is the literal "no 25->45 leap" guarantee.
check(run.maxJump <= 1.0,
      "no single in-progress frame jumps more than 1.0pt (max \(run.maxJump))")

// 4. Time-driven, not backend-driven — halfway through the estimate the bar is
//    near half of scheduledCap, NOT pinned to the high backend value (75).
let mid = simulate(p, seconds: 195, backend: { _ in 75 })
check(approx(mid.trace.last!, p.scheduledCap / 2, 4.0),
      "at estimate/2 the bar tracks time (~\(p.scheduledCap/2)), not backend 75 (got \(mid.trace.last!))")

// 5. Anti-stall tether — backend stuck at 50 forever: bar holds near 50+margin,
//    never marches toward 90+.
let stall = simulate(p, seconds: 1200, backend: { _ in 50 })
check(stall.trace.last! <= 50 + p.overshootMargin + 0.5,
      "stalled backend (50) holds bar <= \(50 + p.overshootMargin) (got \(stall.trace.last!))")
check(stall.trace.last! > 50,
      "stalled bar still leads the last milestone a little (got \(stall.trace.last!))")

// 6. Overrun creep — running long with a high backend: bar creeps past
//    scheduledCap but never reaches 100 while incomplete.
let overrun = simulate(p, seconds: 1500, backend: { _ in 97 })
check(overrun.trace.last! > p.scheduledCap && overrun.trace.last! < 100,
      "overrun creeps above \(p.scheduledCap) but stays < 100 (got \(overrun.trace.last!))")
check(overrun.trace.last! <= p.hardCap + 1e-6,
      "overrun never exceeds hardCap \(p.hardCap) (got \(overrun.trace.last!))")

// 7. Early completion rush — completing from a low value sweeps to exactly 100
//    within about a second, monotonic, never overshooting.
let finish = simulate(p, seconds: 1.2, start: 41, startElapsed: 180, backend: { _ in 95 }, complete: { _ in true })
check(finish.trace.last! == 100,
      "early completion reaches exactly 100 within ~1.2s (got \(finish.trace.last!))")
check(finish.trace.allSatisfy { $0 <= 100 + 1e-9 },
      "completion rush never overshoots 100")
let early = simulate(p, seconds: 0.9, start: 41, startElapsed: 180, backend: { _ in 95 }, complete: { _ in true })
check(early.trace.last! >= 99.9,
      "completion rush is >=99.9 by 0.9s (got \(early.trace.last!))")
// Tighter: even from a low start the rush lands within the ~0.7s pre-reveal
// hold, so the bar reaches 100 before the video is swapped in.
let rush = simulate(p, seconds: 0.65, start: 41, startElapsed: 180, backend: { _ in 95 }, complete: { _ in true })
check(rush.trace.last! >= 99.9,
      "completion rush from a low start reaches >=99.9 within 0.65s (got \(rush.trace.last!))")

// 8. Completion snaps cleanly to 100 (no asymptotic 99.97 forever).
let snap = p.advance(displayed: 99.93, elapsed: 200, backendBar: 100, dt: 1.0/30.0, isComplete: true)
check(snap == 100, "advance snaps to exactly 100 when complete and within reach (got \(snap))")

print("\n\(checks - failures)/\(checks) checks passed")
exit(failures == 0 ? 0 : 1)

}
}

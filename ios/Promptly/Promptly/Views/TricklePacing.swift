import Foundation

// MARK: - TricklePacing
//
// Pure, clock-free pacing math for the render progress bar. No SwiftUI, no
// Combine, no timers — just `(elapsed, backendBar, isComplete) -> bar value`.
// Kept dependency-free on purpose so it can be unit-tested with `swiftc`
// directly (see ios/Promptly/Tests). The stateful animator lives in
// TrickleProgress (MessageBubble.swift); this struct only decides where the
// bar *should* be on any given frame.
//
// Design (per the deterministic-timer brainstorm):
//   - PRIMARY driver is time. The bar fills smoothly toward `scheduledCap`
//     over `estimateSeconds` (a fixed ~6.5 min), then creeps toward
//     `hardCap`. This is the "slow, smooth 1-2-3" the user asked for.
//   - Backend pct is NOT a floor — feeding it in as a floor is what made the
//     bar jump (the worker front-loads bar points: 0->66 in the first ~40% of
//     wall-clock, then crawls 75->94 through the long render). Instead it is a
//     CEILING TETHER: the bar may sit at most `overshootMargin` past the last
//     confirmed backend milestone. In a normal run the time schedule stays
//     *below* the backend value, so the tether never binds and the fill is
//     pure smooth time. If the job runs slower than the estimate (or hangs),
//     the bar fills only `overshootMargin` past the last real milestone and
//     then holds — so it never marches a lie to 95% on a stall.
//   - On real completion the cap releases and the bar eases quickly to 100.
//
// Monotonic by construction: `target` is non-decreasing in (elapsed,
// backendBar) and `advance` never returns less than `displayed`.
struct TricklePacing {
    /// Typical end-to-end job duration the bar is paced against (seconds).
    var estimateSeconds: Double = 390      // 6.5 min
    /// The bar fills linearly to this over `estimateSeconds`, leaving a clean
    /// runway above it for the overrun creep and the completion rush.
    var scheduledCap: Double = 90
    /// Absolute ceiling before real completion — never reached until done.
    var hardCap: Double = 99
    /// Bar may lead the last confirmed backend milestone by at most this.
    var overshootMargin: Double = 12
    /// Shown immediately so the bar never looks dead at 0%.
    var kickstart: Double = 2
    /// Time constant (seconds) for the post-estimate creep from
    /// `scheduledCap` toward `hardCap`.
    var overrunTau: Double = 90
    /// Gap-closure rate (per second) while the job runs. High enough that the
    /// rare tether/ceiling correction is absorbed in well under a second.
    var easePerSecond: Double = 5
    /// Faster gap-closure for the finish rush so an early completion sweeps
    /// up to 100 in ~0.5s (deliberate ease-out, not a snap) — fast enough to
    /// land and hold a beat at 100 within the ~0.7s pre-reveal window even
    /// from a low start.
    var completeEasePerSecond: Double = 12

    /// Where the bar *should* be this frame, ignoring the current displayed
    /// value. Non-decreasing in both `elapsed` and `backendBar`.
    func target(elapsed: Double, backendBar: Double, isComplete: Bool) -> Double {
        if isComplete { return 100 }
        let t = max(0, elapsed)
        // Linear time fill 0 -> scheduledCap over the estimate.
        let base = scheduledCap * min(1, t / estimateSeconds)
        // After the estimate, keep inching toward hardCap so a long job never
        // looks frozen — but asymptotically, so it never claims done.
        let overrun = t > estimateSeconds
            ? (hardCap - scheduledCap) * (1 - exp(-(t - estimateSeconds) / overrunTau))
            : 0
        let schedule = max(kickstart, base + overrun)
        // Anti-stall tether: never sit more than `overshootMargin` past the
        // last confirmed backend milestone. In a normal run the schedule is
        // below `backendBar`, so this never binds.
        let tether = backendBar + overshootMargin
        return min(hardCap, min(schedule, tether))
    }

    /// Move `displayed` one frame toward `target(...)`. Monotonic (never below
    /// `displayed`) and capped (< 100 until `isComplete`, == 100 at the end).
    func advance(displayed: Double, elapsed: Double, backendBar: Double, dt: Double, isComplete: Bool) -> Double {
        let ceiling = isComplete ? 100.0 : hardCap
        // Monotonic: the goal is never below where we already are.
        let goal = min(ceiling, max(displayed, target(elapsed: elapsed, backendBar: backendBar, isComplete: isComplete)))
        let gap = goal - displayed
        if gap <= 0.0001 { return displayed }
        // Exponential ease toward the goal. The in-progress goal rises smoothly
        // (the time schedule), so `displayed` tracks it with negligible lag;
        // the faster `completeEasePerSecond` only kicks in for the finish rush.
        let ease = isComplete ? completeEasePerSecond : easePerSecond
        let step = gap * (1 - exp(-ease * max(0, dt)))
        let next = displayed + step
        // Snap the last sliver of the completion rush so it lands on exactly
        // 100 instead of asymptotically approaching 99.97.
        if isComplete && next >= 99.9 { return 100 }
        return min(ceiling, next)
    }
}

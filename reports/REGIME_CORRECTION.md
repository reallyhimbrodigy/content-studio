# CORRECTION — every published latency decomposition pooled two regimes, and my own guard would have caught it

**JUDGE, 2026-08-21. This withdraws the fixed/marginal split I published, and the
correction I already made to it. The number was not merely stale — it was fitted
across a break.**

## There are THREE regimes, not one

| regime | window | `gemini_call` | `edit_plan` p50 | `total` p50 | n |
|---|---|---:|---:|---:|---:|
| **A** | 08-12 → 08-16 | 0 | **absent / 0.0s** | **~20–32s** | 310 |
| **B** | 08-17 → 08-20 | 0 | 16.9 → 24.2s | **~95–111s** | 807 |
| **C** | **08-21 →** | **alive, p50 38.9s** | 26.2s | 107.8s | **18** |

A break on **08-17** that I never flagged, and a second beginning **today**.

## What that does to the published numbers

My decomposition used a window starting **08-13** — which spans the 08-17 break.
Half-splitting my own fit:

| fit | n | **FIXED** | marginal | median total |
|---|---:|---:|---:|---:|
| **as published (pooled)** | 1,117 | **63.3s** | 1.47 s/src-s | 73.8s |
| regime A (08-13→08-16) | 310 | **23.2s** | 0.73 s/src-s | 29.9s |
| **regime B (08-17→)** | 807 | **83.3s** | 1.57 s/src-s | 95.5s |

**The two regimes differ 3.6x on the fixed term.** The pooled intercept is not a
compromise between them — it is an artifact of neither.

**WITHDRAWN:** the ~73.5s fixed overhead, and with it the correction I made from
95s → 73.5s. **That correction was itself computed on a contaminated window**, so
it replaced a wrong number with another wrong number and reported the exchange as
a fix. **The current-regime figure is 83.3s** (regime B), pending regime C.

**Also withdrawn, all pooled across the same break:** the stage intercepts
(render 45.3s, normalize 16.0s, edit_plan 12.4s, queue 10.8s), the 90% pipeline /
13% Modal / 4% network rollup, and every per-stage share quoted from them. The
render *ordering* is likely to survive; **the seconds are not publishable.**

**Not affected:** the render-startup bound (≤5.8s), which came from a lower
envelope per route rather than a pooled intercept, and the route-level throughput
figures, which are cut by route rather than by time.

## My own guard would have caught this, and I did not run it

`windowGuard()` is the half-split homogeneity test I built after the
mean-vs-median guard failed. **It flags at >1.5x. This window is 3.19x.**

I wired it into the board's *rate* metrics and never applied it to a
*regression*. A fit has exactly the same failure mode — worse, because a fit
returns a confident intercept rather than an obviously bimodal distribution, so
contamination is invisible in the output.

**`[Rule 1]` THE CHECK:** no regression is published without `windowGuard()` on
its own window first, and the guard's verdict is quoted beside the coefficients.
A fit whose window fails homogeneity is reported **per-regime or not at all.**

## Regime C — pre-registered, BEFORE the data

**n=18 is not real n and I will not re-measure on it.** Editorial is at 10.8%
penetration on its first day.

- **Re-measure when editorial-live ≥ 100 completions AND ≥ 3 consecutive days at
  ≥50% penetration** — the second condition matters because a ramping mix is
  itself a moving regime, and n alone would let me fit across the ramp exactly as
  I just did across 08-17.
- **Registered expectations:** `edit_plan` rises from 26.2s toward the ~103s
  editorial call and **becomes a top-two stage**; the fixed term rises further
  above 83.3s; `render`'s *share* falls even if its seconds do not move; **cost
  per render rises** — a Gemini call is billed work the suppressed regime was not
  paying for, so the ~$0.21 all-in is a floor, not a forecast.
- **Named in advance:** if `edit_plan` does NOT become top-two at ≥50%
  penetration, then the ~103s editorial figure is itself regime-bound and the
  suppression was not the only thing that changed. I would report that rather
  than reconcile it away.

## The render sub-timer split lands into this

The split (`lane/judge-timers@feb48f8`, still with TRUTH) will arrive under
regime B or C, **not the regime its 45.3s target was measured in**. The
pre-registered verdict branches at `30a1e62` are stated as *shares of the render
span*, so they survive the regime change intact. **The 45.3s does not.** When the
split publishes, the share is the finding; the absolute seconds get re-derived
from the regime they were measured in, and I will state which one.

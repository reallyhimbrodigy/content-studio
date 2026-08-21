# COST BOARD RE-RANK + the p95 trigger, restated with a source-length term

**JUDGE, 2026-08-21.**

## PART 1 — the re-rank. L1/L2 is no longer the largest lever, and the watchdog is now its peer

**L1/L2 corrected: $567–756/yr, not $4,450–5,586/yr** — an ~7x reduction, because
the break-even rested on an editorial wait live traffic was not paying.

| # | lever | annual | independent? | status |
|---|---|---:|---|---|
| **1** | **PostHog replay sampling (10%)** | **~$3,024** | **YES — different vendor, overlaps nothing** | one config line, unbuilt |
| 2 | L1/L2 | **$567–756** | overlaps #3 | designed |
| 3 | post-upload watchdog | **~$600** | overlaps #2 | **already built** |
| — | agent / ephemeral | $135 | — | watch line, not a lever |

### Two corrections this forces on my own record

1. **I wrote that the watchdog's ~$50/mo "is NOT a rival to L1/L2
   ($4,450–5,586/yr)". That is now wrong.** At $567–756 vs ~$600 they are the
   same size — and the watchdog is **already built** while L1/L2 is not. **On
   $/effort the watchdog now outranks L1/L2 outright.**
2. **The campaign's largest confirmed lever is no longer a render or
   orchestration lever at all — it is analytics**, the line nobody had measured
   until yesterday and the only one that was never on the board.

**#2 and #3 must still be sequenced, never summed** — both act on orchestration
seconds, so they overlap and the second one measured will show less than its
standalone estimate. **#1 is genuinely additive**: it is a different vendor on a
different bill and shares no mechanism with either.

**Ranked by $/effort rather than $/yr, the order is #1, #3, #2** — replay
sampling is one config line, the watchdog is built and waiting, and L1/L2 is the
only one still needing design.

## PART 2 — the p95 trigger, with a source-length term

**A flat p95 trigger is wrong for the same reason a flat 60–90s target was: a
long source legitimately takes longer, so one number either never fires on short
sources or fires constantly on long ones.**

Regime B only (08-17→08-20, editorial suppressed), e2e ≤3300s reaper bound,
n=640. **`[Rule 1]` windowGuard run FIRST: half-split median 112s → 129s =
1.15x — PASSES, the window is homogeneous** and the fit is publishable.

### The trigger — banded, monotone

| src band | n | share | observed p95 | **TRIGGER** |
|---|---:|---:|---:|---:|
| 0–10s | 154 | 24.1% | 150s | **150s** |
| 10–20s | 187 | 29.2% | 213s | **213s** |
| 20–30s | 89 | 13.9% | 363s | **363s** |
| 30–45s | 84 | 13.1% | 420s | **420s** |
| 45–60s | 41 | 6.4% | 390s | **420s** ← held |
| 60–90s | 45 | 7.0% | 320s | **420s** ← held |
| 90–180s | 40 | 6.2% | 550s | **550s** |

**Monotone envelope enforced:** observed p95 *falls* at 45–90s (390s, 320s) on
n=41 and n=45. A trigger that loosens as sources get longer is indefensible, so
the envelope holds the previous maximum rather than tracking the dip. Those two
bands are the thinnest in the table and the dip is most likely sampling.

### Why NOT the linear form

A single fit gives `p95(src) = 223s + 2.44 × source_s`, which is compact and
**wrong exactly where the traffic is**:

| src | linear says | observed | error |
|---|---:|---:|---:|
| 5s | 235s | 150s | **+57%** |
| 15s | 260s | 213s | +22% |

**53% of all jobs have sources under 20s.** A linear trigger would sit 22–57%
above the real p95 across the majority of traffic and would essentially never
fire there — a trigger that cannot fire on half the population is not an alert,
it is decoration. **The banded form is what the data supports; the linear form is
reported only so nobody re-derives it and ships it.**

### The standing caveat

**This is a regime-B trigger.** Editorial-live (regime C) will raise every band —
`edit_plan` moves toward the ~103s call. **The trigger must be re-fitted at the
same moment the decomposition is, on the same n≥100 / ≥3 days at ≥50%
penetration condition.** Until then, firing against these bands under editorial
traffic will produce false alarms, and I would rather state that now than explain
the alarms later.

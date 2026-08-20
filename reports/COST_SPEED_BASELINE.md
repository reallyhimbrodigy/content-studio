# COST & SPEED — the honest baseline, the gap, and the ranked levers

**JUDGE, 2026-08-20. Standing ownership. These two numbers lead every report
from here.**

## THE HEADLINE

| | target | measured | gap |
|---|---|---|---|
| **SPEED** (20–30s source) | **60–90s** e2e | **128s p50** (n=134) | **+38s** |
| **COST** | driven down | **~$0.21/render** all-in [OWNER-SUPPLIED invoice] | — |

## 1. BASELINE — e2e by source duration, real traffic since 08-13

| source band | n | **p50** | vs 90s |
|---|---:|---:|---:|
| 0–10s | 505 | 113s | +23s |
| 10–20s | 317 | 108s | +18s |
| **20–30s (THE TARGET)** | **134** | **128s** | **+38s** |
| 30–60s | 203 | 192s | +102s |
| 60s+ | 93 | 214s | +124s |

**p95 is deliberately omitted.** It computes to 71,196s (≈20 hours) in the
target band — the late-sweep contamination class: `completed_at` stamped days
later by a reaper does not mean a user waited days. I capped this for failed-job
seconds and had not yet capped it for e2e. **Until it is capped, p95 on this
board is not a number.** p50 is unaffected.

**Speed scales with source length**, which the flat 60–90s target does not: the
target is met by nobody today, and the 20–30s band is the third-fastest of five.

## 2. THE GAP, DECOMPOSED — and the stated lever does NOT hold in production

Worker-wall decomposition, target cohort:

| stage | p50 | share of worker wall |
|---|---:|---:|
| **render** | **72.4s** | **76.7%** |
| normalize_transcribe_upload | 21.8s | 23.1% |
| **edit_plan** | **18.4s** | **19.5%** |
| upload_export | 5.0s | 5.3% |
| hls | 2.3s | 2.5% |
| worker wall total | ~94s | 100% |

**e2e 128s − worker wall ~94s = ~34s outside the worker** (queue + delivery).

> ⚠️ **THE "EDITORIAL CALL IS 54% OF WALL" LEVER DOES NOT REPRODUCE IN
> PRODUCTION, AND THE REASON IS DECISIVE.** `gemini_call` p50 = **0.0s** across
> 371 rows. **The editorial path is SUPPRESSED in live traffic** — these are
> deterministic plans. In this regime `edit_plan` is **19.5%** and `render` is
> **76.7%**.
>
> The 54% figure is real, and it is from the **editorial-LIVE** regime
> (build-lane, 103s of 248s). Both are true of different regimes.
> **Quoting the editorial-live share against production numbers would send the
> work at a call that is not currently running.**

**The degeneration tax is likewise UNMEASURABLE in production right now:**
**0 of 251** jobs carry a single `degen_retry`; `gemini_wasted_degen` is 0 on
every row. Not because it was fixed — **because there is no editorial call to
degenerate.** The 287s-of-789s figure stands for the editorial-live regime and
must be re-measured the moment editorial goes live, not assumed dead.

**So the gap to 60–90s has two different decompositions:**

- **Production today (editorial suppressed):** render 76.7% is the lever. Even
  at zero queue the worker wall (~94s) already exceeds the 90s ceiling by itself.
  **The target cannot be met by trimming overhead; render has to come down.**
- **Editorial live:** the 103s call becomes 54% and *is* the lever, and the
  degen tax reappears with it.

## 3. RANKED COST LEVERS — against the invoice, not a model

Invoice anchor (per-function, cycle-to-date): **orchestration 72.3%** ·
rendering 9.6% · validator 9.1% · prewarm 9.0%. **We spend 7.5× more
orchestrating renders than rendering them.**

| rank | lever | acts on | invoice-anchored value | condition |
|---|---|---|---|---|
| **1** | **L1/L2 orchestrator split** | orchestration (72.3%) | **$4,450–$5,586/yr** (current-window basis) | ⚠️ **see below** |
| 2 | render-path work | rendering (9.6%) | ≤ $57/cycle even if eliminated | unconditional |
| 3 | validator | 9.1% | ≤ $54/cycle | unconditional |
| 4 | prewarm | 9.0% | ≤ $54/cycle | unconditional |

> ⚠️ **L1/L2's break-even condition is NOT satisfied in the current production
> regime.** Its 12.9s break-even is net-positive *only where the wait is long*,
> and the stated justification is "the 97s editorial call now satisfies it."
> **In production the editorial call is 0.0s.** L1/L2 remains the largest lever
> **by invoice share**, but its *realised* value depends on a wait that live
> traffic is not currently paying. **Re-measure the break-even against the
> editorial-live regime before banking the $4,450–$5,586.**

Levers 2–4 are bounded by arithmetic: **eliminating any one of them entirely
saves less than a quarter of L1/L2's low estimate.** There is no second lever of
comparable size, which is unchanged.

## WHAT I WILL ADD WHEN THE NEW WORK LANDS

- **Cutaways by source, cost-attributed**: user-frame = free; generated = ~$0.14
  + quota. Reported per source, never blended.
- **Craft cost in wall clock**: motion blur and eased entrances measured as
  seconds added, so a 20s craft cost is a trade made knowingly.
- **The four-law line every round**: $/render · p50/p95 · quality read · error
  surface — with the number, not the direction.

## STANDING CAVEATS APPLIED TO MY OWN NUMBERS

$0.21/render is **[OWNER-SUPPLIED]**, not [MEASURED-BY-ME] — `modal billing
report --csv` is the only truth and remains unpulled from this lane. Every
bottom-up figure is **[LOWER-BOUND]** and does not rank. Cohorts are cut since
08-13 to sit clear of the deploy boundary. Cycle-average vs recent-slice is
stated wherever a $/render appears.

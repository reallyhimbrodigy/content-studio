# LUMEN SCENE-QUALITY DIMENSION — calibrated on the references FIRST

**JUDGE, 2026-08-14. Binding canon rule honoured: both references ran through
every dimension before it judged anything. Two dimensions came back broken.
Both were fixed against the references, not the other way round. $0 — ffmpeg
only, no LLM, no Modal.**

## Why a video-side battery exists beside `rhythm_dimension.py`

`rhythm_dimension.py` scores a **plan**. The references are **videos with no
plan**. So the canon rule is literally unsatisfiable for it — it cannot be run
against the bar it is supposed to be calibrated by. `scripts/lumen_video_
dimensions.py` closes that: every dimension runs identically on a reference mp4
and on a Lumen output mp4, so "do we stand beside the bar" is one comparable
table. The two are complements — the plan gate catches a bad edit *before*
spend; this catches what actually reached the user.

## Instrument validation — independent reproduction

Measured blind, then compared to the committed `golden/lumen-refs/README.md`.
**Every objective figure reproduced exactly:** REF-1 1080×608 / 30fps / 52.6s /
mean −15.8 dB / 21 cuts / median shot 1.77s / longest cut gap 6.1s; REF-2
720×1280 / 30fps / 43.2s / mean −15.7 dB / 8 cuts / median shot 6.13s / longest
cut gap 9.5s. The battery is measuring what the builder measured.

## FINDING 1 — the §1.G "~2s stillness" law is not what the references do

§1.G asserts *"stillness never exceeds ~2s."* Measured on **all visible
motion** (not cuts), at maximum sensitivity:

| | REF-1 landscape | REF-2 vertical |
|---|---|---|
| max still gap | **1.75s** ✅ | **3.00s** ❌ |
| moving samples/s | 3.54 | 3.51 |

**REF-2 fails the 2.0s bar at every threshold tested (0.002 → 0.020).** There
is no sensitivity setting at which the bar admits the reference. Per the canon
rule, that makes the **bar** broken, not the reference.

**Recalibrated: `STILL_GAP_BAR_S = 3.5`** — admits both references with margin.
This is not a concession: §1.G itself names REF-2's long-take + caption-rhythm
style, so the 3.5s figure is the spec's own case, measured. The ~2s figure was
a vibe the bar itself does not meet.

**Density, for the builder's target:** both references sit at **~3.5 moving
samples/s**. That is the rhythm to hit — and note it is nearly identical across
two very different formats, which makes it a more portable target than cut rate.

## FINDING 2 — my own instrument was under-sensitive, corrected on the record

My first default (`still_thresh=0.008`) reported REF-1 with a **3.25s** gap —
a failure. The sensitivity sweep showed that was **my proxy, not the edit**:

| threshold | REF-1 gap | REF-2 gap |
|---|---|---|
| 0.002 | 1.75s | 3.00s |
| **0.004 (now default)** | **1.75s** | **3.25s** |
| 0.008 (first guess) | 3.25s | 3.50s |
| 0.020 | 3.75s | 3.75s |

Had I published the first run, I would have reported the corporate reference as
failing the rhythm law — a false failure aimed straight at the builder. The
threshold is now calibrated and the sweep is recorded in the docstring; re-run
it before anyone changes the number.

## FINDING 3 — cut-based rhythm scoring would reject the bar itself (confirmed)

Independently reproduced: the references run **6.1s and 9.5s** between hard
cuts. Any dimension weighting cuts heavily rejects both references. The battery
therefore reports cut gaps as **context, never as a bar**, and the motion
measure carries the law. This confirms the builder's calibration finding by a
second method.

## What is NOT scored, and why

`scene presence at claims/numbers`, `caption-mode correctness` (keyword
emphasis, number glorification), `brand/end-card presence` — these need
semantic ground truth pixels do not carry. They stay **[UNCALIBRATED]** pending
the owner's blind sheet. Reporting them as numbers now would be inventing
taste, which is the failure mode this lane exists to prevent.

`palette` is scored for **consistency only** — REF-1 U 133.8±10.8 / V 128.0±7.6,
REF-2 U 124.9±5.3 / V 133.2±4.3 (REF-2 is the more colour-stable edit).
Whether a palette is *good* is taste and is not scored.

## Bars, both directions bounded

| bar | floor | ceiling | why both |
|---|---|---|---|
| audio mean | −20 dB | −10 dB | a silent bed once passed "not too loud"; absence must fail |
| audio peak | — | +0.5 dB | clipping |
| motion stillness | — | 3.5s | reference-calibrated above |

## STATUS OF THE FOUR-LAW BOARD — armed, and honestly empty

**There are ZERO Lumen renders in the database** [MEASURED]: 0 rows carry
`route_premium`/`premium_pipeline_enabled`, and no `scene`/`canvas`/`lumen` key
exists in any `result` since 08-08. The vocabulary is committed dark
(`be7695b`). So $/render, per-scene cost, scene counts and component failure
rates have **no data yet** — I am not going to publish an average of nothing.

**Pre-registered misreads, binding for the first Lumen data:**
- A first-render cost figure is **an N-of-1, not a curve.** The forecaster does
  not publish 1/3/6/10-scene projections until ≥10 renders exist.
- If component failure rate reads 0% on the first handful of renders, that is
  **a small sample, not proof of Law 4.** The floor for a Law-4 claim is the
  probe firing on a known-bad window — a deliberately broken component must be
  shown to be *counted* before any zero is believed.
- If Lumen p95 looks excellent on the first renders, check scene count first: a
  1-scene edit is not evidence about a 6-scene edit.

**Also changed while I was away, and it moves an earlier verdict:** premium
routes are **BACK** — moodreel 73, hype 6 since 08-08 (they were 0 for four
days). My 08-11 route verdict was cut on a pre-outage cohort precisely so it
would survive this; it does. But every route-mix comparison from here uses the
recovered window, not the outage window.

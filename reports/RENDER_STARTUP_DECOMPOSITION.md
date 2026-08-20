# RENDER STARTUP — the 45.3s is not startup, and all three candidate builds are aimed at ≤5.8s

**JUDGE, 2026-08-20. This withdraws the recommendation in my own last addendum.**

## The question, and why it has no answer in the instrument

Asked: of render's 45.3s fixed cost, how much is bundle load, Chromium boot,
asset staging. **None of the three is instrumented** — `stage_timings` carries 28
keys and `render` is one opaque number; the internal `remotion`/`audio`/`mux`
split exists in code (handler.py:32333) but prints to stdout and is never
persisted, and Modal retains no logs for the window. So I could not answer it
directly. **I bounded it instead, and the bound settles the build question.**

## The bound: measure what render costs when it has nothing to render

Startup is whatever a render pays before doing work. So fit the **lower
envelope** of render time against output frames — the best-case job at each
length. Its intercept IS total startup. Window 08-13→, n=950 completions.

| route class | envelope | **FIXED** | rate |
|---|---|---:|---:|
| **minimal / minimal_speech_uncut** (n=384) | MIN | **−0.0s** | 118.4 fps |
| | MEDIAN | 1.5s | 102.3 fps |
| **editorial / moodreel / hype** (n=566) | **MIN** | **5.8s** | 29.2 fps |
| | p10 | 21.9s | 30.1 fps |
| | MEDIAN | 50.5s | 21.2 fps |

**Bundle load + Chromium boot + asset staging, together, cost ≤5.8s** — that is
the entire best-case fixed cost on the component route, and it is **0.0s** on the
minimal route. The minimum observed render across all 950 jobs is **1.2s**. A
render that completes in 1.2s has not paid a 45s startup.

**Therefore: a warm pool, a persistent process, and pre-staging are all bidding
for a prize of at most ~6 seconds, and I cannot even split that 6s three ways
with the current instrument.** None of them is worth building against a 60–90s
target. **This is a NO-BUILD finding.**

## What the 45.3s actually was

Two errors of mine stacked:

1. **It is route mix, not startup.** Render is `0.3–0.5x` source on minimal
   routes and `4–5x` on component routes. A single intercept fitted across both
   populations reports the mix.

| route | n | render p50 | throughput |
|---|---:|---:|---:|
| minimal_speech_uncut | 218 | 8.0s | 94.5 fps |
| minimal | 166 | 4.0s | 61.0 fps |
| moodreel | 292 | 55.1s | 7.2 fps |
| hype | 23 | 113.9s | 6.8 fps |
| editorial | 251 | 112.2s | 5.9 fps |

2. **The median's 50.5s intercept is duration-INDEPENDENT WORK, not startup.**
   Startup cannot vary 9x (5.8s → 50.5s) between jobs running identical code on
   the same image. The gap is per-job component work that does not scale with
   length. **87% of all render seconds sit above the p10 envelope.**

## The real shape, for the 20–30s target band

On the component route a ~750-frame output fits `render = 82s fixed + frames/35.4fps
= 103s`, of which **79% is the duration-independent term.** Render alone
therefore exceeds the entire 60–90s e2e law on every component route:

| route | 20–30s band render p50 |
|---|---:|
| minimal_speech_uncut | 8.0s |
| minimal | 15.2s |
| moodreel | 74.2s |
| hype | 105.8s |
| editorial | **121.0s** |

## Where the speed work actually points

**The gap is throughput: 102–118 fps on minimal vs 21–30 fps on component
routes — a 4–5x deficit in what Chromium rasterises per frame.** That is
per-frame component cost and tab contention, not process startup. The code
already names the leading suspect (handler.py:31191): a 32-tab budget against a
**cpu=16** container — 2x oversubscription — now env-tunable
(`PROMPTLY_OVERLAY_TAB_BUDGET`) precisely so it can be measured.

## One hypothesis I tested and REJECTED

Chunk parallelism looked like the lever — throughput rises 5.6 → 33.2 fps from 1
to 8 chunks, and the 20–30s band gets only **one** chunk (`_EFFECTIVE_CHUNKS =
min(8, frames // 450)`, so ≤450 frames means no parallelism at all). **The
regression-discontinuity test refuted it.** Chunk count steps at 450/900/1350
frames, so chunking must produce a JUMP there:

| | at boundary | control window (no chunk change) |
|---|---:|---:|
| 450 | 1.19x | 250: **0.94x** |
| 900 | 1.21x | 700: **1.28x** |
| 1350 | 1.35x | 1150: **1.30x** |

**The controls rise as much as the boundaries.** The throughput gain is smooth
with duration — a fixed-cost amortisation signature — not stepped at chunk
transitions. Lowering `PROMPTLY_CHUNK_FRAMES` is NOT supported by this data, and
I would have shipped it as a free win on the raw correlation alone.

## What would make the three-way split answerable

`_render_elapsed`, `_audio_elapsed` and `_mux_elapsed` already exist at
handler.py:32333 and are thrown away. **Persisting them into `stage_timings` is
a one-line change** and turns render from one opaque number into three. Given the
≤5.8s bound, this is worth doing for the *work* split, not the startup split.

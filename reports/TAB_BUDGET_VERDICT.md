# TAB BUDGET — NO-RUN. The suspect was fixed two weeks ago, and my 4–5× figure does not support the hypothesis.

**JUDGE, 2026-08-20.** Applying the chunk-rejection discipline — find the
discriminator before believing the correlation — to the tab hypothesis. It does
not survive. **The experiment should not be run as framed. It reduces to a
one-line config read.**

## 1. The motivating number is a two-engine comparison

I cited "102–118 fps on minimal vs 21–30 fps on component routes — a 4–5×
throughput deficit" as the reason to suspect tab contention. **That number
cannot bear the weight.** `minimal_speech_uncut` carries `frozenset()` — an
**empty component set** (handler.py:446); the route hands the user their footage
back (handler.py:33925). It emits no components, so it does no Remotion overlay
work at all.

**So the 4–5× compares ffmpeg-only against ffmpeg+Remotion — two different
engines, not two tab budgets.** It establishes only that compositing components
costs something, which was never in doubt. It is the same error shape as the
chunk correlation: a real number that does not measure what it was invoked for.
**Withdrawn as evidence for the tab hypothesis.**

## 2. The named suspect is structurally dead, and has been since 2026-08-03

"32 tabs against cpu=16" was **already found and already fixed** — twice, on both
paths, before I proposed investigating it:

| path | code | today, at cores=16 |
|---|---|---|
| overlay | `_TAB_BUDGET = min(cores, env or max(4, cores//2))` (h:29558) | **8**, hard-capped at 16 |
| micro | `_MICRO_TAB_BUDGET = env or max(4, cores//2)` (h:29760) | **8** |

The micro comment (Zac 2026-08-02) names the exact failure I would have gone
looking for: *"overlay(32)+micro(16) = the ~48 concurrent Chromium tabs on a
16-vCPU box … kills the contention that crawled micro to 0.3 fps."* The overlay
comment (Zac 2026-08-03) adds the clamp and calls cores/2 **"the measured
optimum"** — the A/B has been run and its result is what ships.

**With the env unset, oversubscription is arithmetically impossible.**

## 3. There is no natural experiment — zero variance by construction

`PROMPTLY_RENDER_CORE_BUDGET` is **hardcoded `"16"`** in modal_app.py:727, and
**validate_deploy pins `budget == cpu`**. Cores do not vary across production
jobs, so the tab budget does not either. **No observational discriminator
exists**, and any A/B needs a deliberate flip plus a redeploy — a live-secret
value change, which is not mine to make.

## 4. What the whole question actually reduces to

An **explicit** `PROMPTLY_OVERLAY_TAB_BUDGET` overrides the adaptive default on
**both** paths, and the micro path is unclamped at assignment. So:

| live secret | overlay tabs | micro tabs | total on 16 cores |
|---|---:|---:|---:|
| **unset** | 8 | 8 | **~16 — 1.0×, healthy** |
| **set to 32** | 16 | ~32 | **~48 — 3.0×, the old defect** |

**The entire hypothesis is therefore one question: is
`PROMPTLY_OVERLAY_TAB_BUDGET` set in the live secret, and to what?** That is a
**config read, not an experiment** — no spend, no deploy, no traffic. If unset,
the suspect is dead and this file closes it. If set to 32, the 2026-08-02/03
adaptive fixes are being overridden by a stale value and that is a **defect to
report, not an A/B to run** — the fix is deleting the key, not tuning it.

**Filed for TRUTH: read the key. Do not change it on my account.**

## 5. Where the measurement should go instead

The duration-independent ~45s in component renders is real and unexplained. It
is now one deploy from being split, because the sub-timers land as timeline
children (`lane/judge-timers`, cert-gated): **`render_remotion` vs
`render_composite` says whether that 45s is Chromium rasterisation or ffmpeg
encode — and those point at completely different builds.** Production's timeline
currently reports `render: unaccounted 671.1s of 671.1s` on **160 of 160** jobs;
that is the number to kill first.

**Pre-registered, before the data:**
- `render_remotion` dominant (>60%) → rasterisation; component cost per frame is
  the target, and tab/concurrency work becomes worth re-opening **with a real
  discriminator**.
- `render_composite` dominant (>60%) → ffmpeg encode/mux; x264 settings and the
  pinned 48-thread encode are the target, and Chromium is exonerated entirely.
- Neither >60% → the 45s is spread, and no single build wins; report the split
  and stop proposing one.
- `unaccounted` still >20% after the deploy → the three timers do not cover the
  render span, and my decomposition is incomplete rather than wrong. **Say so
  rather than attributing the remainder.**

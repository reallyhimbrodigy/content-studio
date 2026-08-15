# FIRST LIGHT — JUDGE's verified envelope, and the two laws it breaks

**2026-08-15. I hold this gate on the terms that the envelope is MY verified
number, not the builder's estimate. I recomputed every field from the 14 raw
call records in `golden/first-light/first_light_ledger.json`. $0 — arithmetic.**

## VERDICT: the ledger is SOUND. Verified, with one internal inconsistency and one method note.

| field | claimed | my recomputation | |
|---|---|---|---|
| scenes_attempted / ok | 10 / 10 | 10 / 10 | ✅ |
| scene_failure_rate | 0.0 | 0.0 | ✅ |
| **usd_per_scene** | **$0.14** | **$0.14** | ✅ |
| secs_per_scene min / max | 15.6 / 32.4 | 15.6 / 32.4 | ✅ |
| **run_total_usd** | **$1.96** | **$1.96** | ✅ |
| ceiling respected ($2.00) | true | true (1.96 ≤ 2.00) | ✅ |
| alpha (hero) failure rate | 1.0 | 1.0 (0 of 2) | ✅ |
| total_images_billed | 12 | **14** | ⚠️ inconsistent |
| secs_per_scene_p50 | 18.7 | 18.3 (true median) | ℹ️ convention |

**A correction I made before publishing:** my first pass summed all 14 records
and got **$2.24**, which would have meant the $2.00 ceiling was BREACHED. It was
not. The `alpha_attempt` rows are **roll-ups** of the `alpha_leg` rows
(`calls_made: 2` each), so flat-summing double-counts the legs. Correct
arithmetic is scenes $1.40 + attempts $0.56 = **$1.96**. I withdraw the $2.24
and the breach claim entirely — the spend ceiling held.

**⚠️ Internal inconsistency (minor, dollars are right):** `total_images_billed:
12` does not reconcile with `run_total_usd: 1.96`, which at $0.14/image implies
**14** billed calls (10 scenes + 4 alpha legs). The dollar figure is the one
carried forward; the count field undercounts by two.

**ℹ️ Method note, not an error:** `secs_per_scene_p50` 18.7 is the nearest-rank
p50; the true median of 10 values is 18.3 (the set is 15.6, 17.0, 17.1, 17.4,
17.9, 18.7, 19.4, 20.0, 23.5, 32.4). Both are defensible — recorded so the two
numbers are never later mistaken for a discrepancy.

## Why the 0.0% scene failure rate is CREDIBLE — the known-bad probe fired in-run

My standing law is that no zero is believed until the probe fires on a
known-bad window. **It fired inside this very run**: `alpha_failure_rate = 1.0`
(0 of 2 hero attempts succeeded), recorded by the same harness, at the same
time. The failure detector is demonstrably capable of recording failure, so
`scene_failure_rate = 0.0` is a measured zero and not a silent instrument.
This is the strongest form of the guarantee — a same-run control.

**Methodology credit where due:** the ledger is measured IN-RUN at each call
site, explicitly *not* read back from `video_jobs.result`, because the envelope
loss corrupts 38.6% of that population. That is the correct decision and it
cites the finding properly.

## LAW 4 IS ALREADY VIOLATED — hero scenes are 0-for-2

`alpha_attempts: 2, alpha_ok: 0` → **100% failure**. Both attempts died the
same way: *"leg 1 (white bg) landed; leg 2 (black bg, for the matte) exhausted
all 4 retries on 429."* So `usd_per_hero_scene` is honestly recorded as
**UNMEASURED** — you cannot price a thing that has never once succeeded.

Law 4 says no new component may fail a render. **The hero/alpha component
currently fails 100% of the time and must not enter the default path.** Its
cost line is unmeasured, so it also fails my per-component merge gate on two
counts, not one. n=2 is thin — but the correct reading of 0-for-2 is
*"unproven and blocked"*, never *"probably fine."*

## THE COST LAW BREAKS AT ONE SCENE

Forecast from the verified envelope ($0.14/scene, 18.7s/scene serial, quota
binding below 3.4 req/min):

| scenes | $/edit | vs $0.10 law | scene seconds | quota wait | vs 120s law |
|---:|---:|---:|---:|---:|---:|
| 1 | $0.14 | **1.4x** | 19s | 18s | 0.2x |
| 3 | $0.42 | 4.2x | 56s | 53s | 0.5x |
| **4** | **$0.56** | **5.6x** | **75s** | **71s** | **0.6x** |
| 6 | $0.84 | 8.4x | 112s | 106s | 0.9x |
| 10 | $1.40 | 14.0x | 187s | 176s | 1.6x |

**A single scene is already 1.4x the $0.10/job cost law — before any render,
transcribe, plan or Modal cost is added.** This is not a scaling problem to be
solved at 6 scenes; it is a pricing decision required at 1.

Monthly, scene-generation spend alone (Vertex image only, Modal excluded):

| volume | 1 scene | 4 scenes |
|---|---:|---:|
| 600 signups/day | $2,520/mo | **$10,080/mo** |
| 100 paid × 3/day | $1,260/mo | $5,040/mo |

## REGISTERED: the ~4-scene quota ceiling — the constraint every Phase 2 number is measured against

**Binding constraint: the Vertex image quota, which binds below 3.4 req/min.**
Because calls run serially, a 4-scene edit needs **~71s of quota time minimum**
and ~75s of wall clock in scene generation alone — roughly **60% of the entire
120s law**, leaving ~45s for transcribe, plan, render, upload and delivery.

**~4 scenes is therefore the ceiling, and it is a QUOTA ceiling, not a spend
ceiling.** The ledger's evidence for that distinction is sound and I accept it:
every call ran serially and still hit 429s; the 429s *decayed* across the ladder
(6 → 5 → 2) rather than persisting; a spend cap fails all attempts and does not
recover in 5–8s. **The lever is a Vertex quota-increase approval, not a spend
decision** — those go to different people and must not be conflated.

**Binding rule for Phase 2:** every scene-vocabulary number — cost, latency,
failure rate — is quoted **at n ≤ 4 scenes**, with the quota ceiling stated
beside it. A design that needs 6+ scenes is not merely expensive; it is
**unbuildable at current quota** and its numbers are hypothetical until the
quota approval lands. Anything measured above n=4 must be labelled
[ABOVE-QUOTA-CEILING].

## What this gates

- **First Light: PASSED** as a measurement. The three numbers exist and are
  mine: **$0.14/scene · 18.7s/scene (18.3s true median) · 0% scene failure over
  10**, with the failure detector proven live in the same run.
- **Hero/alpha component: BLOCKED** from the default path (Law 4, 0-for-2,
  cost unmeasured).
- **Phase 2 sizing: proceed at n ≤ 4**, cost law breach acknowledged and owned
  as a pricing decision at n=1.

# FIRST LIGHT — JUDGE's verified envelope, the law it breaks, and the constraint that actually binds

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

## COST — RE-FILED against §2.1's premium budget (my first headline was misfiled)

**WITHDRAWN:** I headlined this as *"the $0.10/job cost law breaks at one
scene."* That filed Lumen against the **standard-tier** law. Lumen is the
**premium** product and §2.1 sets its budget at **≤$1/render**. Against the
correct budget the picture inverts:

| scenes | scene $ | vs §2.1 ≤$1 budget | + premium Modal $0.481 | total/render |
|---:|---:|---:|---:|---:|
| 1 | $0.14 | 14% | $0.48 | $0.62 |
| 3 | $0.42 | 42% | $0.48 | $0.90 |
| **4 (quota ceiling)** | **$0.56** | **56%** | $0.48 | **$1.04** |
| 6 | $0.84 | 84% | $0.48 | $1.32 |
| 7 | $0.98 | 98% | $0.48 | $1.46 |

**Scene spend stays inside the premium budget through 7 scenes** ($0.98; n=8
breaks it at $1.12). At the registered 4-scene quota ceiling it is **56% of
budget — comfortably inside.** The quota ceiling binds well before the budget
does, which reverses my earlier framing: **cost is not the binding constraint
on scene count; quota is.**

## ACCEPTANCE RATE (written / billed) — now a standing board term

§2.1's gate is written against the **measured** acceptance rate, not the
sticker rate, so acceptance is the term that converts a price into a cost.
From the First Light ledger:

| family | billed | delivered | acceptance | effective $/delivered |
|---|---:|---:|---:|---:|
| scene | 10 | 10 | **100.0%** | $0.14 (= sticker) |
| alpha *legs* (billed level) | 4 | 2 | 50.0% | $0.28 |
| alpha *attempts* (**delivered level**) | 2 | **0** | **0.0%** | **$0.56 spent, 0 delivered** |
| **ALL** | 14 | 10 | **71.4%** | **$0.196 = 1.40x sticker** |

**The structural trap, and it is the reason this must be a standing term: the
alpha family BILLS at leg level but DELIVERS at attempt level.** A 50%
leg-acceptance reads survivable; the attempt-acceptance it actually produces is
**0%**. Measured at the wrong level, a component that delivered nothing would
have reported a merely-mediocre number.

**Rule: acceptance is always measured at the level the USER receives**, never
the level we are billed. Effective cost = sticker ÷ acceptance; at this run's
71.4% the true unit cost is **1.40x** the sticker price.

## BREAK-EVEN RENDER QUOTA — the number the pricing ruling now needs

At **$45/mo**, net of Apple's 30% = **$31.50** of margin, against premium Modal
cost **$0.481/render** [RECON C-9 MEASURED]:

| scenes/render | $/render | renders/month at break-even |
|---:|---:|---:|
| 0 | $0.48 | **65** |
| 1 | $0.62 | 51 |
| 2 | $0.76 | 41 |
| 4 (ceiling) | $1.04 | **30** |

**A $45 subscriber breaks even at ~65 renders/month with no generative scenes,
falling to ~30/month at the 4-scene ceiling.** Every scene added costs ~35% of
the remaining quota headroom at n=1 and less thereafter.

**Published with MODAL COST AS THE SENSITIVITY AXIS**, because that is the
number that actually moves the answer — the ruling should be read row-first:

| Modal $/render | 0 scenes | 1 scene | 2 scenes | 4 scenes (ceiling) |
|---|---:|---:|---:|---:|
| $0.257 (blended + burst) | 123 | 79 | 59 | **39** |
| $0.35 (midpoint) | 90 | 64 | 50 | **35** |
| **$0.481 (premium mean, RECON C-9)** | 65 | 51 | 41 | **30** |
| $0.60 (if burst widens) | 53 | 43 | 36 | **27** |

Across the plausible Modal range a 4-scene edit breaks even between **27 and 39
renders/month**; across the whole scene range at a fixed Modal figure it moves
far less. **Pin the Modal cost before ruling on the scene count** — one input
narrows the answer, the other barely does.

This also connects to §2.1's own pre-registered go/no-go gate, which requires
the p90 generative ask to fit inside one month's margin at $45 **at the
measured acceptance rate, not the sticker rate**. The acceptance rate is not
yet measured, so that gate remains OPEN — these figures size the envelope, they
do not close the gate.

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
- **Phase 2 sizing: proceed at n ≤ 4**, bound by the **quota** ceiling, not by
  cost — scene spend at n=4 is 56% of §2.1's ≤$1 premium budget. My earlier
  "cost law breaks at n=1" framing was misfiled against the standard tier and
  is withdrawn.
- **Pricing ruling: open**, and it now has its number — **~65 renders/month
  break-even at $45 with no scenes, ~30 at the 4-scene ceiling**, with the
  Modal input (not scene count) dominating the answer.

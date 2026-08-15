# WATCHDOG SCOPE — reconciled with BUILDER's spec BEFORE either number publishes

**JUDGE, 2026-08-15. Two publication-blocking errors found, one in my
pre-registration and one in the spec's prize. Neither number should have gone
out as written.**

## ERROR 1 — MY registered scope limit was WRONG, and my thresholds would have demanded a false revert

`PREREG_WATCHDOG.md` states the watchdog "acts on the ~900s cluster" and "says
nothing about the 180–240s cluster." **That is wrong.** BUILDER's trigger is
state-based, not cluster-based [CODE POST_UPLOAD_WATCHDOG.md]:

> artifact confirmed in S3 **AND** terminal write not landed **AND** true for
> N=120s

That condition is satisfied by jobs in **both** clusters. Measured over the
frozen window (n=467), using WORK time as an upper bound on the
upload→terminal gap:

| cluster | n | /day | work p50 | work <120s (cannot fire) | **can fire** |
|---|---:|---:|---:|---:|---:|
| 180–240s | 40 | 12.6 | 118s | 21 | **19** |
| 300–360s | 31 | 9.7 | 163s | 0 | **31** |
| 870–930s | 25 | 7.9 | 747s | 0 | **25** |
| **all affected** | 183 | 57.5 | 177s | 42 | **141** |

**Upper bound on firing: 141/467 = 30.2% of completions (~44/day.)** Upper
bound because work ≥120s is *necessary but not sufficient* — the
upload→terminal gap is a subset of work time, and the DB carries no
upload-confirm timestamp, so I cannot tighten it from here.

**The consequence is the serious part: my registered ">25% ⇒ OVER-FIRING,
REVERT" threshold sits BELOW the upper bound of correct behaviour.** A watchdog
working exactly as designed could fire at ~30% and trip my revert rule. I would
have called a correct instrument broken and demanded it be pulled.

**Corrected thresholds, replacing those in `PREREG_WATCHDOG.md`:**

| firing rate | reading |
|---|---|
| **5–30%** | **CONFIRMS** — inside the measured eligible band |
| **>35%** | **OVER-FIRING** — exceeds the eligible population; it is catching healthy jobs, or the 120s gate is not gating. Investigate before revert. |
| 1–5% | PARTIAL — the 120s gate is stricter in practice than work-time bounds imply; report, do not claim the class |
| ~0% | unchanged — **not a result**; see the silence rule, which stands |

The silence rule, the same-run known-bad requirement, and the qualifier all
stand unchanged. Only the numeric band moves.

## ERROR 2 — the spec's PRIZE is overstated ~3.7x, by mixing two populations

`POST_UPLOAD_WATCHDOG.md` computes: *"60 jobs/day × ~900s at cpu=16"* →
**~$14.7/day ≈ $440/mo**, with **~$380/mo** recoverable at a 120s cap.

The **count** is right (I measure 57.5 affected/day ≈ 60). The **duration** is
not: it takes the ~900s figure from the *slow cluster* and applies it to the
*whole cohort*. The cohort is bimodal — **affected work p50 is 177s, not 900s.**

| | spec | measured |
|---|---|---|
| affected/day | 60 | 57.5 ✅ |
| seconds/day | 54,000 | **14,481** |
| cost/day @ cpu=16 | $14.70 | **$3.04** |
| recoverable by 120s cap | ~$380/mo | **~$50/mo** |

**This is the count-from-one-population × duration-from-another error** — the
same shape as the contaminated-window and cycle/slice traps, and it survives
precisely because both inputs are individually correct.

**~$50/mo is still worth shipping** — it is real, it is recovered by a change
that is already built, and the latency benefit is separate and larger. But it
is **not** a rival to L1/L2 ($4,450–$5,586/yr), and the two must not be summed:
both act on orchestration seconds, so they overlap and must be **sequenced and
re-measured**, not added.

## What both of us should publish

- Firing rate against the **5–30% CONFIRMS** band, not the old 5–15%.
- Prize at **~$50/mo recovered**, not $380/mo, with the bimodality named as the
  reason.
- The scope stated as **state-based across both clusters**, not "the 900s
  cluster" — while noting the 120s gate means ~half the 180–240s cluster
  (21 of 40) can never fire.

## The qualifier, attached as always

Users receive their video on both paths. The watchdog's prize is **cost,
telemetry and tail latency** — never recovered deliveries.

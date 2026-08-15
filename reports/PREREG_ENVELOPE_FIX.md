# PRE-REGISTRATION — the envelope-loss fix (CAS on `result`) + the `_delivered` predicate

**JUDGE, 2026-08-15T00:20Z. WRITTEN AND COMMITTED BEFORE THE DEPLOY, BEFORE THE
DATA.** Every threshold below is fixed now so that no post-hoc reading can move
one. Mechanism is settled (lost update on `result` jsonb — read-modify-write
clobber); the worker-hang framing is **retired**, not merely unconfirmed.

## FROZEN BASELINE — window `created_at >= 2026-08-11T23:00Z` (the regression's birth), completed jobs, e2e = `completed_at - created_at`

| measure | value |
|---|---|
| completions / users | **458 / 426** |
| **envelope ABSENT** | **181 = 39.5%** (161 users) |
| pooled p50 | **87.0s** |
| over-120s share | **45.6%** |
| repair count | **25** (24 users) |
| `callback` stamps | **0** |
| **envelope-FULL p50** | **50.9s** ← the decisive comparator |
| envelope-LOST p50 | **308.2s** |
| FULL over-120s | **11.2%** · LOST over-120s | **98.3%** |

**Baseline discrepancy, flagged not buried.** The directive cites pooled p50
**90.8s** and over-120s **40.6%**. I could not reproduce either under five
variants (windows 08-11T23/08-12/08-13/24h/48h; completed-only vs
completed+failed; `created_at` vs `started_at` basis) — mine is stable at
**87.0s / 45.6%**. The 40.6% figure *does* reproduce exactly as the
**envelope-absent share on a 48h window**, so I believe the two shares were
transposed. I am registering against my reproducible baseline **and** against
the baseline-independent comparator below, so the verdict survives either.

## QUEUE — a first-class latency term, added 2026-08-15

`e2e = QUEUE + WORK`. Reporting only e2e blames the pipeline for time it never
spent working. Measured on the frozen baseline window (n=459), using
`worker_started_at` (true worker pickup) — **not** `started_at`, which stamps
the dispatch ATTEMPT and reads p50 0.3s, i.e. it measures our own HTTP call:

| term | p50 | p90 | p99 | max |
|---|---:|---:|---:|---:|
| QUEUE (create→pickup) | **13.3s** | 273.6s | 637.1s | 824.3s |
| WORK (pickup→complete) | **70.4s** | 289.5s | 799.5s | 900.3s |

**43.1% of jobs wait >30s before any work begins**; 134 wait >120s. Queue is
15.2% of e2e at p50 and far more in the tail.

**Split by envelope class, the queue term is where the classes diverge most:**

| class | queue p50 | queue p90 | work p50 |
|---|---:|---:|---:|
| A envelope FULL | **10.0s** | 16.8s | 37.3s |
| B/C envelope LOST | **148.9s** | 325.8s | 174.8s |

The lost class is slow in BOTH terms — **15x** on queue, 4.7x on work.

### It is a THRESHOLD relationship, not a correlation — language matters here

Full 2×2 over the frozen window (n=462):

| | envelope FULL | envelope LOST |
|---|---:|---:|
| queue **<30s** | **262** | **1** |
| queue **≥30s** | 18 | **181** |

- **P(FULL \| queue<30s) = 99.6%** — exactly **one** job in 263 lost its
  envelope below the knee.
- **P(LOST \| queue≥30s) = 91.0%**; **P(queue≥30s \| LOST) = 99.5%**.
- **93.6% of envelope-FULL jobs queued under 30s** (the overlap figure).
- Overall agreement **95.9%**. The step is sharpest between **15s and 30s**
  (queue<15s → 99.6% FULL; queue≥15s → 15.8% FULL).

"Correlates with" understates this and should not be used. Below the knee,
envelope loss is **near-absent**; above it, **near-certain**. Any candidate
mechanism must explain a *switch* at ~15–30s of queue, not a gradient.

**Direction remains open** — queueing may cause the loss, or one upstream
condition (contention) may cause both. The step shape constrains the mechanism
without resolving the arrow.

### RULED OUT — do not re-litigate workload

- **Source duration**: median **10.7s** (FULL) vs **13.3s** (LOST) — a **1.24x**
  difference, against a **15.0x** queue difference. Workload cannot carry a 15x
  effect on a 1.24x input.
- **Client version**: **identical** — 96% on `1.3.6 (224)` in *both* classes.

Neither explains the split. These are closed questions.

### [UNFALSIFIABLE] — the queue instrument has no pre-Aug-11 history

`worker_started_at` landed with the **2026-08-11T19:50Z** migration. **There is
no queue data before that date at all.** Therefore:

- **"Queue delay is new" is UNFALSIFIABLE with current data.** So is "queue got
  worse", "the regression caused it", and "queue was fine before". None of
  these can be tested; none may be asserted, by me or anyone reading this board.
- What IS claimable: the queue term's CURRENT size, its split by class, and any
  change measured **from 2026-08-11T19:50Z forward**.
- The pre-Aug-11 `started_at` column cannot substitute — it stamps dispatch
  attempt, not pickup, so it answers a different question (a cohort that
  predates the instrument is not evidence).
- This resolves only by accumulating forward history. First honest
  before/after on queue is available **2026-08-18** (7 days of instrumented
  baseline).

## THE PREDICTIONS — thresholds fixed now

Read at **T+24h**, and only once **n ≥ 100** post-deploy completions exist
(denominator floor; a thin sample gets NOT-YET-READABLE, never a verdict).

| # | prediction | PASS | AMBIGUOUS | FAIL |
|---|---|---|---|---|
| 1 | envelope-absent → ~0 | **≤2%** | 2–10% | >10% |
| 2 | `callback` appears and dominates | ≥60% of stamps | 20–60% | <20% |
| 3 | pooled p50 falls toward ~80s | **≤80s** | 80–87s | >87s (baseline) |
| 4 | over-120s share falls toward ~33% | **≤35%** | 35–45% | >45.6% (baseline) |
| 5 | repair count drops sharply | ≤2 per 458 completions | 3–10 | >10 |

## WHICH FIX OWNS WHICH NUMBER — do not cross-credit

The two changes have **different signatures**, and if they ship together the
temptation to credit one for the other's effect is the main analytic risk:

- **The `_delivered` predicate fix owns #2 only.** It is a RELABELLING. Jobs
  already delivering fast at 51s stop being misfiled as `reconciler` and start
  reading `callback`. **It cannot move p50 by itself.** If p50 drops and
  envelope-absent has not cleared, that was traffic mix, not this fix.
- **The CAS fix owns #1, and #3/#4/#5 only through #1.** Latency improves only
  by converting slow envelope-LOST jobs (p50 308s) into fast envelope-FULL jobs
  (p50 51s). No envelope recovery, no latency win.

## THE MISREAD MOST LIKELY TO HAPPEN — envelope clears, latency doesn't

**Pre-registered meaning, fixed in advance: that outcome means the fix WORKED
and my causal model was WRONG. It does not mean the fix failed.**

Prediction #1 is the fix's own success metric. #3/#4 are *downstream
consequences that hold only if envelope loss was the sole cause of the slow
class*. If #1 passes and #3/#4 fail, the honest reading is: **the slow class had
a second, independent cause that envelope loss was riding alongside.**

**The decisive discriminator — baseline-independent, run it first:**

> Post-deploy, compute p50 **for envelope-FULL jobs only** and compare against
> the frozen **50.9s**.
>
> - **≈51s (say ≤65s)** → the previously-lost jobs became genuinely fast. The
>   causal model was right; if pooled p50 has not moved, the population mix or
>   sample is at fault, not the mechanism.
> - **materially higher (≥85s)** → the ex-lost jobs are now envelope-FULL **but
>   still slow**. That is proof of a second cause. Report it as *"envelope loss
>   FIXED (#1 PASS); slow class has an independent second cause, now isolated
>   and measurable for the first time"* — which is a better position than
>   before, not a regression.
>
> **The second cause is NAMED IN ADVANCE: queue delay.** The lost class already
> carries a 148.9s queue p50 against the full class's 10.0s. If the CAS fix
> converts those jobs to envelope-FULL while their queue term stays ~149s,
> latency will NOT reach the 51s comparator and #3/#4 will fail **for a reason
> that has nothing to do with the fix**. Registered test: post-deploy, decompose
> the ex-lost cohort into QUEUE and WORK. Queue still ~149s ⇒ second cause
> CONFIRMED as queue, and the next campaign is container supply, not delivery.

Corollary guard: if #1 passes, the **composition** of envelope-FULL changes
(it absorbs ~40% more jobs). So a *rise* in envelope-FULL p50 from 50.9s is
EXPECTED under the second-cause hypothesis and is not evidence the fix harmed
anything.

## THE INVERSE MISREAD

If #3/#4 pass while #1 fails, **do not credit the fix.** Latency moving without
envelope recovery means source mix, traffic volume, or route mix moved. Check
the route distribution and the FULL/LOST split before any claim.

## STANDING GUARDS

- No zero believed until the probe fires on a known-bad window: **before
  reporting #1 as ~0, confirm the envelope-absent detector still trips** — a
  row with `result` present and `stage_timings` absent must still be counted.
  A detector that broke reads 0% identically to a fixed bug.
- The 900s band is **not** a proxy for the repair class — the 08-14T23:33
  repair settled at 1172.4s, outside [870,920]. Count #5 by stamp, never by band.
- Report #3/#4 **by envelope class beside the pooled figure**, never pooled
  alone (17.8x spread; the pooled median describes no real user).

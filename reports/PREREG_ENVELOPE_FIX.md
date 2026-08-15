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

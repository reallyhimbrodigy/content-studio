# HANG TEST — RESULT: does not hold. No re-ranked board.

**JUDGE, 2026-08-15. Run against `PREREG_HANG_TEST.md`, committed at `1e6d25c`
BEFORE this query. Per that pre-registration, a refutation is published with the
same prominence a confirmation would have had.**

## Verdict against the registered thresholds

| # | prediction | threshold | measured | verdict |
|---|---|---|---|---|
| P1 | ~900s mode | ≥30% in 870–930s | **13.7%** (25/182) | **AMBIGUOUS** |
| P2 | envelope-write ratio | ≤50% confirms | **60.8%** (282/464) | **MIDDLE** |
| P3 | same-job co-occurrence | ≥70% overlap | **100%** (25/25) | **CONFIRMS** |

n = 464 completions, above the registered floor of 100, so the test ran.

**One of three confirms. The registered rule was "if 1, 2 and 3 all confirm."
They do not. THE SINGLE-LEVER FRAMING IS NOT SUPPORTED AND THE BOARD IS NOT
RE-RANKED.**

## Why P3 alone is not enough — and why the pre-registration earned its keep

P3 is the seductive number: **100% of the ~900s jobs are envelope-absent.** Read
alone it looks like proof. It is not, because **the ~900s band is only 13.7% of
the affected population.** A claim that one mechanism explains the class cannot
rest on the 13.7% of it that fits.

Without the thresholds fixed in advance I would have had every incentive to lead
with P3 and treat P1 as a detail. That is precisely the outcome pre-registration
exists to prevent, and this is the first time in the campaign it has stopped a
conclusion rather than merely decorating one.

## THE ACTUAL FINDING — the mode is at 180–240s, not 900s

The densest 60s band is **180–240s, holding 22%** of affected jobs — larger than
the 900s band. The affected-set distribution is **bimodal**, and the bigger mode
is the one nobody was looking at:

```
 120-180s  17  ( 9%)
 180-240s  40  (22%)   <-- LARGEST MODE
 300-360s  31  (17%)   <-- second cluster
 360-540s  39  (21%)   spread
 900-960s  26  (14%)   the band the hypothesis predicted
```

The two clusters are **mechanically distinct**:

| | 180–240s cluster | 870–930s cluster |
|---|---|---|
| n | 40 | 25 |
| delivery path | **`reconciler` 40/40** | **`repair` 24/25** |
| queue p50 | 110s | 157s |
| envelope-absent | 40/40 | 25/25 |

Both are 100% envelope-absent — so envelope loss is common to both — but they
settle by **different paths** and at **different times**. That is the signature
of *at least two* mechanisms sharing one symptom, which is exactly the case my
pre-registration named as "decompose before ranking."

## What this changes

- **No re-ranked board.** The hang is not established as the single largest
  lever across three axes. L1/L2 remains the largest *confirmed* cost lever
  ($4,450–$5,586/yr on the current window), because it was ranked against the
  invoice rather than against a mechanism story.
- **Envelope loss remains real and unexplained-in-mechanism.** 39.2% absent
  here (60.8% write rate). It is common to both clusters, so it is downstream
  of, or parallel to, whatever separates them — not itself the discriminator.
- **The next question is decomposition, and it is now specific:** what settles a
  job at 180–240s via `reconciler` that is different from what settles one at
  ~904s via `repair`? Both lose the envelope; only one waits out a timeout.

## The qualifier that stands regardless

**The `repair` path has already banked the user-facing half.** Users on the
affected paths do receive their video — repair reconstructs the completion from
the S3 artifact, and the reconciler path delivers at 180–240s. Whatever the
decomposition finds, the outstanding damage is **cost + telemetry + tail
latency**, not lost deliveries. Any future framing of this class must not imply
users are losing renders; from their seat this is a wait, not a loss.

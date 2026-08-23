# PAYWALL EXPOSURE BY CONTEXT — the allocation claim holds; the rate multiplier does not

**JUDGE, 2026-08-22. New standing board line.** `context` is present on **100%**
of `upgrade_wall_viewed` (3,639/3,639) — this was measurable all along and had
never been cut.

## Measured, by USER (Rule 7), since 08-01

| context | views | view share | users | → started | → **bought** | conv |
|---|---:|---:|---:|---:|---:|---:|
| **`manual`** | **9,009** | **69.5%** | 3,312 | 232 | **8** | **0.24%** |
| `daily_renders` | 2,513 | 19.4% | 755 | 137 | 4 | 0.53% |
| `concurrency` | 743 | 5.7% | 245 | 39 | 2 | 0.82% |
| `reedit` | 388 | 3.0% | 260 | 27 | **0** | **0.00%** |
| `daily_chats` | 304 | 2.3% | 78 | 16 | 1 | 1.28% |
| `post_onboarding` | 2 | 0.0% | 1 | 0 | 0 | 0.00% |

| grouping | views | share | users | bought | conv |
|---|---:|---:|---:|---:|---:|
| **AMBIENT** (`manual` + `post_onboarding`) | 9,011 | **69.5%** | 3,313 | 8 | **0.24%** |
| **BLOCKED-INTENT** (the four gates) | 3,948 | 30.5% | 1,133 | 6 | **0.53%** |

## Reconciliation with the reported figures

| | reported | measured |
|---|---:|---:|
| ambient share | 88% | **69.5%** |
| ambient conversion | 0.2% | **0.24%** ✅ |
| blocked-intent conversion | 1.5% | **0.53%** |
| implied gap | 7.5x | **2.2x** |

**The ambient conversion matches exactly.** The other two do not, and the likely
cause is grouping: **`daily_chats` alone converts at 1.28%** — close to the
reported 1.5% — so a narrower "blocked-intent" definition reproduces that figure,
and a wider "ambient" bucket reproduces 88%. **The definitions need to be fixed
in one place before either number is quoted again**, or the two readings will keep
disagreeing for a reason that is not a disagreement.

## THE RATE CLAIM IS NOT SUPPORTABLE — n = 14 purchases

| | |
|---|---|
| ratio | 2.19x |
| z / p | **1.49 / p = 0.135** |
| verdict | **NOT DISTINGUISHABLE at 95%** |
| ambient 95% CI | 0.122% – 0.476% |
| blocked 95% CI | 0.243% – 1.151% |
| | **the CIs OVERLAP** |

**Fourteen purchases across every context combined.** At this n, `daily_chats`'
1.28% rests on **one buyer** and `concurrency`' 0.82% on **two**. Resolving even
a 2.2x gap at 80% power needs **~5,931 users per arm**.

**A 7.5x gap quoted from this data would be a small-sample artifact**, and it is
the exact shape of the false alarms Rule 5 exists to prevent.

## THE ALLOCATION CLAIM SURVIVES, AND IT DOES NOT NEED THE RATES

**69.5% of every paywall impression goes to `manual`** — the context with the
weakest measured intent and the lowest point estimate on the board. That is a
fact about *where the impressions go*, and it stands **regardless of whether the
conversion rates are distinguishable.**

The allocation is wrong on its own terms:
- **`reedit`: 260 users, 388 views, ZERO purchases.** A gate that has never
  converted anyone.
- **`daily_chats` is the best point estimate (1.28%) and receives 2.3% of
  impressions** — the inverse of what allocation should look like, even if the
  rate is one buyer.

**So the framing is right and the number is not.** This is an allocation problem;
it is *not yet demonstrated* to be a 7.5x — or even a 2.2x — conversion problem.

## What to do, and what NOT to measure

- **Re-allocate on intent, not on the measured rates** — the rates cannot carry
  a decision at n=14, but the impression distribution can, and reallocation is
  reversible.
- **Do NOT run a copy A/B.** At ~5,931 users per arm to resolve 2.2x, a copy test
  on any single context is unpowered before it starts, and would return a null
  that gets misread as "copy doesn't matter."
- **The real denominator problem is upstream.** 3,791 users saw a paywall; 14
  bought. Delivery rate is **39.1%** — most users never reach a finished video at
  all, and a user who never got a video is not a user a paywall can convert.
  **Paywall allocation is a second-order lever behind delivery.**

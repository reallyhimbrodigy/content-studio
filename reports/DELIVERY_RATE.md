# DELIVERY RATE — 39.1%, and 80% of the loss happens before a job exists

**JUDGE, 2026-08-22. New standing number, ranked ABOVE cost and speed.** Cut by
**USER** per Rule 7, never per job — a user who fails five times is one lost
user, not five failures. Window 08-14→08-20, `platform=ios`, n=**2,304 users who
fired `upload_started`**.

## The number

**901 / 2,304 = 39.1%** of users who start an upload see a finished video.
Owner-reported ~36%; **measured 39.1%** — the gap is window choice, not a
disagreement.

| stage | users | of starters |
|---|---:|---:|
| `upload_started` | 2,304 | 100% |
| `upload_completed` | 1,176 | **51.0%** |
| has a job row in the DB | 1,190 | 51.6% |
| ≥1 job reaches `completed` | 966 | 41.9% |
| **`result_viewed`** | **901** | **39.1%** |
| `export_completed` | 260 | 11.3% |

## Where the loss actually is — this is the finding

| where | users | of starters | **of ALL loss** |
|---|---:|---:|---:|
| **lost at UPLOAD — no job row ever created** | **1,128** | **49.0%** | **80.4%** |
| lost in the PIPELINE — job exists, never completes | 224 | 9.7% | 16.0% |
| completed but never viewed | 65 | 2.8% | 4.6% |
| **total not delivered** | **1,403** | **60.9%** | 100% |

**80% of all delivery loss happens before a job row exists.** Every cost, speed
and render lever on this board acts on the pipeline — **which is 21% of the
loss.** That is the answer to whether campaigns are worth restarting: the
pipeline campaigns are optimising the small half of the problem.

**Of the 49% upload loss, 18.7% of starters fired `upload_failed` explicitly** —
so roughly **38% of the upload loss is a reported failure and ~62% is silent
abandonment**, with no error event of any kind.

## The drop is REAL — ledger-vs-reality checked before publishing

A 49% drop at one step is exactly the shape an under-fired event produces, so it
was tested against DB truth rather than trusted:

| | n |
|---|---:|
| users with an `upload_completed` **event** | 1,176 |
| users with a **job row** in `video_jobs` | 1,190 |
| **ratio** | **1.01x — the event agrees with the DB** |

**The instrument is sound; the drop is real.** Had the ratio been >1.15 the
funnel would have been an instrumentation artifact and this report would say the
opposite.

## What this does NOT say

- **It does not say the pipeline is fine.** 9.7% of starters lose a job that
  exists, and `video_jobs` shows **472 failed of 1,619** in the window. That is
  real and worth fixing — it is simply **a quarter the size of the upload loss.**
- **It does not identify the upload failure mode.** `upload_failed` is fired by
  18.7% of starters; the other ~30% leave no event at all. **Whether that is
  network, file-picker abandonment, permission denial, app backgrounding or a
  client crash is not measurable from here**, and I will not guess at the shape
  of the largest loss on the board.
- **`result_viewed` is a proxy for "saw a finished video."** A user who received
  the video and never opened the app again counts as undelivered. That is the
  honest conservative direction for a *delivery* metric, and it is stated so the
  39.1% is not read as stricter or looser than it is.

## What I would measure next, and it is not a pipeline number

**Instrument the upload path by failure mode.** The single largest number on this
board — 1,128 users/week — is currently one undifferentiated bucket, 62% of it
silent. That is the same shape as `render: unaccounted 671.1s of 671.1s`: the
biggest term with no decomposition behind it, and the decomposition is what
decides what gets built.

**This number now leads every report, above cost and speed.**

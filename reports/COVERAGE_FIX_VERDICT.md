# COVERAGE FIX — the columns landed, and they do NOT close the hole

**JUDGE, 2026-08-15. I did not re-point the judge's filter, because re-pointing
it would not have changed a single score. Reporting that instead.**

## The columns exist and are written

`edit_recipe` and `stage_timings` are now real top-level columns and populate on
**136 of 234** completions since 08-14 (58%). The schema change is live.

## But they are NOT decoupled — 100% agreement with the envelope

Window 08-15T08:00Z→, n=61 completions:

| | n | `edit_recipe` COLUMN | `stage_timings` COLUMN |
|---|---:|---:|---:|
| envelope **FULL** | 40 | **40 (100%)** | 40 (100%) |
| envelope **LOST** | 21 | **0 (0%)** | 0 (0%) |

**Zero of 21 envelope-lost rows carry the new column.** The column populates
exactly where the envelope already survived and nowhere else — **column-filled ==
envelope-survived on 43/43 rows, 100% agreement.**

**Timing is ruled out.** Filled and unfilled rows are interleaved within the same
hours — **7 hours contain both** — so this is not a fix that landed mid-window.
The split is mechanistic.

## What this means, and it sharpens my own guard

The shared-failure-mode guard said *"a measurement channel must not be
co-located with its subject — same row, same jsonb, same write."* The fix
addressed **the jsonb**. The actual coupling is **the write**.

`edit_recipe` moved out of `result` into its own column, but it is still
populated by **the same UPDATE that carries the envelope**. When that write is
lost, both fields are lost together — a different column in the same statement is
not separation at all. Schema separation is not failure separation.

**The corrected rule, replacing my wording:** two channels are independent only
when they can fail independently — which requires a **different write**, ideally
from a different code path and at a different time. Ask "what single failure
takes both?", not "do they share an object?"

The proof that this is the right frame is `vibe_input`: same jobs, same outage,
survives **210/210** — because it is written at job CREATION, by a different
write, at a different time. That is what independence looks like.

## Consequence for the quality board — the hole is UNCHANGED

- **I did not re-point the judge's filter.** Pointing it at the new columns
  would score the identical population: the 61% whose envelope survived. The
  filter is not what was limiting coverage.
- **Coverage stays at ~61%**, and the coverage line stays on every quality
  figure exactly as written.
- **Honor 49.6% / dropped-silently 36.7% still describe the healthy majority
  only.** I cannot report what these look like with the lost population included,
  because that population is still not producing scoreable rows — not
  retrospectively, and **not going forward either**, which is the change from my
  last report. I previously wrote that (b) moving `edit_recipe` out of `result`
  would make the verdict channel *structurally immune*. **That prediction is
  refuted by this measurement.** The move happened and immunity did not follow.

## What would actually close it

Either of these, and they are testable:

1. **Fix the lost write itself** (the CAS fix on the terminal update). If no
   write is lost, both channels survive. This makes coverage a function of the
   delivery fix rather than of schema.
2. **Write the verdict on a genuinely separate leg** — persist `edit_recipe` at
   plan time, from the planning path, before the render terminal exists. Then a
   lost terminal write cannot take it, because it was already committed by an
   earlier, independent write.

**(2) is the one that survives the next unrelated bug**, and it is the same
argument I made last time — but the target is now the *write*, not the column.

## Pre-registered read for when either lands

- Coverage is closed when **envelope-lost rows carry `edit_recipe` at >0%** —
  that single number is the test, and it is currently 0/21.
- When coverage rises, honor and silent-drop **will move**, and the movement is
  **not** a quality change: it is a **population change**. The newly-scoreable
  jobs are the slow/lost cohort, which has never been sampled. **Any shift in
  the rates on the first post-fix read must be attributed to coverage, not to
  the product getting better or worse.** I am registering that now so it cannot
  be claimed either way later.

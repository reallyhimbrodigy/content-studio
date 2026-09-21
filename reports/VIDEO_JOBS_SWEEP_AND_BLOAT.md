# video_jobs — sweep reads and table bloat, both numbers

**Builder 2, 2026-09-21.** Read-only throughout. Supabase is read-only for this
lane, so the index, the autovacuum setting and the VACUUM are written here as
exact SQL and **not executed**. One of the two turns out not to be wanted.

## Number 2 — bloat and autovacuum: THE PREMISE DOES NOT HOLD

`pg_stat_user_tables`, project `ejxkzsfruykvgeouymfy`:

| | video_jobs |
|---|--:|
| live tuples | 12,643 |
| **dead tuples** | **1,343** |
| dead as % of live | 10.6% |
| last autovacuum | 2026-09-20 11:50:35Z (~19.6 h before the read) |
| autovacuum_count | 219 |
| last autoanalyze | 2026-09-21 07:19:06Z (~11 min before the read) |
| manual vacuum_count | 0 |

**The ruling was "if dead tuples are in the hundreds of thousands". They are
1,343** — between two and three orders of magnitude below that, on a table of
12,643 live rows. Autovacuum has run 219 times and last ran yesterday morning;
autoanalyze ran eleven minutes before the read. **So the conditional does not
fire: no scale-factor change, no VACUUM.** Doing either anyway would be
spending a quiet window on a table that is not bloated, and lowering the scale
factor on a 12.6k-row table makes autovacuum run more often for nothing.

**Where the 112 MB actually is, since size was probably the thing that prompted
this.** It is not dead rows:

    heap        20 MB
    indexes    2.5 MB   (13 of them)
    TOAST      90 MB    <-- 80% of the table
    total     112 MB

TOAST is out-of-line jsonb — `result`, `agentic_plan`, `edit_recipe`,
`stage_timings`. A VACUUM does not shrink it and neither does a scale factor.
The lever on 90 MB of TOAST is **not selecting those columns**, which is item 1.

## Number 1 — reads per hour on video_jobs (the BEFORE)

Edge logs, `/rest/v1/video_jobs`, GET only. Window **2026-09-20T08:00Z →
2026-09-21T07:00Z**, 23 whole hours; the two partial boundary hours are dropped
so the denominator is clean.

| | total | per hour | share |
|---|--:|--:|--:|
| **ALL GET — the before number** | **24,440** | **1,062.6/hr** | 100% |
| service_role (the server's own sweeps) | 18,586 | 808.1/hr | 76.0% |
| anon (app/user traffic) | 5,854 | 254.5/hr | 24.0% |
| **not bounded by `updated_at`** | 21,446 | 932.4/hr | **87.7%** |
| **pulls `result` / `agentic_plan`** | 11,791 | 512.7/hr | **48.2%** |
| ...of those, unbounded | 9,594 | 417.1/hr | 39.3% |
| `select=*` | 103 | 4.5/hr | 0.4% |

Range across the 23 hours: min 518/hr (00:00Z), max 2,122/hr (11:00Z).

**Three quarters of the reads are the server sweeping itself**, and nearly half
of all reads drag the 90 MB TOAST column across the wire.

**THE "AFTER" NUMBER DOES NOT EXIST YET AND IS NOT ESTIMATED HERE.** It needs
the change deployed and a clean window after it — and this lane does not deploy
(`speed`/TRUTH owns that). Quoting a projected after beside a measured before is
how an inference gets read as an observation.

### The sweeps, audited

Ten timer-driven sweeps run against `video_jobs`. The ones that both select a
TOASTed column and carry no `updated_at` bound:

| site | interval | selects | bounded? |
|---|---|---|---|
| `lib/bleed-meter.js:372` | hourly | `id,status,result,user_id` | **no** |
| `lib/bleed-meter.js:524` | hourly | `id,status,result,user_id,rendered_video_url,hls_manifest_url` | **no** |
| `lib/terminal-invariant.js:91` | 5 min | `id,status,rendered_video_url,result_url,hls_manifest_url,result` | **no** |
| `lib/terminal-invariant.js:160` | 5 min | `id,user_id,status,…,result` | **no** |
| `lib/completion-reconcile.js:36` | 2 min | `id,user_id,created_at,status,rendered_video_url,result_url` | **no** |
| `lib/completion-reconcile.js:167` | 2 min | `id,user_id,created_at,rendered_video_url` | **no** |
| `server.js:7548` | request path | `…,edit_recipe,transcript,agentic_plan` | **no** |
| `server.js:7974` | request path | `id,user_id,result` | **no** |

Already correct, kept as the pattern to copy: `lib/orphan-redispatch.js:86`,
`lib/completion-repair.js:99`, `lib/lifecycle-push.js:115/249`,
`lib/job-reaper.js:272` — all bound by `updated_at`.

Three `select('*')` remain in `server.js` (L622, L3239, L3254, L6890, L6997) —
on a table whose row is mostly TOAST, `*` is the most expensive shape there is.

## The index — ABSENT, and correctly proposed

Thirteen indexes exist on `video_jobs`. **There is no `(status, updated_at)`.**
The nearest is `idx_video_jobs_status_created` on `(status, created_at DESC)`,
which cannot serve an `updated_at` bound.

So the proposal is right, with one caveat worth stating: an index only helps
once the sweeps actually filter on `updated_at`. Added today, against sweeps
that do not, it would be 13 indexes becoming 14 and nothing measurable moving.
**Order matters: bound the sweeps first, then add the index, then re-measure.**

## SQL, ready but NOT RUN

```sql
-- 1. the index. CONCURRENTLY so it does not lock the table; it cannot run
--    inside a transaction block, so it is its own migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_video_jobs_status_updated
  ON public.video_jobs USING btree (status, updated_at DESC);

-- 2. NOT RECOMMENDED on today's numbers — recorded so the decision is on the
--    record rather than re-derived. 1,343 dead tuples on 12,643 live rows is
--    healthy; the default scale factor is already keeping up (219 autovacuums).
-- ALTER TABLE public.video_jobs SET (autovacuum_vacuum_scale_factor = 0.02);
-- VACUUM (ANALYZE) public.video_jobs;
```

## What I did not do, and why

Supabase is read-only for this lane — no writes, no migrations. Every number
above is a `SELECT`. The index needs your go-ahead; the autovacuum change and
the VACUUM I am recommending **against** on the measurement, not deferring.

---

# CORRECTION, before the deploy window is spent

Two corrections to what I reported above, both found by re-reading my own
instrument rather than by anything downstream. **The plan as ruled would spend
tonight's window on changes that cannot move the number it will then be measured
by.** Stated before the edits rather than discovered in the "after".

## Correction 1 — my "87.7% unbounded" was measured loosely

I counted `updated_at` appearing ANYWHERE in the URL as "bounded". PostgREST
puts it there for a plain `select=` too. Split properly:

| | total | share |
|---|--:|--:|
| FILTERED on `updated_at` (`updated_at=gte.` etc.) | 1,484 | 6.1% |
| `updated_at` only in the select list | 1,510 | 6.2% |
| absent entirely | 21,446 | 87.7% |

So **93.9% carry no `updated_at` bound**, not 87.7%. Same 24,440 denominator,
so the cross-check still holds. The direction of my conclusion was right; the
number was wrong, and it was wrong the way *two numbers with the same name*
always is — I never said whether I meant a filter or a mention.

## Correction 2 — THE THREE NAMED SWEEPS ARE NOT THE THREE WORST

Every timer sweep, named from its URL signature and checked against its own
timer (per-pass ≈ 1.0 everywhere, which is how I know the attribution is right):

| sweep | timer | reads/hr | per pass | heavy column |
|---|---|--:|--:|---|
| **refund-leg** | 60s | **121.0** | 2.02 | `result` |
| **agentic sweep** | 60s | **60.5** | 1.01 | `agentic_plan` |
| **missed-push** (lifecycle-push) | 60s | **60.5** | 1.01 | `result` |
| completion-reconcile: unprojected | 120s | 30.3 | 1.01 | `result` |
| completion-reconcile: unhandedover | 120s | 30.3 | 1.01 | — |
| job-reaper *(already correct)* | 120s | 30.3 | 1.01 | — |
| orphan-redispatch | 180s | 20.2 | 1.01 | `result,transcript,analysis_data,edit_recipe` |
| completion-watchdog | 300s | 12.2 | 1.02 | — |
| chat-attach | 600s | 6.2 | 1.03 | — |
| **bleed-meter** | 3600s | **0.1** | 0.09 | `result` |
| **terminal-invariant** | 300s | **0.0** | 0.00 | `result` |

    Zac's named three  60.6/hr    5.7% of all GET
    measured worst 3  241.9/hr   22.8% of all GET     <-- 4x the prize

**`terminal-invariant` never runs.** `terminal-invariant`, `terminalInvariant`
and `TERMINAL_INVARIANT` appear ZERO times in `server.js`. It is an unmounted
module — built, committed, never wired. Its 0 reads are not a quiet sweep, they
are a sweep that does not exist. Slimming its query would have been an edit to
dead code, and the edit would have looked completely reasonable in review.

**`bleed-meter` is already free.** It reports once a day at
`BLEED_REPORT_HOUR_UTC=15` — 2 reads in 23 hours, 0.09 per pass because almost
every pass returns before querying.

So two of the three named files are no-ops, and the third
(completion-reconcile, 60.6/hr) is real but fourth-largest.

## Correction 3 — BOUNDING CANNOT MOVE READS/HOUR AT ALL

This is the one that decides the window. Reads/hour is a REQUEST COUNT:

    reads/hour = passes/hour x queries/pass

Every sweep in that table is already at **~1.0 queries per pass** — there is no
N+1 anywhere. A sweep that scans 12,000 rows and one that scans 12 both cost
**one** request. So an `updated_at` bound changes rows scanned, bytes returned
and TOAST detoasted — all real, all worth doing — and changes the edge-log count
by **zero**.

The only levers on reads/hour are: fewer passes (timers), fewer queries per pass
(refund-leg is the sole sweep above 1.0, at 2.02 — merging its two queries saves
~60/hr), or deleting a sweep.

**If we ship the bound-and-slim tonight and re-measure reads/hr after two clean
hours, the honest result is NO CHANGE — and it will look like the change
failed.** It will not have; it will have been measured by the wrong instrument.

## What I recommend instead

Split the goal, because it is two goals:

1. **To cut reads/hour** — merge refund-leg's 2 queries into 1 (−60/hr, −5.7%),
   and decide what to do about the 376/hr of single-row `id=eq.UUID` lookups,
   which are the largest single bucket at 35% of service_role traffic and are
   request-path, not sweeps. That is an SSE/caching question, not a sweep fix.
2. **To cut bytes and DB CPU** — drop `result`/`agentic_plan` from refund-leg,
   the agentic sweep, missed-push, completion-reconcile and orphan-redispatch,
   and bound them. Measure it as **bytes and `origin_time`**, not request count.
3. **Delete or wire `terminal-invariant`.** An unmounted module in the sweep
   list is how a dead check gets counted as coverage.

The `(status, updated_at)` index still stands on its own merits for the sweeps
that will then filter on it — but note nothing today filters on `status` +
`updated_at` together, so it should follow the bound, not lead it.

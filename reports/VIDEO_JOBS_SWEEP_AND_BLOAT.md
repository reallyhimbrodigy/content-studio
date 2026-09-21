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

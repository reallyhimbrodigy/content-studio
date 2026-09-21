# Sweep IO baseline — pinned at deploy

**Deploy:** `c3abce5` pushed to `main` 2026-09-21, pre-push gates green
(event-allowlist OK; QUIET-WINDOW OK, 0 in-flight jobs, probe confirmed live).
**Snapshot taken:** `2026-09-21 18:29:33.198316 UTC`, from `pg_stat_statements`
on `ejxkzsfruykvgeouymfy`.

`shared_blks_read` is **0 on every sweep** — the table is fully cached, so disk
reads cannot show this change in either direction. The metrics that move are
`shared_blks_hit` (buffer churn, and therefore CPU) and `total_exec_time`.

| sweep | queryid | calls | shared_blks_hit | blks_read | total_ms |
|---|---|--:|--:|--:|--:|
| C lifecycle-push *(unchanged — index step)* | `3970750651530067804` | 83,775 | 153,870,963 | 0 | 12,841,493 |
| D completion-reconcile **(OLD, full `result`)** | `2171781749773191214` | 36,139 | 62,868,012 | 0 | 3,421,772 |
| E orphan-redispatch *(unchanged)* | `5647411301314853412` | 18,264 | 36,301,176 | 0 | 2,183,584 |
| B agentic-dispatch **(OLD, with `agentic_plan`)** | `7754291527127373873` | 15,568 | 12,826,157 | 2 | 1,369,197 |
| F job-reaper **(CONTROL, deliberately unchanged)** | `4044357360059163055` | 11,218 | 14,637,706 | 0 | 1,107,593 |
| E orphan-redispatch (second stmt) | `-5841113634092812012` | 5,144 | 4,364,627 | 0 | 120,508 |

## How to read the "after", and why it is unambiguous

**The changed statements get NEW queryids.** `pg_stat_statements` keys on
normalised SQL text, and B and D now select different columns, so their old
queryids **freeze at the numbers above** and new rows appear. That makes this a
cleaner comparison than a cumulative delta: the before is the frozen row, the
after is the new row, and nothing has to be subtracted across a window.

Compare **per call**, not totals — the totals are lifetime since 2025-11-16 and
the new statements start at zero:

    before B: 12,826,157 / 15,568 =   824 blks_hit per call
    before D: 62,868,012 / 36,139 = 1,740 blks_hit per call
    before C: 153,870,963 / 83,775 = 1,837 blks_hit per call   <-- index step
    before F: 14,637,706 / 11,218 = 1,305 blks_hit per call    <-- CONTROL

**F job-reaper is the control and is deliberately untouched.** If F's per-call
number moves too, something changed that is not this deploy — traffic shape, a
plan flip, cache pressure — and the B/D improvement cannot be attributed. A
before/after with no unchanged arm is a measurement that cannot fail.

## Next steps, in order

1. **Two clean hours** from deploy before reading anything.
2. Read the after per-call numbers for the new B and D queryids, against F.
3. **Then** the index step for C — the 214-minute one, whose cost is the
   predicate rather than the projection:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_video_jobs_lifecycle_unpushed
  ON public.video_jobs (status, updated_at DESC)
  WHERE (result->'lifecycle_push_v1') IS NULL;
```

   A partial index on the sweep's exact predicate, so the filter stops scanning
   and detoasting every candidate. `CONCURRENTLY`, so it takes no write lock;
   it cannot run inside a transaction block and is therefore its own migration.

4. Supabase's hourly Disk IO chart over the same window, as the independent read.

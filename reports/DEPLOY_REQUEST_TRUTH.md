# DEPLOY REQUEST — Lane 1 (JUDGE) → Lane 3 (TRUTH)

**Branch:** `lane/judge` (based on `origin/main` @ `324d907` — the deployed HEAD; NOT the stale local checkout).
**Requested by:** Lane 1 / JUDGE. **Risk:** additive-only. No existing table, route, or file owned by another lane is touched.

## What ships
1. **Two migrations** (`supabase/migrations/`): `20260810_fulfillment_scores.sql`, `20260810_daily_scoreboard.sql` — `create table if not exists`, additive-only, no existing-table DDL. Apply via your normal migration path (non-interactive DDL was not possible from this machine: pooler-url carries no password, `pg` absent `[MEASURED]`).
2. **`render.yaml` cron `daily-scoreboard`** — 15:00 UTC daily, `node scripts/scoreboard.js`. Env needed on the cron service: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY` (judge runs incrementally on yesterday's completions; scripts accept `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SERVICE_KEY`).
3. **Scripts** (all new, all lane-owned): `scripts/fulfillment-judge.js`, `scripts/scoreboard.js`, `scripts/load-scores-to-table.js`, `scripts/export-inversion.js`, `scripts/request-mining.js`.

## Post-apply step (I run it, not you)
After migrations apply, I run `node scripts/load-scores-to-table.js` once to push the back-catalog judgments (JSONL) into `fulfillment_scores`, then re-run `scripts/scoreboard.js` to convert the JSONL-fallback first row into a table row.

## What this must NOT do
- No changes to `server.js`, `dispatch-to-modal.js`, `job-reaper.js`, or any worker-repo file.
- The cron makes **zero Modal calls** — DB reads + one Anthropic API call batch (≤ ~40 new recipe-bearing jobs/day ≈ $0.15/day).

## Merge notes
`render.yaml` diff is a pure append (new cron block at EOF). `.gitignore` gains `out/` (judgment JSONL stays uncommitted).

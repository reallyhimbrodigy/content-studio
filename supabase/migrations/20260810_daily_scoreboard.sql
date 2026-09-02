-- LANE 1 / JUDGE — the four-number daily scoreboard (new table, additive only).
-- One row per day, written by scripts/scoreboard.js (Render cron).
create table if not exists public.daily_scoreboard (
  day date primary key,
  computed_at timestamptz not null default now(),
  -- 1. fulfillment (from fulfillment_scores over that day's judged completions)
  fulfillment_honor_rate numeric,
  fulfillment_dropped_silently_rate numeric,
  fulfillment_n_jobs int,
  -- 2. latency (e2e = completed_at - created_at; the user's wait)
  latency_p50_s numeric,
  latency_p90_s numeric,
  latency_p99_s numeric,
  latency_premium_p50_s numeric,   -- standard_editorial route only
  callback_gap_jobs int,           -- e2e - worker_total > 120s (the ~900s artifact, visible the day Lane 4 fixes it)
  latency_n_jobs int,
  -- 3. export / conversion
  exports int,
  result_views int,
  export_per_viewed numeric,
  purchases int,
  -- 4. defect rate (placeholder — populated when Lane 2's harness emits it)
  defect_rate numeric,
  defect_n int
);

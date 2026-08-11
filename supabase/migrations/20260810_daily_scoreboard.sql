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
  purchases int,                   -- PINNED: purchase_started MINUS purchase_failed that day (client-side net-attempt proxy; purchase_completed event is broken: 6 all-time vs RC truth)
  active_pro_subs int,             -- PINNED: snapshot count of profiles tier=pro AND comp_pro!=true AND rc_product_id NOT NULL (a real RC purchase; excludes comps + manual grants) AND pro_until > now. NOTE rc_environment is NULL on all rows [MEASURED] so it cannot be used — RevenueCat-fed truth LEVEL; day-over-day delta = net conversions
  -- sentinel: outage annotation (backtested against the 2026-08-08 route-collapse window)
  outage boolean not null default false,
  outage_note text,
  sentinel jsonb,
  -- 4. defect rate (placeholder — populated when Lane 2's harness emits it)
  defect_rate numeric,
  defect_n int
);

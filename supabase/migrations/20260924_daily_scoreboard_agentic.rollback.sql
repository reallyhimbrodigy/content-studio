-- Rollback for 20260924_daily_scoreboard_agentic.sql.
-- Drops eleven columns and the data in them. The scoreboard keeps writing the
-- other twenty-two either way — it narrows the row to what the table has.
alter table public.daily_scoreboard
  drop column if exists agentic_state,
  drop column if exists agentic_n_runs,
  drop column if exists agentic_n_asks,
  drop column if exists agentic_unchecked,
  drop column if exists agentic_honor_rate,
  drop column if exists agentic_silent_drop_rate,
  drop column if exists agentic_negotiated_rate,
  drop column if exists agentic_why,
  drop column if exists agentic_density_state,
  drop column if exists agentic_density_split,
  drop column if exists agentic_density_routes;

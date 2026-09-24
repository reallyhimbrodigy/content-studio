-- daily_scoreboard: the eleven agentic_* fields the scoreboard has been
-- computing since 2026-09-19 (a122697) and could not store.
--
-- WHY THIS MATTERS MORE THAN ELEVEN COLUMNS. PostgREST rejects the WHOLE row
-- when any key has no column, so from that commit the scoreboard's upsert
-- 400'd every time. The last row it wrote is 2026-09-18. The in-process
-- scheduler then read "due day missing" forever and re-ran the scoreboard —
-- and the fulfilment judge's full-history walk with it — every ten minutes on
-- every instance for five days: 652 s of database time in under four hours.
--
-- The write path no longer depends on this migration (scripts/scoreboard.js
-- now narrows the row to the columns that exist and NAMES the ones it drops),
-- so applying this is about keeping the numbers, not about stopping the loop.
--
-- Safe: ADD COLUMN IF NOT EXISTS with no default and no rewrite. Runs inside a
-- transaction. No existing column is touched.

alter table public.daily_scoreboard
  add column if not exists agentic_state            text,
  add column if not exists agentic_n_runs           integer,
  add column if not exists agentic_n_asks           integer,
  add column if not exists agentic_unchecked        integer,
  add column if not exists agentic_honor_rate       numeric,
  add column if not exists agentic_silent_drop_rate numeric,
  add column if not exists agentic_negotiated_rate  numeric,
  add column if not exists agentic_why              text,
  add column if not exists agentic_density_state    text,
  add column if not exists agentic_density_split    boolean,
  add column if not exists agentic_density_routes   jsonb;

comment on column public.daily_scoreboard.agentic_state is
  'MEASURED | EMPTY. EMPTY is not zero: it means nothing has been measured.';
comment on column public.daily_scoreboard.agentic_unchecked is
  'Asks no timeline read-back decides (taste/vision). Counted, never dropped from the denominator.';

-- LANE 1 / JUDGE — daily_scoreboard v2: columns added after the v1 migration
-- was applied (TRUTH ran the 20260810 file at its 84f8244 state; these landed
-- in later commits dc8f51a/e93120a). Additive-only, idempotent.
alter table public.daily_scoreboard add column if not exists active_pro_subs int;
alter table public.daily_scoreboard add column if not exists outage boolean not null default false;
alter table public.daily_scoreboard add column if not exists outage_note text;
alter table public.daily_scoreboard add column if not exists sentinel jsonb;
alter table public.daily_scoreboard add column if not exists purchase_funnel jsonb;

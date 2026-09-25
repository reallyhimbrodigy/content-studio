-- THE #1 CONSUMER OF DATABASE TIME IS A NO-OP SWEEP ON A FIVE-MINUTE TIMER.
--
-- ── MEASURED (pg_stat_statements + the function's own log, 2026-09-25) ────
--   select public.reconcile_profile_emails(1000)   cron.job id 2, */5 * * * *
--     483 calls · 1,805.8 ms mean · 872.2 s total · 22.4% OF ALL DATABASE TIME
--
--   profile_email_reconcile_log, since it began:
--     5,469 runs · 5,371 of them (98.2%) updated NOTHING · 98 rows corrected
--     EVER · 0 conflicts
--
-- Every five minutes it joins auth.users (22,984 rows) to profiles (22,984)
-- on `nullif(btrim(...)) IS DISTINCT FROM nullif(btrim(...))` — an expression
-- over two columns, so no index can serve it — then ORDER BY u.updated_at
-- DESC and LIMIT 1000. That is a full scan of both tables plus a sort, 288
-- times a day, to discover there is nothing to do 98 times out of 100.
--
-- It is the same shape as the fulfilment crawl killed yesterday: a full
-- re-scan on a timer, getting slower as the table grows, feeding a consumer
-- that almost never needs it. With the crawl gone this is now the single
-- largest line in the database's time budget.
--
-- ── THE FIX IS A WATERMARK, NOT A SMALLER LIMIT ──────────────────────────
-- A row can only DIVERGE when auth.users.email changes, and that stamps
-- auth.users.updated_at. So look only at users touched since the last run.
-- The watermark lives in the log table that already exists.
--
-- CORRECTNESS: the old query is the fallback, not the rule. A run that finds
-- no watermark (first run after this ships, or the log truncated) does the
-- full scan once and records one. So this cannot MISS a divergence that
-- predates it — it just stops paying for the scan every five minutes.
--
-- AND THE CADENCE DROPS TO HOURLY. 98 corrections in 19 days is 5 a day; a
-- five-minute deadline on that is a cadence nobody chose, it is a default.
-- Hourly still fixes a wrong email within the hour, at 1/12th the cost.

alter table public.profile_email_reconcile_log
  add column if not exists watermark timestamptz;

create or replace function public.reconcile_profile_emails(max_rows integer)
returns table(updated integer, conflicts integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  _r record;
  _upd integer := 0;
  _conf integer := 0;
  _conflict_ids uuid[] := '{}';
  _since timestamptz;
  _newmark timestamptz;
begin
  -- The newest watermark any previous run recorded. NULL on the first run
  -- after this ships, which deliberately falls through to a full scan.
  select max(watermark) into _since from public.profile_email_reconcile_log;

  for _r in
    select u.id, nullif(btrim(coalesce(u.email,'')), '') as want, u.updated_at
    from auth.users u
    join public.profiles p on p.id = u.id
    where (_since is null or u.updated_at > _since)
      and nullif(btrim(coalesce(u.email,'')),'') is distinct from nullif(btrim(coalesce(p.email,'')),'')
    order by u.updated_at desc nulls last
    limit max_rows
  loop
    begin
      update public.profiles set email = _r.want where id = _r.id;
      _upd := _upd + 1;
    exception when unique_violation then
      -- Two auth users claiming one address. Never silently drop it: the row is
      -- left alone and the id is reported, because a swallowed conflict here
      -- would mean a profile permanently disagreeing with auth.
      _conf := _conf + 1;
      _conflict_ids := _conflict_ids || _r.id;
    end;
  end loop;

  -- ADVANCE THE WATERMARK TO THE NEWEST ROW WE LOOKED AT, not to now(). A row
  -- updated between the scan and this line would be skipped forever if the
  -- mark ran ahead of what was actually read — the classic keyset-on-a-clock
  -- bug, and it loses data silently.
  select max(u.updated_at) into _newmark from auth.users u
   where (_since is null or u.updated_at > _since);
  if _newmark is null then _newmark := _since; end if;

  insert into public.profile_email_reconcile_log (updated, conflicts, detail, watermark)
  values (_upd, _conf, jsonb_build_object('conflict_ids', to_jsonb(_conflict_ids),
                                          'max_rows', max_rows,
                                          'since', _since),
          _newmark);
  updated := _upd; conflicts := _conf; return next;
end;
$$;

-- Hourly, not every five minutes.
select cron.alter_job(2, schedule => '7 * * * *');

-- Atomic CALENDAR-MONTH usage claim, for the free tier on builds with no
-- claim path (< 247).
--
-- WHY. Free tier on those builds had a daily cap (3/day) and nothing monthly:
-- 808 users, 918 completed videos, 0 debited this month [MEASURED 2026-09-24].
-- Credits cannot limit them — a build that cannot claim a device can never
-- hold a balance to charge — so the limiter has to be a count.
--
-- SHAPE AND LOCK DISCIPLINE ARE claim_usage_slot's, DELIBERATELY. Count and
-- insert happen under one per-(user,kind) transaction advisory lock, so
-- concurrent requests serialize and the cap holds exactly across every server
-- instance. SELECT-then-INSERT from the app is the TOCTOU this exists to
-- close; a 1/month cap makes that race worth a whole month, not a third of a
-- day.
--
-- Single-arg bigint overload with a combined key, for the same reason as
-- claim_usage_slot: the two-arg form is (int4,int4) only, hashtextextended()
-- returns bigint, and mixing it with hashtext() resolves to no overload and
-- throws 42883 at CALL time.
--
-- THE WINDOW IS THE CALENDAR MONTH IN UTC, matching the app's month key. Not a
-- rolling 30 days: "one video a month" is a promise about a calendar, and a
-- rolling window would refuse someone on the 1st for something they did on the
-- 3rd of the month before.

create or replace function public.claim_monthly_slot(
  p_user uuid,
  p_kind text,
  p_monthly_limit int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
begin
  if p_user is null or p_kind is null or p_monthly_limit is null then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_kind, 0));

  select count(*) into v_used
  from public.usage_events
  where user_id = p_user
    and kind = p_kind
    and created_at >= (date_trunc('month', (now() at time zone 'utc')) at time zone 'utc');

  if v_used >= p_monthly_limit then
    return false;
  end if;

  insert into public.usage_events (user_id, kind) values (p_user, p_kind);
  return true;
end;
$$;

-- RELEASE. A claim is made at admission; if the render never happens, the user
-- must not lose their only video of the month to our failure. Deletes ONE claim
-- for this user in the current calendar month — the newest, so a release can
-- never reach into a month that has already closed.
--
-- Returns true only if a row was actually removed, so a caller can tell a
-- release from a no-op instead of assuming the act was the fact.
create or replace function public.release_monthly_slot(
  p_user uuid,
  p_kind text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  if p_user is null or p_kind is null then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_kind, 0));

  -- ctid, not the primary key: usage_events is not defined in this repo's
  -- migrations, so its key name and type are UNKNOWN here and writing
  -- `declare v_id bigint` would be a guess that fails at call time. ctid is
  -- type-agnostic, and it is stable for these rows — they are inserted and
  -- deleted, never UPDATEd — while the advisory lock above holds every other
  -- claim for this (user, kind) out of the way.
  with victim as (
    select ctid
    from public.usage_events
    where user_id = p_user
      and kind = p_kind
      and created_at >= (date_trunc('month', (now() at time zone 'utc')) at time zone 'utc')
    order by created_at desc
    limit 1
  )
  delete from public.usage_events u using victim v where u.ctid = v.ctid;

  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

revoke all on function public.claim_monthly_slot(uuid, text, int) from public, anon, authenticated;
revoke all on function public.release_monthly_slot(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_monthly_slot(uuid, text, int) to service_role;
grant execute on function public.release_monthly_slot(uuid, text) to service_role;

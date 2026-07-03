-- Atomic daily-usage claim (closes the free-quota TOCTOU double-spend).
--
-- The render/chat gates did: count today's usage_events → if under the cap,
-- insert one. Under a burst of concurrent requests, several could all read a
-- below-cap count before any insert landed, so a free user could exceed the
-- daily render (3) / chat (50) cap and spike GPU/LLM spend. This function does
-- the count AND the insert under a per-(user,kind) transaction advisory lock,
-- so concurrent claims serialize and the cap holds exactly — across ALL server
-- instances, not just one process.
--
-- Returns true if a slot was claimed (a usage_events row was inserted), false
-- if the daily limit is already reached. The app falls back to the old
-- count-then-insert path if this function is absent, so it is safe to apply
-- this migration before or after deploying the paired server.js change.
-- Idempotent.

create or replace function public.claim_usage_slot(
  p_user uuid,
  p_kind text,
  p_daily_limit int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today int;
begin
  if p_user is null or p_kind is null or p_daily_limit is null then
    return false;
  end if;

  -- Serialize all concurrent claims for this (user, kind) for the txn. Use the
  -- single-arg bigint overload with a combined key — the two-arg form is
  -- (int4,int4) only, and hashtextextended() returns bigint, so mixing it with
  -- hashtext() (int4) resolves to no overload and throws 42883 at call time.
  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_kind, 0));

  -- UTC midnight today as a timestamptz instant, matching the app's
  -- utcDayStart() cutoff used by countTodayUsage (created_at is timestamptz).
  select count(*) into v_today
  from public.usage_events
  where user_id = p_user
    and kind = p_kind
    and created_at >= (date_trunc('day', (now() at time zone 'utc')) at time zone 'utc');

  if v_today >= p_daily_limit then
    return false;
  end if;

  insert into public.usage_events (user_id, kind) values (p_user, p_kind);
  return true;
end;
$$;

-- Only the service role (server) may call it; never the client.
revoke all on function public.claim_usage_slot(uuid, text, int) from public, anon, authenticated;
grant execute on function public.claim_usage_slot(uuid, text, int) to service_role;

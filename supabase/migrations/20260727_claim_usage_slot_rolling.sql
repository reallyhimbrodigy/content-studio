-- Rolling-24h render quota (supersedes the UTC-day window in 20260702).
--
-- The UTC-midnight window let a free user render at 23:59 and again at 00:01 —
-- two ~$0.40 GPU renders minutes apart against a 1/day cap. This makes RENDER
-- claims count a rolling 24h-from-use window (matches the "1/day" mental model
-- and closes the double-spend). CHAT (+anything else) keeps the UTC-day window
-- — it's cheap (LLM, not GPU) and the midnight property doesn't matter there.
--
-- Only the window predicate changes; the advisory lock + count + insert are
-- untouched. server.js's usageWindowStart(kind) mirrors this predicate exactly,
-- and its count-then-insert fallback also went rolling, so it is safe to apply
-- this migration before or after the paired server deploy (enforcement is just
-- UTC-day for the brief window between them — benign; no user is wrongly
-- blocked, the abuse simply isn't closed yet). Idempotent.

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
  v_used int;
begin
  if p_user is null or p_kind is null or p_daily_limit is null then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_kind, 0));

  if p_kind = 'render' then
    -- Rolling 24h-from-use: closes the 23:59 + 00:01 double-render.
    select count(*) into v_used
    from public.usage_events
    where user_id = p_user
      and kind = p_kind
      and created_at >= now() - interval '24 hours';
  else
    -- Chat (+others): unchanged UTC-day window.
    select count(*) into v_used
    from public.usage_events
    where user_id = p_user
      and kind = p_kind
      and created_at >= (date_trunc('day', (now() at time zone 'utc')) at time zone 'utc');
  end if;

  if v_used >= p_daily_limit then
    return false;
  end if;

  insert into public.usage_events (user_id, kind) values (p_user, p_kind);
  return true;
end;
$$;

revoke all on function public.claim_usage_slot(uuid, text, int) from public, anon, authenticated;
grant execute on function public.claim_usage_slot(uuid, text, int) to service_role;

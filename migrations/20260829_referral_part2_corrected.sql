-- ============================================================================
-- REFERRAL PART 2 (CORRECTED) — harden qualification and claim, in place.
-- 2026-08-29
--
-- Parts 1 and 3 are already applied. The revokes removed `authenticated`
-- EXECUTE from qualify_referral and grant_referral_reward, so THIS file is
-- defense-in-depth rather than the closure: it makes the functions safe on
-- their own terms, so that a future grant, a new caller, or a copied pattern
-- cannot reopen the hole.
--
-- WHAT THE PREVIOUS DRAFT GOT WRONG (all four preserved correctly below):
--   • Both functions RETURN jsonb in production; the draft declared `void`.
--     Postgres refuses a return-type change through CREATE OR REPLACE, so the
--     transaction would have rolled back and nothing would have applied —
--     including the revokes that actually close the exploit.
--   • upper(trim(p_code)) normalisation was dropped from BOTH the lookup and
--     the insert, which would have broken every lowercase or space-padded code
--     a user types — i.e. most of them.
--   • The unique_violation handler was replaced with a `where not exists`
--     guard, which is race-prone where catching the constraint is not.
--   • The distinct reason codes (unknown_code / self_referral /
--     already_referred) were collapsed into silent no-ops the client cannot
--     tell apart.
--
-- Only two things are ADDED: the auth.uid() guard, and the job-existence check.
-- Everything else is the original behaviour, unchanged.
-- ============================================================================

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- qualify_referral — the exploit.
--
-- Original body accepted p_job unverified: never checked to exist, to belong to
-- p_referred, or to have completed. Chain: three throwaway accounts, claim on
-- each, qualify with any UUID, grant to self — a week of unmetered Pro for zero
-- renders.
--
-- Added: the auth.uid() guard, and the EXISTS check on video_jobs. The return
-- shape is unchanged, including `newly_qualified`, which now naturally reports
-- 0 when the job does not check out — so a caller sees "nothing qualified"
-- rather than a lie.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.qualify_referral(p_referred uuid, p_job uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  -- auth.uid() is NULL for service_role, which is how the server-side reconcile
  -- calls this. A logged-in caller may only qualify themselves. Returned as a
  -- reason code rather than raised, to match the house contract: these
  -- functions report failure in jsonb, and the client parses it.
  if auth.uid() is not null and auth.uid() <> p_referred then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;

  update public.referrals r
     set qualified_at      = now(),
         qualifying_job_id = p_job
   where r.referred_id  = p_referred
     and r.qualified_at is null
     and exists (
       select 1
         from public.video_jobs j
        where j.id      = p_job
          and j.user_id = p_referred
          and j.status  = 'completed'
     );

  get diagnostics v_rows = row_count;
  return jsonb_build_object('ok', true, 'newly_qualified', v_rows);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- claim_referral — body preserved verbatim, with one guard added.
--
-- Normalisation, the unique_violation handler, and all three reason codes are
-- exactly as in production. The only change is the auth.uid() check at the top:
-- without it, any authenticated caller can create a referral row naming an
-- arbitrary p_referred, which is how a referrer manufactures referrals for
-- accounts that are not theirs to claim.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.claim_referral(p_referred uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_referrer uuid;
begin
  if auth.uid() is null or auth.uid() <> p_referred then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;

  select id into v_referrer
    from profiles
   where referral_code = upper(trim(p_code));

  if v_referrer is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_code');
  end if;

  if v_referrer = p_referred then
    return jsonb_build_object('ok', false, 'reason', 'self_referral');
  end if;

  if exists (select 1 from referrals where referred_id = p_referred) then
    return jsonb_build_object('ok', false, 'reason', 'already_referred');
  end if;

  insert into referrals (referrer_id, referred_id, code)
  values (v_referrer, p_referred, upper(trim(p_code)));

  return jsonb_build_object('ok', true, 'referrer_id', v_referrer);

exception when unique_violation then
  return jsonb_build_object('ok', false, 'reason', 'already_referred');
end;
$$;

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY AFTER APPLYING
--
--   -- return types must still be jsonb (a void here means the wrong body landed)
--   select p.proname, pg_get_function_result(p.oid) as returns
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('claim_referral','qualify_referral');
--
--   -- normalisation survived: a lowercase, space-padded code must still resolve
--   select public.claim_referral('<a-user-uuid>', '  abc123  ');
--        -- expect ok:false + a REASON (not_authorized when run as service_role,
--        -- which is itself the guard working), never a silent null
--
--   -- the exploit is closed: a foreign / nonexistent job qualifies nothing
--   select public.qualify_referral('<referred-uuid>', gen_random_uuid());
--        -- expect {"ok": true, "newly_qualified": 0}
-- ─────────────────────────────────────────────────────────────────────────────

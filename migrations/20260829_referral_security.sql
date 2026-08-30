-- ============================================================================
-- REFERRAL: close the qualification hole, and extend the EXISTING ledger.
-- 2026-08-29
--
-- APPLY AS ONE TRANSACTION. Column names here are the contract with server.js;
-- do not rename anything without changing lib/referral-reconcile.js with it.
--
-- Part 1 extends referral_rewards (it already exists and is a real ledger —
--        a second table was drafted and withdrawn; two ledgers for one payout
--        is how a cap ends up enforced against half the total).
-- Part 2 fixes the live exploit in qualify_referral.
-- Part 3 revokes what nothing calls.
-- ============================================================================

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 1 — extend the existing ledger.
--
-- referral_rewards already records user_id, granted_at, days_granted,
-- pro_until_before, pro_until_after and referral_ids. The one thing it cannot
-- express is whether the grant SUCCEEDED at the entitlement provider. Without
-- that, a failed grant and an absent grant are the same row-shaped nothing —
-- the silent-failure class that has cost this codebase repeatedly. A row is
-- written either way; provider_ok says which happened.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.referral_rewards
  add column if not exists provider        text    not null default 'db',
  add column if not exists provider_ok     boolean not null default true,
  add column if not exists provider_response jsonb;

comment on column public.referral_rewards.provider is
  'Who actually granted: ''db'' for the legacy in-database extension of pro_until, ''revenuecat'' once the promotional grant path is live.';
comment on column public.referral_rewards.provider_ok is
  'Did the grant succeed at the provider. Existing/legacy rows default true because the DB path extended pro_until inline and could not half-succeed. A failed provider call MUST still write a row with false — absence and failure are otherwise indistinguishable.';

-- The cap is a SUM over this table inside the grant transaction, so it needs
-- the (user, time) index or the check degrades into a latency problem on the
-- payout path as the table grows.
create index if not exists referral_rewards_user_time_idx
  on public.referral_rewards (user_id, granted_at desc);

-- A failed grant must be findable without scanning.
create index if not exists referral_rewards_failed_idx
  on public.referral_rewards (provider_ok, granted_at desc)
  where provider_ok = false;

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 2 — SUPERSEDED, DO NOT APPLY FROM THIS FILE.
--
-- The bodies drafted here were a RECONSTRUCTION from the client call signature,
-- not the production source, and they were wrong four ways: both functions
-- RETURN jsonb (these declared void, which CREATE OR REPLACE refuses, rolling
-- back the whole transaction); upper(trim(p_code)) normalisation was dropped;
-- the unique_violation handler was swapped for a race-prone `where not exists`;
-- and the unknown_code / self_referral / already_referred reason codes were
-- collapsed into silent no-ops.
--
-- The corrected, faithful version is 20260829_referral_part2_corrected.sql.
-- Applied Parts 1 and 3 from this file remain valid.
-- ─────────────────────────────────────────────────────────────────────────────

-- PART 3 — revoke what nothing calls.
--
-- Neither qualify_referral nor grant_referral_reward has a caller anywhere in
-- the iOS client or the Node server. They are reachable from any authenticated
-- session purely because PostgREST exposes them, and they are the two that
-- write qualification and payout. Revoking costs nothing today and removes the
-- exploit path entirely; the server-side reconcile calls them as service_role,
-- which is unaffected by these grants.
-- ─────────────────────────────────────────────────────────────────────────────
revoke execute on function public.qualify_referral(uuid, uuid)      from authenticated, anon;
revoke execute on function public.grant_referral_reward(uuid)       from authenticated, anon;

-- Explicitly keep the two the client genuinely needs.
grant  execute on function public.claim_referral(uuid, text)            to authenticated;
grant  execute on function public.get_or_create_referral_code(uuid)     to authenticated;

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY AFTER APPLYING (expect: two revoked, two granted, and a qualification
-- that refuses a job the user does not own):
--
--   select p.proname,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed_can_call
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('claim_referral','get_or_create_referral_code',
--                        'qualify_referral','grant_referral_reward');
--
--   -- expect 0 rows updated: a job that is not theirs must not qualify
--   select public.qualify_referral('<some-referred-uuid>', gen_random_uuid());
-- ─────────────────────────────────────────────────────────────────────────────

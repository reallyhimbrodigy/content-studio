-- referral_grants — the ledger the referral reward never had.
--
-- WHY (2026-08-29): the reward lived in Postgres functions that exist only in
-- Supabase, with no record of what was given out. "How many free Pro days have
-- we granted, to whom, and when" had no answer at all. Granted Pro is unmetered
-- rendering, so that question is a spend question, not a reporting nicety — and
-- a cap cannot be enforced against a total nobody is keeping.
--
-- Every grant writes exactly one row here, in the same transaction as the
-- entitlement call. The rolling-30-day cap is a SUM over this table, so the
-- ledger IS the enforcement rather than a log written beside it.

create table if not exists public.referral_grants (
  id             uuid primary key default gen_random_uuid(),

  -- Who earned it. Indexed because every cap check filters on this.
  referrer_id    uuid not null references auth.users(id) on delete cascade,

  -- Which referral earned it. Nullable: a bonus is earned by crossing a
  -- threshold rather than by any single referral, so it belongs to no one row.
  referred_id    uuid references auth.users(id) on delete set null,

  days           integer not null check (days > 0),

  -- 'ladder' = one qualified referral; 'bonus' = the threshold payment.
  -- Kept distinct so a spend read can separate steady earning from milestones
  -- rather than inferring it from the size of the number.
  kind           text not null default 'ladder' check (kind in ('ladder','bonus')),

  -- What the entitlement provider actually said. Stored verbatim: a grant we
  -- believe happened and one that did are different facts, and the second
  -- entitlement source this loop introduces must be reconcilable against the
  -- provider without a replay.
  provider       text not null default 'revenuecat',
  provider_ok    boolean not null default false,
  provider_response jsonb,

  -- The window this grant extends entitlement to, so a grant can be audited
  -- against what the user actually received.
  granted_until  timestamptz,

  created_at     timestamptz not null default now()
);

-- The cap query: SUM(days) for a referrer inside a rolling window. This index
-- is the one the enforcement path uses; without it the check degrades as the
-- table grows and the cap becomes a latency problem on the grant path.
create index if not exists referral_grants_referrer_time_idx
  on public.referral_grants (referrer_id, created_at desc);

-- A failed provider call must still leave a row (provider_ok = false) so a
-- silent failure is visible rather than absent. Absence and failure look
-- identical otherwise, which is the shape of every silent defect this month.
create index if not exists referral_grants_failed_idx
  on public.referral_grants (provider_ok, created_at desc)
  where provider_ok = false;

-- RLS: the ledger is SERVICE-ROLE ONLY. A user may see their own progress
-- through the referrals table, but must never be able to read or write what was
-- granted — this table is the cap, and a writable cap is not a cap.
alter table public.referral_grants enable row level security;

drop policy if exists referral_grants_no_client_access on public.referral_grants;
create policy referral_grants_no_client_access
  on public.referral_grants
  for all
  to authenticated, anon
  using (false)
  with check (false);

comment on table public.referral_grants is
  'Ledger of referral Pro-day grants. Service-role only. The rolling-30-day cap is a SUM over this table, so the ledger is the enforcement, not a log beside it.';

-- FREE-TIER CREDITS — two tables because there are two DIFFERENT constraints,
-- and collapsing them into one row cannot express both.
--
--   free_credit_grants   "this install may only ever seed ONE account"
--   free_credit_periods  "this ACCOUNT gets one allowance per period"
--
-- Keying the monthly refresh on device_id would give a two-device user 60/month;
-- keying the install guard on user_id would let one person make N accounts on
-- one phone and collect 30 each. Both are database constraints rather than
-- application logic: two concurrent requests cannot both insert, and no code
-- path can forget to check.

-- ── 1. THE INSTALL CLAIM ────────────────────────────────────────────────────
-- device_id is the PRIMARY KEY, so "once per install" is a uniqueness
-- constraint. A second account on a claimed device is a 409, not a grant.
--
-- THE KEY MUST BE THE KEYCHAIN-BACKED ID, exactly as reverse_trial_grants
-- documents: 241 shipped identifierForVendor cached in UserDefaults, which does
-- NOT survive reinstall. Keyed on that, this table is a delete-and-reinstall
-- faucet for 30 credits, forever. The endpoint refuses builds below the floor.
CREATE TABLE IF NOT EXISTS free_credit_grants (
  device_id   text PRIMARY KEY,
  user_id     uuid NOT NULL,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  app_build   integer
);

CREATE INDEX IF NOT EXISTS idx_free_credit_grants_user
  ON free_credit_grants (user_id);

-- ── 2. THE PER-ACCOUNT ALLOWANCE LEDGER ─────────────────────────────────────
-- (user_id, period) is the PRIMARY KEY, so "one allowance per account per
-- period" is a uniqueness constraint too. `period` is a UTC calendar month
-- ('YYYY-MM'): deterministic, comparable as text, and it cannot drift the way a
-- rolling per-user anchor does.
--
-- provider_ok MIRRORS THE REFERRAL/REFUND LEDGER PATTERN and is the reason this
-- is a table rather than a timestamp column. The row is written BEFORE the
-- RevenueCat credit, with provider_ok=false. If the credit then fails, the
-- failure is a VISIBLE ROW rather than nothing — the same absence-versus-failure
-- distinction that produced the refund-leg loop. A row stuck at false is a
-- grant that was claimed and never landed, and it is queryable.
CREATE TABLE IF NOT EXISTS free_credit_periods (
  user_id      uuid        NOT NULL,
  period       text        NOT NULL,
  amount       integer     NOT NULL,
  balance_before integer,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  provider_ok  boolean     NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, period)
);

CREATE INDEX IF NOT EXISTS idx_free_credit_periods_unlanded
  ON free_credit_periods (granted_at) WHERE provider_ok = false;

-- ── 3. RLS: ENABLED, WITH NO POLICIES ───────────────────────────────────────
-- Matching reverse_trial_grants exactly (verified live: rls_enabled=true,
-- policy_count=0). RLS enabled with zero policies is DENY-ALL for the anon and
-- authenticated roles, while service_role bypasses RLS entirely — which is what
-- the server uses via supabaseAdmin.
--
-- THIS IS NOT OPTIONAL AND IT IS NOT COSMETIC. Supabase exposes every table in
-- the public schema through PostgREST. Without RLS a signed-in client could
-- DELETE its own free_credit_periods row and get re-granted 30 credits on the
-- next render — repeatable, unlimited, and completely invisible to the server,
-- whose own logic would be behaving exactly as designed. It could equally
-- INSERT free_credit_grants rows to claim devices it has never seen.
--
-- The deny-all posture also has a second effect the code already accounts for:
-- any non-service-role read returns ZERO ROWS RATHER THAN AN ERROR, which is
-- indistinguishable from "no grant exists" and would re-grant. That is why
-- every grant-gating read in server.js uses supabaseAdmin and fails closed on
-- error rather than treating an empty result as authoritative.
ALTER TABLE free_credit_grants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE free_credit_periods ENABLE ROW LEVEL SECURITY;

-- Verify:
--   -- RLS on, zero policies, on BOTH tables (must match reverse_trial_grants):
--   SELECT c.relname, c.relrowsecurity,
--          (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) policies
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public'
--      AND c.relname IN ('free_credit_grants','free_credit_periods');
--   SELECT count(*) FROM free_credit_grants;
--   SELECT period, count(*), count(*) FILTER (WHERE provider_ok) landed
--     FROM free_credit_periods GROUP BY period ORDER BY period DESC;
--   -- grants claimed but never landed at RevenueCat (should be ~0):
--   SELECT * FROM free_credit_periods WHERE provider_ok = false;

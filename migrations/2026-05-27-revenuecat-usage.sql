-- RevenueCat + usage tracking migration
-- Replaces the Stripe-era entitlement columns with a clean two-field source
-- of truth on profiles, plus a usage_events log for daily limit counting.

-- 1) Extend profiles with the columns RevenueCat's webhook writes into.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS pro_until       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rc_app_user_id  TEXT,
  ADD COLUMN IF NOT EXISTS rc_product_id   TEXT,
  ADD COLUMN IF NOT EXISTS rc_period_type  TEXT;

CREATE INDEX IF NOT EXISTS profiles_rc_app_user_id_idx ON profiles (rc_app_user_id);

-- 2) Usage event log. One row per gated action (a render dispatch or an
--    AI chat message). Cheap to write, cheap to count per-day with the
--    composite index. We keep this even for Pro users so analytics can
--    surface engagement later — gating just doesn't read it for Pro.
CREATE TABLE IF NOT EXISTS usage_events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind        TEXT        NOT NULL CHECK (kind IN ('render','chat')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_events_user_kind_created_idx
  ON usage_events (user_id, kind, created_at DESC);

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "usage_events_select_own" ON usage_events;
CREATE POLICY "usage_events_select_own" ON usage_events
  FOR SELECT USING (auth.uid() = user_id);
-- Server-side inserts only (uses service role key); no insert policy for
-- anon/auth users means client cannot forge usage events.

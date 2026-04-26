-- Device tokens for APNs push notifications.
-- One row per (user, token) — a user can have multiple devices, and the same
-- physical device generates a fresh token after reinstall, so we just keep
-- the most recent one per device. token is unique because Apple guarantees
-- uniqueness per (app, device).

CREATE TABLE IF NOT EXISTS device_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token         TEXT NOT NULL UNIQUE,
  platform      TEXT NOT NULL CHECK (platform IN ('ios')),
  bundle_id     TEXT NOT NULL,
  app_version   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_tokens_user_idx ON device_tokens (user_id);

ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "device_tokens_select_own"  ON device_tokens;
DROP POLICY IF EXISTS "device_tokens_insert_own"  ON device_tokens;
DROP POLICY IF EXISTS "device_tokens_update_own"  ON device_tokens;
DROP POLICY IF EXISTS "device_tokens_delete_own"  ON device_tokens;

CREATE POLICY "device_tokens_select_own" ON device_tokens
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "device_tokens_insert_own" ON device_tokens
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "device_tokens_update_own" ON device_tokens
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "device_tokens_delete_own" ON device_tokens
  FOR DELETE USING (auth.uid() = user_id);

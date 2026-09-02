-- reverse_trial_grants — once-per-install, enforced by the DATABASE.
--
-- device_id is the PRIMARY KEY, so "once per install" is a uniqueness
-- constraint rather than application logic: two concurrent requests cannot both
-- insert, and no code path can forget to check.
--
-- THE KEY MUST BE THE KEYCHAIN-BACKED ID, not 241's. 241 shipped
-- identifierForVendor cached in UserDefaults, which does NOT survive reinstall —
-- keying on it would re-grant a 72-hour Pro trial on every delete/reinstall,
-- which is the exact exploit the referral security migration closed (three
-- throwaway accounts, a week of unmetered Pro). Frontend replaced it with a
-- Keychain-backed id (92f1cda, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
-- that ships in the cut AFTER 241, and the endpoint refuses builds below it.

CREATE TABLE IF NOT EXISTS reverse_trial_grants (
  device_id   text PRIMARY KEY,
  user_id     uuid NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  pro_until   timestamptz NOT NULL,
  app_build   integer,
  reward_id   uuid
);

CREATE INDEX IF NOT EXISTS idx_reverse_trial_user ON reverse_trial_grants (user_id);

-- Verify:
--   SELECT count(*), min(granted_at), max(granted_at) FROM reverse_trial_grants;

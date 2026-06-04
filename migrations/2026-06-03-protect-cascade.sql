-- Protect video_jobs and chats from cascade-deletion when an auth.users row is removed.
--
-- BEFORE: ON DELETE CASCADE — deleting a user wiped all their videos and chats
-- from the database with no recovery path. A misclick in the Supabase
-- dashboard or an account-deletion flow would destroy irreplaceable user content.
--
-- AFTER: ON DELETE SET NULL — deleting a user orphans their rows (user_id = NULL)
-- but the data itself persists. The /api/account/delete endpoint is responsible
-- for the explicit cleanup when a user actually requests deletion; this
-- migration just prevents accidental destruction.
--
-- profiles, usage_events, and device_tokens deliberately stay on CASCADE
-- because they're metadata/telemetry that's worthless without the user.

-- video_jobs
ALTER TABLE video_jobs DROP CONSTRAINT IF EXISTS video_jobs_user_id_fkey;
ALTER TABLE video_jobs ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE video_jobs
  ADD CONSTRAINT video_jobs_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES auth.users(id)
  ON DELETE SET NULL;

-- chats
ALTER TABLE chats DROP CONSTRAINT IF EXISTS chats_user_id_fkey;
ALTER TABLE chats ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE chats
  ADD CONSTRAINT chats_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES auth.users(id)
  ON DELETE SET NULL;

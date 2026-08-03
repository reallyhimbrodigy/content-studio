-- video_jobs.app_version — bucket job OUTCOMES by client build.
--
-- Without this, no build-adoption question is answerable: a client fix that has
-- shipped but not been adopted is indistinguishable from a fix that is broken.
-- analytics_events already carries app_version; this closes the same gap on the
-- job row (completed / failed / error_code by build).
--
-- Additive, idempotent, zero-risk. A nullable text column add takes no
-- meaningful lock and cannot affect an in-flight insert. The server writes this
-- best-effort AFTER the insert with errors swallowed, so it is safe to apply
-- this migration BEFORE or AFTER the server deploy — order does not matter.
--
-- Run in the Supabase SQL editor (paste + Run). Safe to re-run.

ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS app_version text;

-- Build-adoption queries ("failure rate by app_version") will be frequent; a
-- plain btree index on the nullable text column is cheap and sufficient.
CREATE INDEX IF NOT EXISTS idx_video_jobs_app_version ON video_jobs (app_version);

-- After applying, verify the column exists and starts populating on NEW jobs:
--   SELECT app_version, count(*) FROM video_jobs
--    WHERE created_at > now() - interval '1 hour'
--    GROUP BY app_version ORDER BY 2 DESC;
-- Live 1.2.0/1.3.x clients populate it from the User-Agent build number
-- ("221"); build 224+ populates the explicit "1.3.6 (224)" via X-App-Version.

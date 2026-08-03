-- video_jobs.source_type + source_duration — source provenance per job.
--
-- source_type ('local' | 'icloud') makes the iCloud upload-reliability fix
-- MEASURABLE: which UPLOAD_NEVER_STARTED jobs were iCloud-sourced (the class the
-- .stream→durable→background-upload fix targets). source_duration (seconds of the
-- picked clip) is the only way to deconfound wait-time from clip length.
--
-- Additive, idempotent, zero-risk. Nullable columns; the server writes them
-- best-effort AFTER the insert (errors swallowed), so apply BEFORE or AFTER the
-- deploy — order does not matter. Run in the Supabase SQL editor. Safe to re-run.

ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS source_type text;
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS source_duration numeric;
CREATE INDEX IF NOT EXISTS idx_video_jobs_source_type ON video_jobs (source_type);

-- Verify after applying (new jobs from build 224+ populate these):
--   SELECT source_type, count(*) FROM video_jobs
--    WHERE created_at > now() - interval '1 hour' GROUP BY source_type;

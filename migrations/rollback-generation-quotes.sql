-- ROLLBACK for add-generation-quotes.sql.
--
-- ORDER MATTERS AND SO DOES WHAT IS *NOT* HERE. The two ALTER TABLE columns
-- on video_jobs are dropped LAST and separately, because video_jobs is a live
-- table carrying 12,852 rows of production history: dropping a column from it
-- is not symmetric with creating one. If anything has begun writing
-- queue_position or eta_seconds, dropping them discards real data, and this
-- script cannot know that. Run the first half freely; read the second half.
--
-- The three new tables are safe to drop: nothing outside this contract reads
-- them, and if the feature is being rolled back they hold only in-flight
-- quotes, which are worth less than the confusion of leaving them behind.

-- ── SAFE: the three tables this migration created ────────────────────────
DROP INDEX IF EXISTS picked_clips_sweep_idx;
DROP TABLE IF EXISTS picked_clips;

DROP TABLE IF EXISTS generation_batch_quotes;

DROP INDEX IF EXISTS generation_quotes_user_idx;
DROP TABLE IF EXISTS generation_quotes;

-- ── READ FIRST: columns on a live table ──────────────────────────────────
-- Check whether anything was ever written before dropping. A non-zero count
-- means a job carried a queue position a user was shown, and dropping it
-- deletes that record rather than un-creating an unused column:
--
--   SELECT count(*) FILTER (WHERE queue_position IS NOT NULL) AS positions,
--          count(*) FILTER (WHERE eta_seconds    IS NOT NULL) AS etas
--   FROM video_jobs;
--
-- Both zero, these are safe:
-- ALTER TABLE video_jobs DROP COLUMN IF EXISTS eta_seconds;
-- ALTER TABLE video_jobs DROP COLUMN IF EXISTS queue_position;
--
-- Left COMMENTED deliberately. A rollback that silently drops live columns is
-- the kind of script that runs at 2am and is discovered the following week.

-- ROLLBACK for add-inflight-index.sql.
--
-- Safe and complete: the index is additive and nothing depends on it. The
-- query that uses it falls back to idx_video_jobs_status_updated, which is
-- what it used before — slower under load, never wrong.
--
-- CONCURRENTLY here too, for the same reason: a plain DROP INDEX takes an
-- ACCESS EXCLUSIVE lock on video_jobs.
DROP INDEX CONCURRENTLY IF EXISTS idx_video_jobs_inflight_by_user;

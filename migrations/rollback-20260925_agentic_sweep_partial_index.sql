-- Rollback. CONCURRENTLY here too: a plain DROP INDEX takes ACCESS EXCLUSIVE
-- on video_jobs, which on a live table is the outage the CONCURRENTLY build
-- was avoiding in the first place.
DROP INDEX CONCURRENTLY IF EXISTS idx_video_jobs_agentic_inflight;

-- Phase D ask-back persistence. server.js parks a clarifying question on the job
-- row (status='needs_input', ask=<payload>) and clears it on resume (ask=null), and
-- GET /api/video-jobs/:id returns it so a reloaded client can re-render the ask card.
--
-- The column was never migrated, so EVERY reference 400s: the status endpoint 500'd
-- for all jobs (masked because the app polls via SSE) and ask-back park/resume
-- errored. JSONB nullable to match the payload shape (AskPayload) written by server.js.
--
-- Until this lands, server.js references are migration-guarded[ask] (fallbacks that
-- drop the column); remove those guards in a follow-up once this is confirmed live.

ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS ask JSONB;

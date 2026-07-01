-- Phase D ask-back: durable "Lumen has a question" state on the render job.
--
-- The worker parks a Lumen job at status='needs_input' and writes the ask
-- payload to `ask`; the frontend reads it via the poll and clears it on
-- answer/skip. `partial_state` holds the worker's mid-pipeline state so it can
-- resume from where it paused (worker-internal — the app only reads/clears ask).
--
-- CRITICAL: PostgREST silently drops reads/writes to unknown columns (no error),
-- so without these columns the ask never surfaces and the job sits at
-- needs_input invisibly. Apply this before enabling ASK_BACK on the worker.
--
-- Idempotent — safe to re-run.

ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS ask jsonb;
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS partial_state jsonb;

COMMENT ON COLUMN video_jobs.ask IS
  'Phase D ask-back: {ask_id, prompt, answer_kinds[], optional, context, choices?}. Set with status=needs_input; cleared on answer/skip.';
COMMENT ON COLUMN video_jobs.partial_state IS
  'Phase D ask-back: worker mid-pipeline state to resume from on answer. Worker-internal.';

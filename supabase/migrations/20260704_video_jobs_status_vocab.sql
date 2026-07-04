-- Expand video_jobs.valid_status to the FULL app + worker (v191) vocabulary.
--
-- BLOCKER this fixes: the prior CHECK constraint allowed only
--   (queued, processing, completed, failed)
-- so every value the worker's durable write_job_status emits — 'complete',
-- 'canceled', 'needs_input' — was REJECTED by Postgres. Because that function
-- patches status + result + phase in ONE atomic UPDATE, a rejected status also
-- dropped `result` (vocab/floor/enhancements_dropped) and `phase` — i.e. the
-- worker's "rich terminal state" could never land, no matter what the app did.
-- It also rejected the app's cancel status ('cancelled'), so Cancel Render was
-- silently failing (the row stayed 'processing', the worker never saw the
-- cancel, the render ran to completion).
--
-- Both the worker vocab (complete/canceled/needs_input) AND the app/client vocab
-- (completed/cancelled/needs_clarification) are allowed so first-terminal-wins
-- works across both sides without either having to change its spelling. Apply
-- BEFORE (or with) the paired app deploy — the app's terminal writes and the
-- worker's terminal writes both depend on it. Idempotent.

alter table public.video_jobs drop constraint if exists valid_status;
alter table public.video_jobs drop constraint if exists video_jobs_status_check;

alter table public.video_jobs
  add constraint valid_status check (
    status in (
      'queued',
      'processing',
      'completed',
      'complete',
      'failed',
      'error',
      'canceled',
      'cancelled',
      'needs_input',
      'needs_clarification'
    )
  );

-- Canonicalize video_jobs.status to ONE vocabulary (Step 3.1 input).
--
-- Ratified canonical set (Zac, Step 2 — amend in the handoff to change):
--   queued, processing, completed, failed, canceled, needs_input
-- American 'canceled'; 'needs_input' for the ask-back rail; NO both-spellings
-- constraint, NO IN('complete','completed') tax in future queries.
--
-- Why this is needed (Step 1 reconciliation, status_vocab_table.md):
--   * prior valid_status allowed only (queued,processing,completed,failed) —
--     PROVEN against prod. It bounced the worker's 'complete'/'needs_input' and
--     the app's 'cancelled'. write_job_status patches status+phase+result
--     atomically, so a bounced status also dropped result/phase.
--   * app + worker spellings had drifted (complete vs completed; cancelled vs
--     canceled). This normalizes existing rows AND pins the constraint.
--
-- OWNERSHIP: the WORKER session applies this (it owns the schema-probe history);
-- this file is the frontend's prepared input. Apply with a live-schema read-back
-- (constraints get silently mis-stated just like columns). Sequenced BEFORE the
-- app merge of 7b30150 and any worker vocab alignment. Idempotent.

-- 1) Drop the old constraint (either name it may carry) so normalization + the
--    new constraint can proceed.
alter table public.video_jobs drop constraint if exists valid_status;
alter table public.video_jobs drop constraint if exists video_jobs_status_check;

-- 2) Normalize any legacy/non-canonical rows to the canonical spelling.
update public.video_jobs set status = 'completed' where status = 'complete';
update public.video_jobs set status = 'canceled'  where status = 'cancelled';
-- ('needs_clarification' is never a durable status — the app persists 'failed'
--  for that path and carries the question in error_message/change_summary.)

-- 3) Pin the canonical constraint.
alter table public.video_jobs
  add constraint valid_status check (
    status in ('queued', 'processing', 'completed', 'failed', 'canceled', 'needs_input')
  );

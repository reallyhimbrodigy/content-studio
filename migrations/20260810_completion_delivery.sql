-- completion_delivery (lane/delivery 2026-08-10)
--
-- WHICH mechanism delivered each job's terminal settlement to the dispatcher:
--   'callback'       — worker's /api/modal-complete POST (primary, instant)
--   'webhook'        — Modal platform webhook
--   'durable_poll'   — dispatcher's early poll of the worker's durable row
--   'fallback_timer' — the 15-min registerPendingModalJob timeout
--   'reconciler'     — re-spawn evaluation projected the completion from Supabase
--   'orphan_callback'— POST landed on a process not awaiting the job (deploy orphan)
--   'sync'           — non-spawn inline response (legacy path)
--
-- The 41-jobs-at-the-900s-wall class was invisible for weeks because a
-- fallback settlement was indistinguishable from a normal completion. The
-- column is written first-stamp-wins (guarded .is null) by dispatch-to-modal
-- and the orphan handler; code ships before this migration and soft-fails the
-- write until the column exists (persistModalCallId pattern).
--
-- Scoreboard query:
--   select completion_delivery, count(*) from video_jobs
--   where status in ('completed','failed') and created_at > now() - interval '1 day'
--   group by 1;
alter table video_jobs add column if not exists completion_delivery text;

-- worker_started_at: the "worker actually ran" signal. started_at stamps the
-- dispatch ATTEMPT (poisoning every completion denominator — a job that never
-- reached a worker still carries started_at). The worker stamps this itself via
-- write_job_status at pipeline start. NULL = no worker ever picked the job up.
alter table video_jobs add column if not exists worker_started_at timestamptz;

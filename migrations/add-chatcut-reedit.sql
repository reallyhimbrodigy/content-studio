-- THE CHATCUT RE-EDIT PATH: identity, serialization, and a cap that is not a
-- constant.
--
-- ── 1. THE VIDEO'S IDENTITY IS THE CHATCUT PROJECT, NOT parent_job_id ──────
-- A re-edit today is a new video_jobs row with parent_job_id pointing at the
-- edit it revises. That makes parent_job_id the IMMEDIATE PARENT and not the
-- video — and MEASURED on production, re-edit chains already run FOUR DEEP:
--
--     120 re-edits, 103 distinct parents, max chain depth 4
--
-- So "one in-flight re-edit per video" cannot be keyed on parent_job_id: two
-- re-edits at different generations of the SAME video have different parents
-- and would both be admitted. The ChatCut project is the thing that spans the
-- chain, which is exactly why it has to be stored.
--
-- WRITTEN ONCE, AT THE FIRST EDIT, AND INHERITED. Every re-edit of that video
-- copies it from its parent rather than creating a project of its own —
-- re-editing in a NEW project would lose the timeline the user is revising,
-- which is the whole point of the path.
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS chatcut_project_id uuid;

-- The chat/thread the edit was conducted in, if ChatCut exposes one.
--
-- I HAVE NOT CONFIRMED THAT IT DOES. The column is nullable text rather than
-- uuid for that reason: if the id turns out to be a uuid a text column still
-- holds it, and if it turns out not to exist the column stays NULL and costs
-- nothing. Typing it uuid on a guess would make the first non-uuid id an
-- insert error on a live path. Builder 1 owns that surface and can say.
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS chatcut_thread_id text;

-- The read path is "every re-edit of this video", newest first.
CREATE INDEX IF NOT EXISTS video_jobs_chatcut_project_idx
  ON video_jobs (chatcut_project_id, created_at DESC)
  WHERE chatcut_project_id IS NOT NULL;

-- ── 2. SERIALIZATION IS A CONSTRAINT, NOT A CHECK-THEN-INSERT ─────────────
-- At most ONE in-flight re-edit per video. A partial unique index does it in
-- the write: two concurrent requests both attempt the insert and exactly one
-- succeeds, the other takes a duplicate-key error. A SELECT-then-INSERT would
-- admit both — both read "none in flight", both insert — which is the same
-- TOCTOU shape as a balance check and costs a render instead of credits.
--
-- SCOPED THREE WAYS, and each clause is load-bearing:
--   chatcut_project_id IS NOT NULL  a job with no project is not on this path
--   parent_job_id IS NOT NULL       the FIRST edit is not a re-edit, and two
--                                   first edits of different videos in one
--                                   project must never collide
--   status NOT IN (terminals)       finished work does not block new work.
--                                   The terminal set is the ratified one from
--                                   server.js TERMINAL_JOB_STATUSES_SQL; if
--                                   that list ever grows, this index must grow
--                                   with it or completed jobs start blocking.
--
-- IT CONSTRAINS ONLY ROWS THAT CARRY A PROJECT ID, so every existing row is
-- unaffected and this is forward-looking by construction. Nothing in the
-- 12,869-row history is validated or rewritten.
CREATE UNIQUE INDEX IF NOT EXISTS video_jobs_one_inflight_reedit_per_project
  ON video_jobs (chatcut_project_id)
  WHERE chatcut_project_id IS NOT NULL
    AND parent_job_id IS NOT NULL
    AND status NOT IN ('completed', 'failed', 'canceled', 'needs_input');

-- ── 3. THE CAP IS CONFIG, NOT A CONSTANT ──────────────────────────────────
-- server_flags already answers "is this on, and for whom". A cap is a NUMBER,
-- which it has no room for — so it gains a `value` jsonb rather than a second
-- mechanism growing up beside it. One place to look for "what is configured",
-- and lib/upload-flags.js's DB-first-env-fallback read already covers it.
--
-- jsonb rather than integer because the next config value will not be an
-- integer, and a column per type is how a config table becomes a schema.
ALTER TABLE server_flags ADD COLUMN IF NOT EXISTS value jsonb;

-- Ten free re-edits per video, then a normal edit's price. Seeded to the
-- default so applying this changes nothing; Zac's ruling replaces the number
-- with a SQL update and no deploy.
INSERT INTO server_flags (flag, allowlist, percent, enabled_all, value, note) VALUES
  ('reedit_free_cap', '{}'::uuid[], 0, true,
   '{"per_video": 10}'::jsonb,
   'Free re-edits per video for Pro/Max before a re-edit costs a normal '
   'edit. enabled_all=true because the cap applies to everyone on the paid '
   'path; the NUMBER is in value, not in the flag. Free tier never reaches '
   'this — it is 402 pro_required before the cap is consulted.')
ON CONFLICT (flag) DO NOTHING;

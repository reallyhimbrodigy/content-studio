-- Re-edit support: persist the full "project file" so re-edits can re-render
-- deterministically from the original source, preserving every prior decision
-- byte-for-byte, or surgically modifying a single aspect via the plan-diff path.
--
-- edit_recipe is already persisted. This migration adds the remaining pieces
-- the worker needs to reproduce a render without re-running Gemini / Deepgram /
-- Pexels search: the transcript, the cached visual analysis, the chosen
-- B-roll assets (Pexels IDs + file URLs), and a snapshot of the trend profile
-- in force at render time.
--
-- render_version lets future pipeline revisions evolve the schema without
-- breaking existing saved plans.
--
-- All columns are nullable so existing rows remain valid. Re-edit flows fall
-- back to 'reinterpret' mode when these are missing on a legacy job.

ALTER TABLE video_jobs
  ADD COLUMN IF NOT EXISTS transcript JSONB,
  ADD COLUMN IF NOT EXISTS analysis_data JSONB,
  ADD COLUMN IF NOT EXISTS resolved_broll JSONB,
  ADD COLUMN IF NOT EXISTS trend_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS render_version INTEGER,
  ADD COLUMN IF NOT EXISTS parent_job_id UUID REFERENCES video_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reedit_mode TEXT,
  ADD COLUMN IF NOT EXISTS change_request TEXT,
  ADD COLUMN IF NOT EXISTS change_summary TEXT;

CREATE INDEX IF NOT EXISTS idx_video_jobs_parent_job_id ON video_jobs(parent_job_id);

COMMENT ON COLUMN video_jobs.transcript IS 'Deepgram ASR output (words w/ timestamps); persisted so re-edits skip re-transcription';
COMMENT ON COLUMN video_jobs.analysis_data IS 'Cached Gemini visual analysis; persisted so re-edits skip re-analysis';
COMMENT ON COLUMN video_jobs.resolved_broll IS 'Chosen Pexels assets keyed to edit_recipe.broll_clips entries; enables byte-identical B-roll on re-render';
COMMENT ON COLUMN video_jobs.trend_snapshot IS 'Snapshot of trend_profiles row at render time; tweak mode re-edits replay with this snapshot for fidelity';
COMMENT ON COLUMN video_jobs.render_version IS 'Pipeline version tag; bump when editPlan schema evolves in a non-backwards-compatible way';
COMMENT ON COLUMN video_jobs.parent_job_id IS 'For re-edits, points to the original job this was derived from';
COMMENT ON COLUMN video_jobs.reedit_mode IS 'For re-edits: tweak | reinterpret';
COMMENT ON COLUMN video_jobs.change_request IS 'The user-supplied change request for a re-edit (null for originals)';
COMMENT ON COLUMN video_jobs.change_summary IS 'One-line summary of what the plan-diff changed, shown in the UI';

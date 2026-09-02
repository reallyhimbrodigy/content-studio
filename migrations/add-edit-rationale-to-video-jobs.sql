-- Zero-rejection edit rationale (2026-07-24). The worker persists a 1–2 sentence
-- plain-language rationale for each finished edit (incl. the honest "this clip
-- was short, so a lighter edit" line). Nullable + additive: the worker's write
-- no-ops safely until this column exists, and the iOS result-view display stays
-- staged for the routing batch. No backfill, no default — old rows read NULL.
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS edit_rationale TEXT;

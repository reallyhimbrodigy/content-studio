-- §5 progressive playback: the worker's Phase-B preview payload.
--
-- CORRECTED TYPE (2026-07-26): the worker's _persist_preview writes a JSONB payload
-- here — {preview_hls_url, segments_published, plan_summary, first_frame_url} — in the
-- SAME update that sets hls_manifest_url to the preview manifest. The first version of
-- this migration created `preview BOOLEAN` (a wrong inference); writing the JSONB
-- object to a boolean column throws, the whole update fails (the worker is fail-open),
-- and hls_manifest_url never receives the preview → NO preview for any job. Type MUST
-- be JSONB. If the boolean version was already applied, the DROP below fixes it (the
-- column is unused — all-null/false — so no data is lost).
--
-- Worker-owned column (frontend owns the migration; the client reads the resulting
-- hls_manifest_url, not this column). Nullable; nothing on the server writes it.

ALTER TABLE video_jobs DROP COLUMN IF EXISTS preview;          -- drop the wrong (boolean) type if present
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS preview JSONB; -- correct type

-- §5 progressive playback marker. A job gets a partial HLS preview only when its
-- dispatch carried supports_progressive (a 1.3.3+ client capability) AND the global
-- kill switch is on. This column records that a preview was published for the job —
-- the analytics/state parallel to `demo`, so we can measure preview coverage without
-- inferring it.
--
-- The capability itself flows to the worker via the Modal dispatch payload
-- (dispatch-to-modal.js: supports_progressive), NOT this column — so server.js does
-- not reference `preview`. This is the WORKER's column to write.
--
-- BACKEND: confirm this name + type match your intent before Zac runs it. Boolean by
-- analogy to `demo`; change to TEXT/JSONB if the worker instead stores preview
-- metadata here.

ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS preview BOOLEAN NOT NULL DEFAULT false;

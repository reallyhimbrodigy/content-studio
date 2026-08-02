-- ── A job may not be 'completed' without a deliverable URL ──────────────────
--
-- WHY (2026-08-02): 10 users had a finished video they never received. Rows sat
-- at status='completed' with a full success envelope in `result` — video_url,
-- hls_manifest_url, thumbnail_url — and EVERY delivery column NULL. The client
-- reads the columns, so they got nothing, and nothing counted it.
--
-- Two different paths produced the same row shape:
--   * 9 of 10 — the completion tail never ran. It only executes when an
--     in-process await resolves, and that await lives in a plain Map
--     (lib/video-processor/modal-webhook.js:1). A deploy or restart drops every
--     in-flight entry while the worker's own durable write has already set
--     status='completed'. None of these 9 fired a double-loss event, which
--     confirms onTimeoutCheck never ran either — the process was gone.
--   * 1 of 10 (476fe663) — the double-loss fallback DID fire and logged
--     "recovered fully from Supabase", yet the columns stayed NULL. It verified
--     the ROW, not the DELIVERY.
--
-- Fixing either path leaves the other. This trigger makes the shape itself
-- impossible, whichever writer is at fault and whichever path we add next.
--
-- REPAIR, NOT REJECT. A hard CHECK constraint would make the worker's terminal
-- write FAIL, turning a delivered-but-unprojected video into a dead job — a
-- strictly worse outcome. Instead the trigger PROJECTS from `result` at write
-- time (the data is already there), and only if `result` holds no URL at all
-- does it refuse the transition, because "completed with nothing to play" is
-- never a truthful row.
--
-- Idempotent: safe to re-run.

CREATE OR REPLACE FUNCTION video_jobs_completed_requires_delivery()
RETURNS TRIGGER AS $$
DECLARE
  res_url  TEXT;
  res_hls  TEXT;
  res_thumb TEXT;
BEGIN
  IF NEW.status IS DISTINCT FROM 'completed' THEN
    RETURN NEW;
  END IF;
  IF NEW.rendered_video_url IS NOT NULL OR NEW.result_url IS NOT NULL THEN
    RETURN NEW;                                    -- already deliverable
  END IF;

  res_url := COALESCE(
    NEW.result->>'video_url',
    NEW.result->>'public_url',
    NEW.result->>'rendered_video_url'
  );

  IF res_url IS NULL THEN
    -- Nothing to hand over. Refusing the transition keeps the row honest: a
    -- 'completed' job with no playable asset is a lie the client cannot detect.
    RAISE EXCEPTION
      'video_jobs %: refusing status=completed with no deliverable URL in columns or result',
      NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Project what the tail would have written. Deterministic and additive.
  NEW.rendered_video_url := res_url;
  res_hls   := NEW.result->>'hls_manifest_url';
  res_thumb := NEW.result->>'thumbnail_url';
  IF NEW.hls_manifest_url IS NULL AND res_hls   IS NOT NULL THEN NEW.hls_manifest_url := res_hls;   END IF;
  IF NEW.thumbnail_url    IS NULL AND res_thumb IS NOT NULL THEN NEW.thumbnail_url    := res_thumb; END IF;
  IF NEW.completed_at IS NULL THEN NEW.completed_at := NOW(); END IF;

  RAISE WARNING
    'video_jobs %: projected delivery columns from result at write time — the completion tail did not run',
    NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_video_jobs_completed_requires_delivery ON video_jobs;
CREATE TRIGGER trg_video_jobs_completed_requires_delivery
  BEFORE INSERT OR UPDATE OF status, result, rendered_video_url ON video_jobs
  FOR EACH ROW
  EXECUTE FUNCTION video_jobs_completed_requires_delivery();

-- Verify (expect 0 after this ships):
--   SELECT count(*) FROM video_jobs
--    WHERE status = 'completed' AND rendered_video_url IS NULL AND result_url IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- DELIVERY-LOSS: paste-and-run in the Supabase SQL editor (Zac).
-- Speed agent is blocked from prod DB writes by the auto-mode classifier
-- (no psql, no DATABASE_URL, no SUPABASE_ACCESS_TOKEN in this env). Everything
-- here is idempotent and safe to re-run.
--
-- Runs in three parts:
--   1. THE TRIGGER — makes the no-delivery row shape IMPOSSIBLE going forward
--      (projects from result{} at write time; refuses completed only when result
--      holds no URL at all). This is migrations/completed-requires-delivery-url.sql.
--   2. THE BACKFILL — fixes the rows already stuck. Reconciled against the live
--      DB: exactly 3 completed rows have a real render (result.video_url) with a
--      NULL rendered_video_url. (Zac's estimate was 9; the other ~6 have NO
--      result.video_url — a genuine no-render, not projectable; they need
--      re-dispatch, tracked separately.)
--   3. VERIFY — expect 0.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── PART 1: THE TRIGGER (full content of completed-requires-delivery-url.sql) ──
\i migrations/completed-requires-delivery-url.sql
-- If \i is unavailable in your client, open that file and paste its body here.

-- ── PART 2: BACKFILL the already-stuck rows (Zac's original SQL; touches 3) ──
UPDATE video_jobs
   SET rendered_video_url = result->>'video_url',
       hls_manifest_url   = result->>'hls_manifest_url',
       thumbnail_url      = result->>'thumbnail_url',
       completed_at       = COALESCE(completed_at, updated_at)
 WHERE status = 'completed'
   AND rendered_video_url IS NULL
   AND result->>'video_url' IS NOT NULL;
-- Expect: UPDATE 3
--   a21fc782-539c-4b88-81d9-d30492e1cc2c  (user 12e5ee7b)  2026-07-17
--   6c8abce6-b846-4bd3-9375-b2eba964bb2c  (user 0d017cc5)  2026-07-17
--   401e9317-bd32-4bb0-bfd0-0cec93bd8b24  (user b0a3918a)  2026-07-21

-- ── PART 3: VERIFY (expect 0) ──
SELECT count(*) AS still_broken
  FROM video_jobs
 WHERE status = 'completed'
   AND rendered_video_url IS NULL
   AND result->>'video_url' IS NOT NULL;

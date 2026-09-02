-- Sample-clip demo (1.3.3 §4). Marks a render as the first-run demo on the
-- pre-hosted official sample clip — NOT a user's own footage.
--
-- A demo job is:
--   • quota-exempt  — it never decrements the daily free-render cap (watching the
--                     demo must not cost the user their one free render), and it's
--                     concurrency-exempt (never blocks the user's own upload).
--   • activation-invisible — excluded from the funnel activation lines + error
--                     budget; the scripts/funnel-report.js [REPORT] counts it on a
--                     SEPARATE demo line so real-footage metrics stay honest.
--
-- The exemption is safe by construction: the server honors demo:true ONLY when the
-- request's source URL equals the configured SAMPLE_DEMO_SOURCE_URL (a user cannot
-- pass their own clip as a demo), plus a per-user daily demo cap.
--
-- NOT NULL DEFAULT false backfills every existing row to false, so inFlightJobCount
-- and the funnel — which filter on demo=false — are correct the instant this lands.

ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS demo BOOLEAN NOT NULL DEFAULT false;

-- Partial index: the only demo-scoped reads are "this user's demo jobs today"
-- (the daily demo cap) and the funnel's demo counter. Tiny, since demo rows are
-- rare relative to real renders.
CREATE INDEX IF NOT EXISTS video_jobs_demo_idx
  ON video_jobs (user_id, created_at DESC) WHERE demo = true;

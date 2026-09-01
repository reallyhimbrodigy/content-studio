-- video_jobs.credits_debited + credits_refunded_at — the credits refund claim.
--
-- NOT A LEDGER. Balance is authoritative at RevenueCat (ruling 4); these two
-- columns exist only so a refund can be exactly-once and can know the amount:
--
--   credits_debited     the RECEIPT — how much this job actually spent, so the
--                       refund does not have to guess. NULL = never debited
--                       (re-edit, demo, or credits disabled), which is why the
--                       refund leg can skip on NULL rather than assuming 10.
--   credits_refunded_at the CLAIM — flipped NULL -> now() atomically, so only
--                       the winning pass calls RevenueCat. RC documents no
--                       idempotency key on the transactions endpoint, so
--                       exactly-once has to come from here.
--
-- Additive, idempotent, zero-risk. Nullable; the server writes them best-effort
-- after the fact. Apply BEFORE or AFTER the deploy — order does not matter.
-- Safe to re-run.

ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS credits_debited integer;
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS credits_refunded_at timestamptz;

-- The refund sweep selects unclaimed debited failures; this index keeps that
-- scan off a seq scan as video_jobs grows.
CREATE INDEX IF NOT EXISTS idx_video_jobs_credits_unrefunded
  ON video_jobs (credits_refunded_at)
  WHERE credits_debited IS NOT NULL AND credits_refunded_at IS NULL;

-- Verify after applying:
--   SELECT count(*) FILTER (WHERE credits_debited IS NOT NULL) AS debited,
--          count(*) FILTER (WHERE credits_refunded_at IS NOT NULL) AS refunded
--     FROM video_jobs WHERE created_at > now() - interval '1 day';

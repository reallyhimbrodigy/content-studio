-- THE GENERATION AND BATCH CONTRACT — schema. NOT APPLIED BY BUILDER 2.
--
-- Supabase is READ-ONLY for me: no writes, no migrations. This file is the
-- exact change the contract needs, written so whoever can apply it does not
-- have to re-derive it. Until it is applied, lib/generation-quotes.js is pure
-- logic with no persistence and the endpoints stay dark.
--
-- WHAT IS *NOT* HERE, AND WHY. No balance column and no reservations table.
-- RevenueCat holds the balance and VALIDATES IT ATOMICALLY — an insufficient
-- balance returns 422 and deducts NOTHING — so "read, compare, debit" is the
-- TOCTOU race and attempting the debit IS the atomic reservation. Mirroring
-- the balance here would create a second source of truth for money, which is
-- the one place two numbers with the same name must never exist.
--
-- WHAT RC CANNOT DO IS EXACTLY-ONCE: it documents no idempotency key on that
-- endpoint. So the claim marker is ours, and it is the whole point of the
-- quotes table below.

CREATE TABLE IF NOT EXISTS generation_quotes (
  quote_id      uuid PRIMARY KEY,
  user_id       uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('image','ai_video','voiceover','music','sfx')),
  model         text,
  resolution    text,
  duration_s    numeric,
  -- credits IS RE-DERIVED FROM THE ROW ABOVE AT CONFIRM TIME and compared to
  -- this. They disagree only if the price table moved under a live quote,
  -- which is a requote, not a charge.
  credits       integer NOT NULL CHECK (credits >= 0),
  label         text NOT NULL,
  expires_at    timestamptz NOT NULL,
  -- THE CLAIM MARKER. A confirm claims the quote by moving state; a second
  -- confirm finds it already claimed and returns the FIRST result. This is
  -- what makes a double-tap a no-op, because RC will not do it for us.
  state         text NOT NULL DEFAULT 'open'
                CHECK (state IN ('open','claimed','settled','refunded','expired')),
  claimed_at    timestamptz,
  job_id        uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS generation_quotes_user_idx ON generation_quotes (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS generation_batch_quotes (
  batch_quote_id uuid PRIMARY KEY,
  user_id        uuid NOT NULL,
  clip_ids       uuid[] NOT NULL,
  kind           text NOT NULL,
  model          text, resolution text, duration_s numeric,
  credits_each   integer NOT NULL CHECK (credits_each >= 0),
  expires_at     timestamptz NOT NULL,
  state          text NOT NULL DEFAULT 'open',
  confirmed_count integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Section 6, the speed rule: a clip is registered the instant it is picked so
-- the import into ChatCut starts before the user finishes typing.
CREATE TABLE IF NOT EXISTS picked_clips (
  clip_id     uuid PRIMARY KEY,
  user_id     uuid NOT NULL,
  upload_key  text NOT NULL,
  duration_s  numeric,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- Unused picks are discarded after 30 minutes. A sweep, not a trigger: a
-- delete that runs on write would race the send that is about to use it.
CREATE INDEX IF NOT EXISTS picked_clips_sweep_idx ON picked_clips (created_at)
  WHERE used_at IS NULL;

-- Section 5, the queue. Nullable on purpose: eta_seconds is NULL below 20
-- completed samples and the client shows the position only. A default of 0
-- would read as "starting now", which is the absence-as-a-value defect in the
-- field most likely to be believed.
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS queue_position integer;
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS eta_seconds integer;

-- THE CLAIM, ATOMIC, IN ONE STATEMENT. Two concurrent confirms of the same
-- quote: exactly one moves it out of 'open' and gets a row back; the other
-- gets nothing and returns the first result. The guard is IN the write, which
-- is the only place it is safe.
--   UPDATE generation_quotes
--      SET state = 'claimed', claimed_at = now()
--    WHERE quote_id = $1 AND user_id = $2 AND state = 'open'
--      AND expires_at > now()
--   RETURNING credits, kind, model, resolution, duration_s;

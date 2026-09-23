-- THE GENERATION AND BATCH CONTRACT — schema.
--
-- APPLIED 2026-09-23 BY ZAC. This file was rewritten from the LIVE DATABASE
-- afterwards (pg_class / pg_attribute / pg_constraint / pg_indexes), not from
-- the version I proposed plus a list of amendments. A migration file is a
-- claim about the database, and a claim assembled from a diff is exactly the
-- kind that is plausible and wrong — so the source here is the database
-- itself, read back column by column.
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
-- quotes tables below.
--
-- RLS IS ON AND THERE ARE ZERO POLICIES, DELIBERATELY. That combination means
-- "service role only": every anon and authenticated read is denied by default
-- and the server reaches these tables with the service key. It is the safe
-- direction to be wrong in — a missing policy denies, it does not leak — and
-- it is asserted rather than assumed by __smoke_generation_schema.js.

CREATE TABLE IF NOT EXISTS generation_quotes (
  quote_id      uuid PRIMARY KEY,
  -- REFERENCES auth.users ON DELETE CASCADE, per the usage_events /
  -- device_tokens convention: account deletion has to reach every table that
  -- names a user, and a table that opts out of the convention is the one that
  -- keeps rows after the account is gone.
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
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
  -- charged_at IS THE CRASH MATRIX'S ONLY WITNESS. Without it, "claimed with
  -- no job" is one state covering two opposite facts — money not taken, and
  -- money taken with nothing to show — and the repair for one is the exact
  -- wrong move for the other. It is set in the same statement that records
  -- RC's success, so a row can be claimed-and-uncharged but never
  -- charged-without-a-claim.
  charged_at    timestamptz,
  job_id        uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS generation_quotes_user_idx
  ON generation_quotes (user_id, created_at DESC);
ALTER TABLE generation_quotes ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS generation_batch_quotes (
  batch_quote_id uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  clip_ids       uuid[] NOT NULL,
  -- NOTE, AND IT IS A REAL DIVERGENCE RATHER THAN AN OVERSIGHT TO TIDY: this
  -- `kind` carries NO CHECK, while generation_quotes.kind does. That is what
  -- is applied, and this file matches what is applied. The server validates
  -- kind through priceFor() on both paths — an unknown kind is
  -- 'unknown_kind', never a charge — so the constraint is belt to the
  -- server's braces here and not the only thing standing between a typo and a
  -- row. Recorded so the next reader does not "fix" the file away from the
  -- database.
  kind           text NOT NULL,
  model          text, resolution text, duration_s numeric,
  credits_each   integer NOT NULL CHECK (credits_each >= 0),
  expires_at     timestamptz NOT NULL,
  state          text NOT NULL DEFAULT 'open'
                 CHECK (state IN ('open','claimed','settled','refunded','expired')),
  confirmed_count integer,
  charged_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS generation_batch_quotes_user_idx
  ON generation_batch_quotes (user_id, created_at DESC);
ALTER TABLE generation_batch_quotes ENABLE ROW LEVEL SECURITY;

-- Section 6, the speed rule: a clip is registered the instant it is picked so
-- the import into ChatCut starts before the user finishes typing.
CREATE TABLE IF NOT EXISTS picked_clips (
  clip_id     uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  upload_key  text NOT NULL,
  duration_s  numeric,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- IDEMPOTENT ON upload_key (ruled 2026-09-23). The same key returns the
  -- SAME clip_id with a 200 and starts no second import. The uniqueness has
  -- to be in the CONSTRAINT rather than in a check-then-insert: two taps
  -- arriving together both find no row and both import, which is the same
  -- TOCTOU shape as a balance check and costs an upload instead of credits.
  --
  --   INSERT INTO picked_clips (clip_id, user_id, upload_key, duration_s)
  --   VALUES ($1, $2, $3, $4)
  --   ON CONFLICT (user_id, upload_key) DO UPDATE SET upload_key = EXCLUDED.upload_key
  --   RETURNING clip_id, (xmax = 0) AS inserted;
  --
  -- DO UPDATE rather than DO NOTHING, because DO NOTHING returns no row and
  -- the caller cannot tell "already exists" from "insert failed" — the second
  -- would then read as a fresh pick. `inserted` says which happened, so the
  -- import fires exactly once.
  UNIQUE (user_id, upload_key)
);
-- Unused picks are discarded after 30 minutes. A sweep, not a trigger: a
-- delete that runs on write would race the send that is about to use it.
CREATE INDEX IF NOT EXISTS picked_clips_sweep_idx ON picked_clips (created_at)
  WHERE used_at IS NULL;
ALTER TABLE picked_clips ENABLE ROW LEVEL SECURITY;

-- Section 5, the queue. Nullable on purpose: eta_seconds is NULL below 20
-- completed samples and the client shows the position only. A default of 0
-- would read as "starting now", which is the absence-as-a-value defect in the
-- field most likely to be believed.
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS queue_position integer;
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS eta_seconds integer;

-- ── THE FOUR STATEMENTS THE SERVER RUNS ──────────────────────────────────
--
-- 1. THE CLAIM, ATOMIC, IN ONE STATEMENT. Two concurrent confirms of the same
--    quote: exactly one moves it out of 'open' and gets a row back; the other
--    gets nothing and returns the first result. The guard is IN the write,
--    which is the only place it is safe.
--   UPDATE generation_quotes
--      SET state = 'claimed', claimed_at = now()
--    WHERE quote_id = $1 AND user_id = $2 AND state = 'open'
--      AND expires_at > now()
--   RETURNING credits, kind, model, resolution, duration_s;
--
-- 2. THE CHARGE IS RECORDED BEFORE THE JOB EXISTS. charged_at and job_id are
--    written in two statements because they happen at two times, and
--    collapsing them would erase the only state that says "paid, not built".
--   UPDATE generation_quotes SET charged_at = now()
--    WHERE quote_id = $1 AND charged_at IS NULL;
--
-- 3. THE JOB IS ATTACHED, AND ONLY THEN IS THE QUOTE SETTLED.
--   UPDATE generation_quotes SET job_id = $2, state = 'settled'
--    WHERE quote_id = $1 AND state = 'claimed';
--
-- 4. THE RELEASE, FOR AN RC 422. Back to 'open' so the confirm after a top-up
--    succeeds — a claim that cannot be released is a quote the user can never
--    spend and can never be refunded, because nothing was taken.
--   UPDATE generation_quotes SET state = 'open', claimed_at = NULL
--    WHERE quote_id = $1 AND state = 'claimed' AND charged_at IS NULL;

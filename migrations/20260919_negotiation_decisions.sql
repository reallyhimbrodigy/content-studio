-- D4 shadow table — what the negotiation classifier WOULD have done.
--
-- ADDITIVE ONLY. Creates one table; alters nothing, drops nothing, and no
-- existing read or write path touches it. Safe to apply while the server runs.
--
-- THE BRIEF TEXT IS NEVER STORED. Only a hash, so a decision can be traced back
-- to a request without this table becoming a second copy of user content — and
-- so an unsafe brief is never persisted here (standing law: unsafe text is not
-- stored). Everything needed for the 24-hour read is a column; nothing that
-- would make this table worth exfiltrating is.

CREATE TABLE IF NOT EXISTS public.negotiation_decisions (
  id            bigserial PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- sha256 of the brief, hex. NOT the brief.
  request_hash  text        NOT NULL,
  client_job_id text,

  -- the decision
  verdict       text        NOT NULL CHECK (verdict IN ('PASS','NEGOTIATE','REFUSE')),
  classes       text[]      NOT NULL DEFAULT '{}',   -- out-of-scope tags
  sentence      text,                                -- what the user WOULD have seen

  -- the safety leg, and WHO decided
  safety_state  text        NOT NULL CHECK (safety_state IN ('MEASURED','REVIEW_UNAVAILABLE')),
  decider       text        CHECK (decider IN ('regex','model')),
  uncertain     boolean     NOT NULL DEFAULT false,
  degraded      boolean     NOT NULL DEFAULT false,  -- the model leg was unavailable

  language      text,                                -- the brief's language
  flag_state    text        NOT NULL CHECK (flag_state IN ('DARK','ON'))
);

-- the read is by day, by class, by language
CREATE INDEX IF NOT EXISTS negotiation_decisions_created_idx  ON public.negotiation_decisions (created_at DESC);
CREATE INDEX IF NOT EXISTS negotiation_decisions_verdict_idx  ON public.negotiation_decisions (verdict, created_at DESC);
CREATE INDEX IF NOT EXISTS negotiation_decisions_language_idx ON public.negotiation_decisions (language);

-- DENY ALL, then nothing. RLS on with no permissive policy means anon and
-- authenticated cannot read or write; the service role bypasses RLS and is the
-- only writer. Stated explicitly rather than left to the default, because a
-- table created without RLS is readable by every signed-in user.
ALTER TABLE public.negotiation_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.negotiation_decisions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.negotiation_decisions FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.negotiation_decisions_id_seq FROM anon, authenticated;

COMMENT ON TABLE public.negotiation_decisions IS
  'D4 dark-mode shadow log: what the negotiation classifier would have done. Never stores brief text. Service-role insert only; RLS denies all others.';

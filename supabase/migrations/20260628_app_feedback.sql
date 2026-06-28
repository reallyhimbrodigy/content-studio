-- In-app feedback table
-- One row per feedback submission from an iOS user. Body is { rating, text,
-- job_id, app_version }; user_id is taken from the auth token, never trusted
-- from the client. The server (service role) is the sole gateway — RLS is
-- enabled with NO client policies, mirroring the creator_submissions pattern,
-- so anon/auth clients cannot read or forge rows.

CREATE TABLE IF NOT EXISTS app_feedback (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rating        TEXT        CHECK (rating IN ('up', 'down')),  -- nullable (text-only feedback)
  text          TEXT,
  job_id        TEXT,            -- which render, when available
  app_version   TEXT
);

CREATE INDEX IF NOT EXISTS app_feedback_created_at_idx
  ON app_feedback (created_at DESC);

ALTER TABLE app_feedback ENABLE ROW LEVEL SECURITY;
-- No policies: service-role server endpoints are the sole gateway. Enabling RLS
-- with no policies means anon/auth clients can neither read nor write directly.

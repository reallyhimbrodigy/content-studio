-- Creator submission portal migration
-- One row per UGC creator submission. Videos are stored on S3/CloudFront; the
-- jsonb `videos` column holds the per-file manifest. The server (service role)
-- is the sole gateway — RLS is enabled with NO client policies, mirroring the
-- usage_events pattern, so anon/auth clients cannot read or forge rows.

CREATE TABLE IF NOT EXISTS creator_submissions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  creator_name  TEXT        NOT NULL,
  creator_email TEXT,
  notes         TEXT,
  videos        JSONB       NOT NULL DEFAULT '[]',  -- [{ url, key, filename, size, content_type }]
  status        TEXT        NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'approved', 'needs_changes')),
  review_notes  TEXT
);

CREATE INDEX IF NOT EXISTS creator_submissions_created_at_idx
  ON creator_submissions (created_at DESC);

ALTER TABLE creator_submissions ENABLE ROW LEVEL SECURITY;
-- No policies: service-role server endpoints are the sole gateway. Enabling RLS
-- with no policies means anon/auth clients can neither read nor write directly.

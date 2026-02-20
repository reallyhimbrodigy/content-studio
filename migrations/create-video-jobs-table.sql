-- Video jobs table for asynchronous processing
CREATE TABLE IF NOT EXISTS video_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Job request
  status TEXT NOT NULL DEFAULT 'queued',
  video_url TEXT NOT NULL,
  vibe_input TEXT NOT NULL,

  -- Progress
  progress INTEGER NOT NULL DEFAULT 0,
  current_step TEXT,

  -- Result / errors
  result_url TEXT,
  error_message TEXT,

  -- Optional metadata
  content_type TEXT,
  vibe_params JSONB,
  edit_recipe JSONB,

  -- Lifecycle timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  CONSTRAINT video_jobs_status_check CHECK (status IN ('queued', 'processing', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_video_jobs_user_id ON video_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs(status);
CREATE INDEX IF NOT EXISTS idx_video_jobs_created_at ON video_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_jobs_status_created_at ON video_jobs(status, created_at);

ALTER TABLE video_jobs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'video_jobs'
      AND policyname = 'Users can view own video jobs'
  ) THEN
    CREATE POLICY "Users can view own video jobs"
      ON video_jobs
      FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'video_jobs'
      AND policyname = 'Users can create own video jobs'
  ) THEN
    CREATE POLICY "Users can create own video jobs"
      ON video_jobs
      FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'video_jobs'
      AND policyname = 'Users can update own video jobs'
  ) THEN
    CREATE POLICY "Users can update own video jobs"
      ON video_jobs
      FOR UPDATE
      USING (auth.uid() = user_id);
  END IF;
END$$;

CREATE OR REPLACE FUNCTION update_video_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_video_jobs_updated_at ON video_jobs;
CREATE TRIGGER trg_video_jobs_updated_at
BEFORE UPDATE ON video_jobs
FOR EACH ROW
EXECUTE FUNCTION update_video_jobs_updated_at();

COMMENT ON TABLE video_jobs IS 'Queue table for background AI video edit jobs';


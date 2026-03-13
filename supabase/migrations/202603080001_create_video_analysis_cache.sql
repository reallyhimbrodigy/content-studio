CREATE TABLE IF NOT EXISTS video_analysis_cache (
  video_url TEXT PRIMARY KEY,
  analysis JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

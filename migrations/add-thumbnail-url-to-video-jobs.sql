-- Add thumbnail_url column to video_jobs for storing the worker-uploaded thumbnail
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;

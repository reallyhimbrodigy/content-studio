-- Create tables required by brand brain preferences and feature usage tracking
CREATE TABLE IF NOT EXISTS public.brand_brain_preferences (
  user_id uuid PRIMARY KEY,
  preferences text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.feature_usage (
  user_id uuid NOT NULL,
  feature_key text NOT NULL,
  count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feature_key)
);

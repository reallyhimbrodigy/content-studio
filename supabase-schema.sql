-- Supabase Database Schema for Promptly

-- Users table (leverages Supabase auth.users)
-- We'll store additional user metadata in a public.profiles table
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID REFERENCES auth.users(id) PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro')),
  profile_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS profile_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Enable Row Level Security
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;

-- Policies: Users can only read/update their own profile
CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);

-- Calendars table
CREATE TABLE IF NOT EXISTS public.calendars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  niche_style TEXT NOT NULL,
  posts JSONB NOT NULL DEFAULT '[]'::jsonb,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE public.calendars ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can view own calendars" ON public.calendars;
DROP POLICY IF EXISTS "Users can insert own calendars" ON public.calendars;
DROP POLICY IF EXISTS "Users can update own calendars" ON public.calendars;
DROP POLICY IF EXISTS "Users can delete own calendars" ON public.calendars;

-- Policies: Users can only access their own calendars
CREATE POLICY "Users can view own calendars"
  ON public.calendars FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own calendars"
  ON public.calendars FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own calendars"
  ON public.calendars FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own calendars"
  ON public.calendars FOR DELETE
  USING (auth.uid() = user_id);

-- Function to automatically create profile on user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, tier)
  VALUES (NEW.id, NEW.email, 'free');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to create profile on signup
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_calendars_user_id ON public.calendars(user_id);
CREATE INDEX IF NOT EXISTS idx_calendars_saved_at ON public.calendars(saved_at DESC);

-- Design assets table
CREATE TABLE IF NOT EXISTS public.design_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  calendar_day_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('post_graphic')),
  placid_template_id TEXT NOT NULL,
  placid_render_id TEXT,
  cloudinary_public_id TEXT,
  status TEXT NOT NULL DEFAULT 'rendering' CHECK (status IN ('draft','rendering','ready','failed')),
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Helper to keep updated_at in sync
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_design_assets_updated ON public.design_assets;
CREATE TRIGGER on_design_assets_updated
  BEFORE UPDATE ON public.design_assets
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.design_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own design assets" ON public.design_assets;
DROP POLICY IF EXISTS "Users can insert own design assets" ON public.design_assets;
DROP POLICY IF EXISTS "Users can update own design assets" ON public.design_assets;
DROP POLICY IF EXISTS "Users can delete own design assets" ON public.design_assets;

CREATE POLICY "Users can view own design assets"
  ON public.design_assets FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own design assets"
  ON public.design_assets FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own design assets"
  ON public.design_assets FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own design assets"
  ON public.design_assets FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_design_assets_user_id ON public.design_assets(user_id);
CREATE INDEX IF NOT EXISTS idx_design_assets_calendar_day ON public.design_assets(calendar_day_id);

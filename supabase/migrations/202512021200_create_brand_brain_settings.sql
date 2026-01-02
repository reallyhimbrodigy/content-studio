CREATE TABLE IF NOT EXISTS public.brand_brain_settings (
  user_id uuid primary key,
  enabled boolean not null default false,
  preset text not null default 'direct_response',
  audience text,
  offer text,
  primary_cta text not null default 'comment',
  risk_level integer not null default 45,
  levers jsonb not null default '{"stronger_hooks":true,"shorter_captions":true,"engagement_loops":true,"retention_beats":true,"cta_variety":true}',
  updated_at timestamptz default now()
);

ALTER TABLE public.brand_brain_settings
  ADD CONSTRAINT brand_brain_settings_risk_level_range
  CHECK (risk_level >= 0 AND risk_level <= 100);

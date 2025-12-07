-- Allow only story and carousel asset types now that post_graphic is removed.
-- Rebuild the check constraint on design_assets.type to match.

ALTER TABLE public.design_assets
  DROP CONSTRAINT IF EXISTS design_assets_type_check;

ALTER TABLE public.design_assets
  ADD CONSTRAINT design_assets_type_check
  CHECK (type IN ('story', 'carousel'));

ALTER TABLE public.design_assets
  ALTER COLUMN type SET NOT NULL,
  ALTER COLUMN type SET DEFAULT 'story';

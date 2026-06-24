-- Entitlement hardening: admin comp flag + lock entitlement columns to the
-- server (service role) so authenticated clients can't self-grant Pro.
--
-- Background: profiles_update_own (20260125_fix_profiles_rls.sql) lets an
-- authenticated user UPDATE their own row with NO column restriction. Because
-- the app ships the Supabase URL + anon key, a user could take their own JWT
-- and PATCH /rest/v1/profiles to set tier='pro' / pro_until=<future> and grant
-- themselves free Pro. lib/entitlement.js isUserPro() fails closed on a bare
-- tier='pro', but it still honors a client-set future pro_until — so the hole
-- is real. This migration closes it at the data layer and adds a trustworthy
-- admin-comp signal that the entitlement logic keys on.

-- 1) Explicit admin comp flag. Service-role / SQL-editor only (enforced by the
--    trigger below). isUserPro() treats comp_pro=true as Pro on its own.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS comp_pro BOOLEAN NOT NULL DEFAULT false;

-- 2) Block the PostgREST client roles (authenticated / anon) from modifying any
--    entitlement column. Everyone else — service_role (server + RevenueCat
--    webhook + /api/revenuecat/sync) and postgres (SQL editor / migrations) —
--    may write them freely. SECURITY INVOKER (the default) is required so
--    current_user reflects the request's role, not the function owner.
CREATE OR REPLACE FUNCTION public.protect_entitlement_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF NEW.tier           IS DISTINCT FROM OLD.tier
    OR NEW.pro_until      IS DISTINCT FROM OLD.pro_until
    OR NEW.rc_app_user_id IS DISTINCT FROM OLD.rc_app_user_id
    OR NEW.rc_product_id  IS DISTINCT FROM OLD.rc_product_id
    OR NEW.rc_period_type IS DISTINCT FROM OLD.rc_period_type
    OR NEW.comp_pro       IS DISTINCT FROM OLD.comp_pro
    THEN
      RAISE EXCEPTION
        'entitlement columns (tier, pro_until, rc_*, comp_pro) are managed server-side and cannot be modified by clients'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_entitlement_columns_trg ON public.profiles;
CREATE TRIGGER protect_entitlement_columns_trg
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_entitlement_columns();

-- To comp an account (internal staff / support), run as the service role
-- (Supabase SQL editor or dashboard):
--   update public.profiles set tier='pro', comp_pro=true where id='<user-uuid>';
-- To revoke: set comp_pro=false (and tier='free' if no real subscription).

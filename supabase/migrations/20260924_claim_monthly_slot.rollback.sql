-- Rollback for 20260924_claim_monthly_slot.sql.
-- With the functions gone, claimMonthlyUsage() sees PGRST202 and FAILS CLOSED
-- (503), it does not fall back to an unlimited free tier. So dropping these
-- stops free renders on builds < 247 rather than un-capping them — which is
-- the safe direction, but it is a user-visible outage for that cohort, not a
-- quiet revert. Set FREE_MONTHLY_CAP_ENABLED=0 to disable the cap instead.
drop function if exists public.release_monthly_slot(uuid, text);
drop function if exists public.claim_monthly_slot(uuid, text, int);

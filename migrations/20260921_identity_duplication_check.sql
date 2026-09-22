-- IDENTITY DUPLICATION CHECK. APPLIED 2026-09-21.
--
-- Second-device sign-in depends on Supabase's automatic email linking: a Google
-- identity carrying a verified email that already has an account attaches to
-- THAT account rather than minting a second one. Measured 2026-09-21: 0 emails
-- on 2+ accounts across 20,544, and 28 users holding multiple identities
-- (9 of them email+google — exactly the shape in question).
--
-- That is proven for the population, not guaranteed by anything we control. If
-- the setting is changed the failure is SILENT: no error, no 4xx, nothing to
-- alert on. A user quietly ends up with two accounts and discovers it when
-- their videos are missing. This makes the invariant a number that moves.
--
-- COUNTS ONLY, NEVER ADDRESSES. The caller needs to know THAT duplication
-- exists, not who — returning emails would put user addresses into logs and
-- health payloads for a check that does not need them.
--
-- PostgREST cannot reach the auth schema, hence an RPC rather than a query.
-- SECURITY DEFINER with a pinned search_path; execute granted to service_role
-- only, revoked from anon and authenticated.

CREATE OR REPLACE FUNCTION public.identity_duplication_check()
RETURNS TABLE(duplicate_emails int, worst_count int, users_with_email int)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  WITH d AS (
    SELECT lower(email) AS e, count(*) AS c
    FROM auth.users
    WHERE email IS NOT NULL AND email <> ''
    GROUP BY 1
    HAVING count(*) > 1
  )
  SELECT (SELECT count(*) FROM d)::int,
         COALESCE((SELECT max(c) FROM d), 0)::int,
         (SELECT count(*) FROM auth.users WHERE email IS NOT NULL AND email <> '')::int;
$$;

REVOKE ALL ON FUNCTION public.identity_duplication_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.identity_duplication_check() TO service_role;

-- Read at boot + hourly by server.js (runIdentityDuplicationCheck), surfaced on
-- /api/health as identityDuplication, and an [ALERT] line when it is non-zero.

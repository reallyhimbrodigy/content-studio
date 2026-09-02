-- Sandbox isolation for revenue reporting (2026-07-27).
--
-- RevenueCat tags every subscriber event with its store environment
-- ('SANDBOX' | 'PRODUCTION'). We grant Pro identically either way — a
-- sandbox/TestFlight tester MUST receive Pro in-app to test Pro features — but
-- a sandbox subscription must NOT count as a real paid conversion in reporting
-- (funnel-report activePaid, the [REPORT] buy line, the bleed-meter commerce
-- line, PostHog). Without a marker on the profile, a sandbox purchase is
-- indistinguishable from a real one and fires "first paid conversion".
--
-- This column is DERIVED state: "environment of the entitlement CURRENTLY
-- granting Pro". The webhook rewrites it on every applied event, so a later
-- PRODUCTION purchase supersedes an earlier SANDBOX one (a tester's own account
-- counts again after they test). The immutable per-event record lives in
-- analytics_events.props.environment. NULL = legacy/comp/production (only an
-- explicit 'SANDBOX' is ever excluded).
--
-- server.js references this defensively (writes it only when present; falls
-- back to a plain write if the column is absent), so it is safe to deploy the
-- server before or after this migration is applied.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS rc_environment TEXT;

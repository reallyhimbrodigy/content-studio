-- Index for the monthly claim counter. SEPARATE FILE because CREATE INDEX
-- CONCURRENTLY CANNOT RUN INSIDE A TRANSACTION BLOCK, and 20260924_claim_
-- monthly_slot.sql defines functions that want one. Run this one on its own,
-- outside any transaction (psql without -1, or the SQL editor as a single
-- statement).
--
-- claim_monthly_slot reads (user_id, kind, created_at >= month start) once per
-- free render on a build below 247. Without this the count filters every event
-- the user has ever logged; with it, one index read.

-- The claim counter is read once per free render on a caller-less build, always
-- for (user_id, kind, created_at >= month start). usage_events has an index on
-- user_id; this makes the whole predicate one index read instead of a filter
-- over every event the user has ever logged.
create index concurrently if not exists idx_usage_events_user_kind_created
  on public.usage_events (user_id, kind, created_at desc);

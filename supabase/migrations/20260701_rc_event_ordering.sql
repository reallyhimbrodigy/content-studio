-- RevenueCat webhook event-ordering guard (billing gap #2).
--
-- Records the timestamp of the last RevenueCat event applied to each profile so
-- the webhook can drop a STALE or DUPLICATE event (delivered late / out of
-- order) instead of letting it clobber a fresher state — e.g. a delayed
-- BILLING_ISSUE (with a past expiration) overwriting a just-processed RENEWAL
-- and wrongly dropping a paying user to free. The webhook applies an update
-- only when event_timestamp_ms > rc_last_event_ms (or it's null).
--
-- Apply BEFORE deploying the paired server.js change. Idempotent.

alter table public.profiles
  add column if not exists rc_last_event_ms bigint;

comment on column public.profiles.rc_last_event_ms is
  'RevenueCat: event_timestamp_ms of the last webhook event applied to this row. Webhook ignores events older-or-equal (stale/duplicate ordering guard).';

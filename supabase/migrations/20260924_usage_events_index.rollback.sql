-- Rollback for 20260924_usage_events_index.sql. Also outside a transaction.
drop index concurrently if exists public.idx_usage_events_user_kind_created;

-- Rollback for 20260924_ops_alert_fires.sql. Fires keep reaching the
-- [ops-fire] log line and /healthz?ops_fires=1; only durability is lost.
drop table if exists public.ops_alert_fires;

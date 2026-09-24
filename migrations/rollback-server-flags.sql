-- ROLLBACK for add-server-flags.sql.
--
-- SAFE AND COMPLETE, unlike the generation-quotes rollback: this table is new,
-- nothing else references it, and lib/upload-flags.js falls back to env when
-- the table is absent. Dropping it does not turn any flag off — it returns
-- every resolution to the env fallback, which is where they were before.
--
-- The one thing to know before running it: any rollout state that lives ONLY
-- here (a percentage someone raised) is lost, and the env values take over.
-- Read the rows first if the current percentages matter:
--
--   SELECT flag, allowlist, percent, enabled_all, note FROM server_flags;

DROP TABLE IF EXISTS server_flags;

-- ROLLBACK for add-chatcut-reedit.sql.
--
-- THE ORDER IS THE OPPOSITE OF THE MIGRATION'S, and the index must go FIRST.
-- Dropping the column while the partial unique index still references it
-- would fail; dropping the index first leaves the column harmlessly present
-- if you decide to stop halfway.
--
-- THE INDEX IS ALWAYS SAFE TO DROP. It constrains nothing that existed before
-- this migration, and dropping it only re-admits concurrent re-edits — the
-- behaviour before the change.

DROP INDEX IF EXISTS video_jobs_one_inflight_reedit_per_project;
DROP INDEX IF EXISTS video_jobs_chatcut_project_idx;

-- ── READ FIRST: two columns on a live table ───────────────────────────────
-- video_jobs carries 12,869 rows of production history. If any re-edit has
-- run, chatcut_project_id is the ONLY record of which ChatCut project a
-- video's timeline lives in, and dropping it makes every one of those
-- timelines unreachable from our side. That is not recoverable from a backup
-- of this table alone, because the id lives nowhere else.
--
--   SELECT count(*) FILTER (WHERE chatcut_project_id IS NOT NULL) AS with_project,
--          count(*) FILTER (WHERE chatcut_thread_id  IS NOT NULL) AS with_thread
--   FROM video_jobs;
--
-- Both zero, these are safe:
-- ALTER TABLE video_jobs DROP COLUMN IF EXISTS chatcut_thread_id;
-- ALTER TABLE video_jobs DROP COLUMN IF EXISTS chatcut_project_id;
--
-- Left COMMENTED deliberately, same rule as the queue columns: a rollback
-- that silently drops live columns is the script that runs at 2am and is
-- found the following week.

-- ── The cap row and its column ────────────────────────────────────────────
-- Deleting the row returns the cap to the code default. Dropping the COLUMN
-- discards every other config value that has since been stored in it, so it
-- is commented for the same reason as above.
DELETE FROM server_flags WHERE flag = 'reedit_free_cap';
-- ALTER TABLE server_flags DROP COLUMN IF EXISTS value;

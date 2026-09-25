-- Rollback: restore the five-minute full-scan sweep.
-- The watermark column is LEFT IN PLACE — dropping it loses the record of
-- what has been scanned, and an unused column costs nothing.
select cron.alter_job(2, schedule => '*/5 * * * *');
-- Then re-apply the previous function body from the 2026-09-25 snapshot in
-- this commit message; it is not reproduced here because a rollback that
-- pastes a stale body is how the wrong version comes back.

-- ROLLBACK for add-annual-credit-periods.sql.
--
-- SAFE, AND THE THING TO UNDERSTAND BEFORE RUNNING IT: this table is the
-- IDEMPOTENCY RECORD for real credit grants. Dropping it does not take any
-- credits back — those live in RevenueCat — it destroys the memory of which
-- periods were already granted.
--
-- SO THE ORDER MATTERS. Disable the roll FIRST, then drop the table. Dropping
-- it while the roll is live means the next sweep sees no rows, decides every
-- period is ungranted, and GRANTS THEM ALL AGAIN. That is the one way this
-- rollback can cost money, and it is the reason this comment is longer than
-- the statement.
--
--   1. set ANNUAL_CREDIT_ROLL_ENABLED=0 (or unset it) and REDEPLOY — an env
--      change is not live until a redeploy
--   2. confirm no sweep is running
--   3. then run the DROP below
--
-- Read the record first if you may want to reapply it; it is small and it is
-- the only copy:
--
--   SELECT user_id, period_start, amount, decided_by, granted_at
--   FROM annual_credit_periods ORDER BY user_id, period_start;

DROP INDEX IF EXISTS annual_credit_periods_audit_idx;
DROP TABLE IF EXISTS annual_credit_periods;

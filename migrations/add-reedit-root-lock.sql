-- ONE RE-EDIT AT A TIME, PER VIDEO — enforced by the database, not by a guard.
--
-- NOT YET APPLIED. This is the only piece of the re-edit versioning work that is
-- a production data migration, and it is held for the owner deliberately.
-- Everything else (root_job_id on the insert, the 409, /versions, the parked
-- clarification clear, the expiry sweep) ships as code and is inert without it.
--
-- ── WHY AN INDEX AND NOT A CHECK IN THE ROUTE ───────────────────────────────
-- The route already refuses a second re-edit with a 409, but a SELECT-then-
-- INSERT has a window, and we have been bitten by exactly this class before on
-- client_message_id. Two taps inside the window both read "nothing in flight"
-- and both insert. A partial unique index makes the second one impossible
-- rather than unlikely.
--
-- ── WHY IT CAN ONLY WORK NOW ────────────────────────────────────────────────
-- An index on root_job_id is worthless if root_job_id is absent at INSERT time.
-- It was: parent lineage used to be written in the deferred dispatch patch, so a
-- row existed as 'queued' with NULL lineage for a measured 0.21s (p50) to 0.63s
-- (max) — comfortably a double-tap. f322ce6 moved it onto the insert. THAT is
-- what makes this index able to fire at all; without it this file is decoration.
--
-- ── ORDERING: THIS RUNS LAST, AND IT WILL FAIL IF RUN EARLY ─────────────────
-- CREATE UNIQUE INDEX fails outright when existing rows already violate it, and
-- as of 2026-09-21 two roots do:
--     a8d9538c-0bfe-4f7c-97e3-6412fb24a196   2 rows, both needs_input
--     fdda063b-539f-4ee4-9469-757c2d23d54b   2 rows, both needs_input
-- Four rows, all one user, 426-503h old, all parked clarifications. They are
-- cleared by the expiry sweep (lib/clarification-sweep.js) or by their owner
-- answering. So the sequence is:
--     1. ship the delivery fix + a client build that can render the question
--     2. arm CLARIFICATION_EXPIRY_ENABLED
--     3. confirm the query at the bottom of this file returns ZERO rows
--     4. only then run this migration
-- Running it at step 0 does not degrade — it errors and changes nothing — but it
-- will read as "the migration is broken" rather than "the pre-step has not run".
--
-- ── WHY needs_input IS IN THE PREDICATE ─────────────────────────────────────
-- A parked question holds the video: if it did not, a user sitting on an
-- unanswered question could start a second render of the same video, which is
-- the case the rule exists to prevent. Answering does not wait for expiry — the
-- re-edit route clears the park in the same operation that creates the reply, so
-- a user who answers never meets this lock.

BEGIN;

-- CONCURRENTLY is deliberately NOT used: it cannot run inside a transaction, and
-- video_jobs is ~12,700 rows, so a plain build is milliseconds. Revisit past
-- ~1M rows.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_video_jobs_root_in_flight
  ON video_jobs (root_job_id)
  WHERE status IN ('queued', 'processing', 'needs_input');

COMMENT ON INDEX uniq_video_jobs_root_in_flight IS
  'One re-edit at a time per video. Scoped to root_job_id, not parent_job_id: two branches off different versions of the same video are still two renders of one video, and a per-parent check passes both. Kept in step with lib/reedit-versions.js ROOT_LOCK_STATUSES.';

COMMIT;

-- ── PRE-FLIGHT. Run this FIRST; it must return zero rows. ───────────────────
-- Any row here is a root that would make the CREATE above fail.
--
--   SELECT root_job_id, count(*) AS non_terminal, string_agg(status, ',') AS statuses
--   FROM video_jobs
--   WHERE status IN ('queued', 'processing', 'needs_input')
--   GROUP BY root_job_id
--   HAVING count(*) > 1;
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS uniq_video_jobs_root_in_flight;
-- Dropping it restores today's behaviour exactly: the route's 409 still refuses
-- the common case, and only the sub-second double-tap window reopens.

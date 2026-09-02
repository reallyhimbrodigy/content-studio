'use strict';

// Canonical terminal job statuses. The ratified durable set is
// completed / failed / canceled / needs_input (see TERMINAL_JOB_STATUSES_SQL in
// server.js). Legacy/variant spellings are normalized away in the DB, but are
// accepted here defensively so a terminal job is never mis-read as in-flight —
// marking a genuinely-finished job "final" is always safe; the reverse strands a
// client reconnecting onto a completed job.
const TERMINAL_JOB_STATUSES = new Set([
  'completed', 'failed', 'canceled', 'needs_input',
  'complete', 'cancelled', 'error', 'needs_clarification',
]);

function isTerminalJobStatus(status) {
  return !!status && TERMINAL_JOB_STATUSES.has(String(status).toLowerCase());
}

/**
 * Why did a completed-status patch match ZERO rows? (2026-08-11)
 *
 * The first-terminal-wins update returns no rows for three different reasons,
 * and treating them as one is what left the stuck-job class un-diagnosed:
 *
 *   'update_error'          the write FAILED. `data` is null exactly as it is
 *                           for a real zero-match, so without the error object
 *                           these are indistinguishable.
 *   'lost_race_benign'      a concurrent writer terminalized the row between
 *                           our read and our write. The guard working AS
 *                           DESIGNED. Counting it as a defect inflates the
 *                           class — the same per-job inflation that once made a
 *                           one-user bug read as an outage.
 *   'row_still_nonterminal' the row is STILL non-terminal. THE REAL DEFECT: the
 *                           render finished, the row will stick, and the
 *                           fallback timer will tell the user their completed
 *                           video failed.
 *
 * Pure so it can be asserted; the caller supplies the post-write re-read.
 */
function classifyLostTransition({ transitionErr = null, nowStatus = null } = {}) {
  if (transitionErr) return 'update_error';
  return isTerminalJobStatus(nowStatus) ? 'lost_race_benign' : 'row_still_nonterminal';
}

module.exports = { TERMINAL_JOB_STATUSES, isTerminalJobStatus, classifyLostTransition };

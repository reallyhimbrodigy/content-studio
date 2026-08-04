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

module.exports = { TERMINAL_JOB_STATUSES, isTerminalJobStatus };

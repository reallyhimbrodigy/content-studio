'use strict';

// Pure helpers for the cancel-render flow. Kept dependency-free so they can be
// unit-tested with `node --test` (no Supabase / network).

// Terminal statuses: a job in one of these is finished and must NOT be canceled
// or refunded (a completed render already spent the GPU; a failed/canceled one
// was already resolved). Canonical vocab (American 'canceled').
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled']);

// A job is cancellable iff it exists and isn't in a terminal state. The stage
// cutoff ("before the edit recipe") is enforced client-side by hiding the
// button; the worker's before-render check is the true compute-saving gate, so
// the server only needs to reject already-finished jobs here.
function isJobCancellable(job) {
  if (!job || typeof job !== 'object') return false;
  const status = String(job.status || '').toLowerCase();
  if (!status) return false; // malformed / no status -> treat as not cancellable
  return !TERMINAL_STATUSES.has(status);
}

// Whether a cancel should refund the daily render slot. Only refund when the job
// was actually cancellable (i.e. it hadn't completed) — a no-op cancel on a
// finished render must not hand back a slot.
function shouldRefundOnCancel(job) {
  return isJobCancellable(job);
}

module.exports = { TERMINAL_STATUSES, isJobCancellable, shouldRefundOnCancel };

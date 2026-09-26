'use strict';

// ── ONE CALLER SECRET, ONE RESOLVER, TWO CALLERS ────────────────────────────
//
// WHY THIS FILE EXISTS. Job 5af26805, 2026-09-26 07:43:59Z, routed correctly and
// then died on dispatch:
//
//   [agentic] dispatch failed — run_agentic 401: {"spawned":false,
//     "state":"REFUSED","auth":"REQUIRED",
//     "why":"this container carries a caller secret and the request sent none"}
//
// "THE REQUEST SENT NONE." Two calls go to the same ChatCut container:
// /account_status from the routing guard, which resolved the secret and sent the
// `x-promptly-secret` header, and /run_agentic from the dispatch, which sent
// `{'Content-Type': 'application/json'}` and nothing else. One authenticated, one
// anonymous, to the same host, for months.
//
// It was invisible because the guard runs FIRST and fails CLOSED: while the guard
// was broken every job fell back before the dispatch was ever reached, so the
// dispatch's missing header could not produce a symptom. Fixing the guard is what
// exposed it — the first job that got past the guard is the first job that ever
// tried to dispatch for real.
//
// THE RESOLUTION LIVES HERE SO THE TWO CANNOT DRIFT. Two copies of "which env var
// holds the caller secret" is how one of them gets updated and the other does not,
// and the failure mode is exactly what just happened: one call authenticates and
// its neighbour does not.
//
// PRECEDENCE, and it is deliberate (Zac's Option 1, 2026-09-25):
//   CHATCUT_ACCOUNT_STATUS_SECRET wins WHEN SET, so this can be rotated
//     independently of the shared worker secret on the day someone wants to.
//   MODAL_CALLBACK_SECRET is the fallback and is what actually rides today,
//     because the dedicated name is deliberately unset — both sides already hold
//     this value, and B1's gate compares against it.
// The name is misleading now that it serves the dispatch too, and it is kept
// rather than renamed: a rename means a coordinated env change on a live spend
// path hours before a demo, for no behaviour.
function callerSecret(env = process.env) {
  return (env.CHATCUT_ACCOUNT_STATUS_SECRET || env.MODAL_CALLBACK_SECRET || '').trim();
}

/**
 * The auth headers for a ChatCut call, merged into whatever else the caller sends.
 *
 * ABSENT RATHER THAN EMPTY when there is no secret. Sending
 * `x-promptly-secret: ''` would be a header that exists and matches nothing —
 * B1's gate reports "sent none" for an absent header and would report a mismatch
 * for an empty one, and those two diagnoses point at different people. An absent
 * header says "this server has no secret configured"; an empty one says "the value
 * is wrong", and only one of those is true.
 */
function authHeaders(env = process.env) {
  const s = callerSecret(env);
  return s ? { 'x-promptly-secret': s } : {};
}

module.exports = { callerSecret, authHeaders };

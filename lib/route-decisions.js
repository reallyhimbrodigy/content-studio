'use strict';
// THE LAST N ROUTING DECISIONS, IN MEMORY, READABLE WITH ONE CURL.
//
// Zac 2026-09-25: "Prove the 30 s flip with a job."
//
// ── WHY NOT A COLUMN ON video_jobs ───────────────────────────────────────
// Because a column I have not SEEN is a column that may not be there, and an
// INSERT naming a missing column fails the whole insert — which on this path
// means the job is never created. That is not a hypothetical: `server_flags`
// gained a `value jsonb` in migrations/add-chatcut-reedit.sql on 2026-09-23,
// the re-edit cap was written to read it, and the column is NOT on the table
// today. A migration in this repo is a REQUEST, not a fact.
//
// So the proof surface is a ring plus one log line, neither of which can fail
// a customer's job. When `video_jobs.routed_by` exists and I have read it back
// from the live schema, the decision moves onto the row and this stays as the
// cheap read.
//
// ── IDs ONLY ─────────────────────────────────────────────────────────────
// Same rule as verify-grants: this is an operator surface behind a query
// parameter, and it carries job id, user id and the decision. No email, no
// name, no balance, no price. A routing record does not need to know who
// somebody is to prove which way the switch sent them.
const RING_MAX = 50;
const _ring = [];

/** Record one decision. Never throws — a logger that can fail a job is a bug. */
function record(rec) {
  try {
    const r = {
      at: new Date().toISOString(),
      job: (rec && rec.jobId) || null,
      user: (rec && rec.userId) || null,
      pipeline: (rec && rec.pipeline) || null,   // what the row was given
      route: (rec && rec.route) || null,         // what the decision said
      reason: (rec && rec.reason) || null,
      stage: (rec && rec.stage) || null,         // 'ramp' | 'guard' | 'unarmed'
      source: (rec && rec.source) || null,       // allowlist | percent | all | off
      dbState: (rec && rec.dbState) || null,     // ok | unreadable | null
    };
    _ring.push(r);
    while (_ring.length > RING_MAX) _ring.shift();
    // ONE LINE, PRINTED IN THE SAME COMMIT THAT ADDS THE COUNTER. A ring nobody
    // can see from the logs answers nothing when the ring is a process away.
    console.log(`[chatcut-route] job=${r.job} user=${r.user} pipeline=${r.pipeline} `
      + `route=${r.route} reason=${r.reason} stage=${r.stage} source=${r.source} `
      + `db=${r.dbState}`);
    return r;
  } catch (_) { return null; }
}

function recent(n = 10) {
  const k = Math.max(1, Math.min(RING_MAX, Number(n) || 10));
  return _ring.slice(-k).reverse();
}

function _reset() { _ring.length = 0; }

module.exports = { record, recent, _reset, RING_MAX };

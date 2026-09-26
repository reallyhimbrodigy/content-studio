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
      // ── THE GUARD'S OWN EVIDENCE ──────────────────────────────────────
      //
      // ADDED 2026-09-26 AFTER IT COST A DIAGNOSIS. Job 7eb3df03 fell back with
      // reason=chatcut_unknown and nothing said why. fetchAccountStatus computes
      // exactly what happened — `http_404`, `no_url`, `error:…`, or `ok` — and
      // the call site threw it away with `(await fetchAccountStatus()).status`.
      // So a server that KNEW the status code logged "we could not find out",
      // and I had to curl the endpoint by hand to get a different answer than
      // the one the server actually got.
      //
      // `statusWhy` is the transport: did we reach it, and what did it answer.
      // `state` is the content: what it said about the account. They fail
      // independently — a 200 carrying REFUSED and a 502 carrying nothing are
      // different problems with different owners — and one field cannot say both.
      statusWhy: (rec && rec.statusWhy) || null,   // ok | http_NNN | no_url | error:…
      state: (rec && rec.state) || null,           // OK | LIVE | REFUSED | STALE | …
      // WHICH SHAPE THE BALANCE CAME FROM. Job 839bd13b read status_why=ok and
      // state=LIVE and STILL fell back, because the guard looked for the balance
      // at the top level and ChatCut publishes it at account.balance. Those two
      // fields said the transport and the account were both fine and could not
      // say that OUR PARSE was the problem. This one can.
      balancePath: (rec && rec.balancePath) || null,
    };
    _ring.push(r);
    while (_ring.length > RING_MAX) _ring.shift();
    // ONE LINE, PRINTED IN THE SAME COMMIT THAT ADDS THE COUNTER. A ring nobody
    // can see from the logs answers nothing when the ring is a process away.
    console.log(`[chatcut-route] job=${r.job} user=${r.user} pipeline=${r.pipeline} `
      + `route=${r.route} reason=${r.reason} stage=${r.stage} source=${r.source} `
      + `db=${r.dbState} status_why=${r.statusWhy} state=${r.state} `
      + `balance_path=${r.balancePath}`);
    return r;
  } catch (_) { return null; }
}

function recent(n = 10) {
  const k = Math.max(1, Math.min(RING_MAX, Number(n) || 10));
  return _ring.slice(-k).reverse();
}

function _reset() { _ring.length = 0; }

module.exports = { record, recent, _reset, RING_MAX };

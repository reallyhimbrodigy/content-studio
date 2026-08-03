'use strict';
// DISPATCH_UNREACHABLE has to say WHICH cause, or it stays unownable.
//
// 44 jobs / 29 users in 30 days (34 in the last 7) all carried the same detail:
// "dispatch threw: spawned job did not complete; reaper will terminalize".
// That string cannot distinguish two causes with opposite fixes:
//
//   NEVER_SPAWNED — Modal accepted the spawn, no container ever started.
//                   Platform/spawn side.
//   RAN_AND_LOST  — a worker ran, moved current_step/progress, and its
//                   completion never reached us. Delivery side.
//
// The worker owns current_step/progress and moves them off 'queued'/0 the
// moment it starts, and writes stage_timings/stage_manifest into result. Any of
// those is proof it ran.

const assert = require('assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test';

function db(row, { throws = false } = {}) {
  return {
    from() {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => (throws
          ? Promise.reject(new Error('pg down'))
          : Promise.resolve({ data: row, error: null })),
      };
      if (throws) { b.select = () => { throw new Error('pg down'); }; }
      return b;
    },
  };
}

const { workerProgressWitness } = require('./video-processor/dispatch-to-modal');

(async () => {
  // ── NEVER_SPAWNED: the row is exactly as dispatch left it ────────────────
  let w = await workerProgressWitness(db({
    current_step: 'queued', progress: 0, result: {},
  }), 'j1');
  assert.strictEqual(w.verdict, 'NEVER_SPAWNED');
  assert.strictEqual(w.moved, false);

  w = await workerProgressWitness(db({
    current_step: 'Queued', progress: 0, result: null,
  }), 'j1b');
  assert.strictEqual(w.verdict, 'NEVER_SPAWNED', 'the capitalised form counts too');

  // ── RAN_AND_LOST: any one witness is enough ──────────────────────────────
  for (const row of [
    { current_step: 'render', progress: 0, result: {} },            // step moved
    { current_step: 'queued', progress: 42, result: {} },           // progress moved
    { current_step: 'queued', progress: 0, result: { stage_timings: {} } },
    { current_step: 'queued', progress: 0, result: { stage_manifest: {} } },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await workerProgressWitness(db(row), 'j2');
    assert.strictEqual(r.verdict, 'RAN_AND_LOST',
      `a worker that produced ${JSON.stringify(row)} demonstrably ran`);
    assert.strictEqual(r.moved, true);
  }

  // ── THE LOAD-BEARING CASE: unknown must never masquerade as a verdict ────
  // Guessing NEVER_SPAWNED on an unreadable row would send the fix to the
  // platform side on no evidence — the exact mistake that kept this unowned.
  w = await workerProgressWitness(db(null), 'j3');
  assert.strictEqual(w.moved, null, 'a missing row is UNKNOWN, not never-spawned');
  assert.strictEqual(w.verdict, undefined);
  assert.strictEqual(w.reason, 'row_unreadable');

  w = await workerProgressWitness(db(null, { throws: true }), 'j4');
  assert.strictEqual(w.moved, null, 'a db outage is UNKNOWN, not a verdict');
  assert.ok(/witness_failed/.test(w.reason));

  // ── the verdict must survive into the durable copy ───────────────────────
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'video-processor', 'dispatch-to-modal.js'), 'utf8');
  assert.ok(src.includes('[${_witness.verdict || _witness.reason}]'),
    'the verdict must be FRONT-LOADED in error_detail, ahead of the exception text');
  assert.ok(src.includes('spawn_verdict:'), 'the envelope must carry a queryable field');
  assert.ok(src.includes('worker_ran:'), 'and the boolean, so counts can be cut without parsing');

  console.log('[smoke] dispatch witness: ALL PASS (never-spawned vs ran-and-lost; unknown stays unknown)');
})().catch((e) => { console.error('[smoke] FAILED:', e && e.message); process.exit(1); });

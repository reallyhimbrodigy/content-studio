'use strict';
const assert = require('assert');

// Stub S3 (presign) before the module binds it.
const s3Path = require.resolve('../services/s3');
require.cache[s3Path] = { id: s3Path, filename: s3Path, loaded: true, exports: {
  createPresignedPutUrl: async (key) => `https://s3.test/${key}?sig=x`,
  getObjectBuffer: async () => { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; },
} };

// Drive the sweep through every collect state. Stubbed BEFORE agentic-dispatch
// binds it.
const collectPath = require.resolve('./agentic-collect');
const realCollect = require('./agentic-collect');
let _state = { state: 'RUNNING' };
require.cache[collectPath] = { id: collectPath, filename: collectPath, loaded: true, exports: {
  ...realCollect,
  collectAgenticResult: async () => {
    if (_state instanceof Error) throw _state;
    return _state;
  },
} };

const D = require('./agentic-dispatch');
const quiet = { log() {}, error() {} };
const entry = (o = {}) => ({ src_t0: 0, src_t1: 1, id: 'a1b2c3d4e5f6', ...o });

/** Mock PostgREST that APPLIES its filters, the way Postgres does. A mock that
 *  discards them scores the bug as correct — nine smokes in this repo carried
 *  that defect and __smoke_mock_filters_gate.js now refuses new ones. */
function mockDb(rows) {
  const calls = { updates: [], guards: [] };
  const store = JSON.parse(JSON.stringify(rows));
  return { calls, store, from() {
    const f = {}; const nots = []; const gtes = []; let upd = null;
    const b = {
      select: (...a) => {
        if (!upd) return b;
        calls.updates.push({ patch: upd, id: f.id });
        const row = store.find((r) => r.id === f.id);
        const TERM = ['completed', 'failed', 'canceled', 'needs_input'];
        const blocked = nots.some((n) => n.col === 'status' && n.op === 'in'
          && String(n.val).replace(/[()]/g, '').split(',').includes(String(row && row.status)));
        if (!row || blocked) return Promise.resolve({ data: [], error: null });
        Object.assign(row, upd);
        return Promise.resolve({ data: [{ id: row.id }], error: null });
      },
      eq: (k, v) => { f[k] = v; return b; },
      // The lookback window, APPLIED. Caught by __smoke_mock_filters_gate on
      // this file's first run — the gate written two commits ago doing its job
      // on its own author. A no-op gte would hand back rows the real query has
      // already excluded, which is how a sweep looks correct against a fixture
      // that agrees with it.
      gte: (col, val) => { gtes.push({ col, val }); return b; },
      // Recorded ONLY on an update chain. The sweep's SELECT also calls
      // .not('status','in',...), so a shared array cannot distinguish them —
      // and with one, deleting the UPDATE's guard still passed.
      not: (col, op, val) => { nots.push({ col, op, val }); if (upd) calls.guards.push([col, op, val]); return b; },
      update: (u) => { upd = u; return b; },
      limit: () => Promise.resolve({
        data: store.filter((r) => Object.entries(f).every(([k, v]) => r[k] === v)
          && nots.every((n) => !(n.col === 'status' && n.op === 'in'
            && String(n.val).replace(/[()]/g, '').split(',').includes(String(r.status))))
          && gtes.every((g) => r[g.col] === undefined || String(r[g.col]) >= String(g.val))),
        error: null,
      }),
    };
    return b;
  } };
}

(async () => {
  // ── DISPATCH ─────────────────────────────────────────────────────────────
  let sent = null;
  const okFetch = async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ spawned: true, call_id: 'c1', mode: 'edit' }) };
  };
  const r = await D.dispatchAgentic({
    baseUrl: 'https://agentic.test/', jobId: 'j1', sourceKey: 'k', srcUrl: 's',
    outUrl: 'o', outKey: 'ok', brief: 'b', log: quiet, fetchImpl: okFetch,
  });
  assert.strictEqual(r.spawned, true);
  assert.strictEqual(sent.url, 'https://agentic.test/run_agentic', 'trailing slash normalised');
  assert.ok(sent.body.result_url.includes('agentic-results/j1.json'),
    'THE DEPLOY-SURVIVABILITY FIELD: the worker must be handed a presigned PUT '
    + 'derived from the job id, or collection has nothing to read');
  assert.ok(!('mode' in sent.body),
    'MODE MUST NOT BE SENT. The worker derives it from prior_plan in exactly one '
    + 'place and refuses to read it from the body, because shouldDebit() is false '
    + 'for every re-edit variant — a caller-supplied mode lets the client decide '
    + 'whether it pays. Sending one hands that authority straight back.');
  assert.ok(!('prior_plan' in sent.body), 'no prior plan on a plain edit');

  // a re-edit carries the plan verbatim
  await D.dispatchAgentic({ baseUrl: 'https://a.test', jobId: 'j2', brief: 'b',
    priorPlan: [entry()], instruction: 'make it punchier', log: quiet, fetchImpl: okFetch });
  assert.strictEqual(sent.body.prior_plan.length, 1);
  assert.strictEqual(sent.body.instruction, 'make it punchier');
  assert.ok(!('mode' in sent.body),
    'AND NOT ON THE RE-EDIT EITHER. Asserting this only on the plain-edit call '
    + 'missed it: a mode added alongside prior_plan is exactly the shape that '
    + 'would appear, and shouldDebit() is false for every re-edit variant, so a '
    + 'caller-supplied mode decides whether the render is free.');

  // ── a bad prior plan REFUSES rather than silently downgrading ────────────
  for (const [what, bad] of [
    ['a handler recipe dict', { cuts: [] }],
    ['an empty list', []],
    ['a list of wrong dicts', [{ start: 0, end: 1 }]],
  ]) {
    await assert.rejects(
      () => D.dispatchAgentic({ baseUrl: 'https://a.test', jobId: 'j3', brief: 'b',
        priorPlan: bad, log: quiet, fetchImpl: okFetch }),
      /prior_plan is not a plan/,
      `must refuse ${what} — dispatching it as a plain edit instead would be a `
      + 'fresh edit wearing a re-edit name, counted as one and charged as neither');
  }

  // a non-spawned response is a failure, not a success with no call id
  await assert.rejects(() => D.dispatchAgentic({
    baseUrl: 'https://a.test', jobId: 'j4', brief: 'b', log: quiet,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }),
  }), /DISPATCH_FAILED|run_agentic/, 'a 200 without spawned:true is not a spawn');

  // ── SWEEP ────────────────────────────────────────────────────────────────
  // Dark: nothing carries pipeline='agentic', so the sweep does zero work.
  const darkDb = mockDb([{ id: 'h1', user_id: 'u', status: 'processing', pipeline: 'handler' }]);
  assert.deepStrictEqual(await D.sweepAgentic(darkDb, { log: quiet }),
    { scanned: 0, done: 0, failed: 0, running: 0, unreadable: 0 },
    'DARK BY STRUCTURE: the sweep selects on pipeline, so with the route off it '
    + 'finds nothing — inert because there is nothing to find, not because a '
    + 'flag was checked');

  // an already-terminal row is never revisited
  const termDb = mockDb([{ id: 'a1', user_id: 'u', status: 'completed', pipeline: 'agentic' }]);
  assert.strictEqual((await D.sweepAgentic(termDb, { log: quiet })).scanned, 0,
    'the select excludes terminal rows');

  // ── the sweep's terminal handling, state by state ────────────────────────
  const live = () => mockDb([
    { id: 'a1', user_id: 'u', status: 'processing', pipeline: 'agentic',
      created_at: new Date().toISOString() },
    // DECOY outside the lookback. Without a row the window excludes, widening
    // the window could not change the answer and the gte would be untestable no
    // matter how faithfully the mock applied it — that was the bleed_meter
    // finding, and this is it not being repeated.
    { id: 'old1', user_id: 'u', status: 'processing', pipeline: 'agentic',
      created_at: '2020-01-01T00:00:00.000Z' },
  ]);

  // RUNNING leaves the row alone entirely
  _state = { state: 'RUNNING' };
  let db = live();
  let out = await D.sweepAgentic(db, { log: quiet });
  assert.strictEqual(out.running, 1);
  assert.strictEqual(db.calls.updates.length, 0, 'a running edit takes ZERO writes');

  // DONE puts the plan in its OWN column and completes
  _state = { state: 'DONE', plan: [entry()], planEntries: 1, result: { plan: [entry()], video_url: 'v' } };
  db = live();
  out = await D.sweepAgentic(db, { log: quiet });
  assert.strictEqual(out.done, 1);
  const patch = db.calls.updates[0].patch;
  assert.strictEqual(patch.status, 'completed');
  assert.ok(Array.isArray(patch.agentic_plan), 'the plan is a LIST in agentic_plan');
  assert.ok(!('edit_recipe' in patch),
    'THE TRAP: the plan must NEVER be written to edit_recipe. handler reads that '
    + 'column as a dict, and a list there resolves to mode tweak and dispatches a '
    + 'plan handler.py cannot read — legal values, no error, wrong edit.');
  assert.strictEqual(db.store[0].status, 'completed');

  // FAILED records the code AND whether it was a designed refusal
  _state = { state: 'FAILED', code: 'UNSUPPORTED', designedRefusal: true, message: 'no speech' };
  db = live();
  out = await D.sweepAgentic(db, { log: quiet });
  assert.strictEqual(out.failed, 1);
  assert.strictEqual(db.calls.updates[0].patch.result.error_code, 'UNSUPPORTED');
  assert.strictEqual(db.calls.updates[0].patch.result.designed_refusal, true,
    'a designed refusal bucketed as a real error is what made one clip read as '
    + 'an outage — the meter needs them separable at the row');

  // UNREADABLE is LOUD and NOT terminal
  _state = { state: 'UNREADABLE', reason: 'DONE but the plan is unusable: empty' };
  db = live();
  let alerted = 0;
  out = await D.sweepAgentic(db, { log: { log() {}, error(m) { if (/UNREADABLE/.test(m)) alerted += 1; } } });
  assert.strictEqual(out.unreadable, 1);
  assert.strictEqual(db.calls.updates.length, 0,
    'UNREADABLE must not terminalize: it is OUR failure to understand the result, '
    + 'not the worker reporting a failed edit, and burying it in `failed` hides a '
    + 'defect inside a bucket we expect to be non-empty');
  assert.ok(alerted >= 1, 'and it must be loud');
  assert.strictEqual(db.store[0].status, 'processing', 'the row is untouched');

  // a collect THROW (storage outage) leaves the row alone — unmeasurable is not failed
  _state = Object.assign(new Error('connection reset'), { name: 'NetworkingError' });
  db = live();
  out = await D.sweepAgentic(db, { log: quiet });
  assert.strictEqual(db.calls.updates.length, 0,
    'an S3 outage must not kill live renders');
  assert.strictEqual(db.store[0].status, 'processing');

  // THE ANTI-CLOBBER GUARD is taken on every terminal write
  _state = { state: 'DONE', plan: [entry()], planEntries: 1, result: {} };
  db = live();
  await D.sweepAgentic(db, { log: quiet });
  assert.ok(db.calls.guards.some(([c, o]) => c === 'status' && o === 'in'),
    'every terminal write carries .not(status,in,TERMINAL) — a later write must '
    + 'never overwrite a real cause with a vaguer one');

  console.log('[smoke] agentic dispatch: ALL PASS (result_url presigned per job; mode never '
    + 'sent; a bad prior plan refuses instead of downgrading; sweep dark by structure)');
})().catch((e) => { console.error('[smoke] FAILED:', e && e.message); process.exit(1); });

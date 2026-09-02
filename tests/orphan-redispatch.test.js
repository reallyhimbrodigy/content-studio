'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  sweepOrphanRedispatch, isRedispatchable, REDISPATCH_MIN_AGE_MS,
} = require('../lib/orphan-redispatch');

// Minimal chainable supabase-over-memory (mirrors the job-reaper test fake) + lt.
function makeFake(tables) {
  const state = { video_jobs: [...(tables.video_jobs || [])], usage_events: [...(tables.usage_events || [])] };
  function builder(table) {
    let op = 'select'; let patch = null; const filters = [];
    const b = {
      select() { return b; },
      update(o) { op = 'update'; patch = o; return b; },
      delete() { op = 'delete'; return b; },
      in(col, vals) { filters.push((r) => vals.includes(r[col])); return b; },
      eq(col, val) { filters.push((r) => r[col] === val); return b; },
      is(col, val) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      not(col, _op, val) { filters.push((r) => !(Array.isArray(val) ? val.includes(r[col]) : r[col] === val)); return b; },
      lt(col, val) { filters.push((r) => r[col] != null && r[col] < val); return b; },
      lte(col, val) { filters.push((r) => r[col] != null && r[col] <= val); return b; },
      gte(col, val) { filters.push((r) => r[col] != null && r[col] >= val); return b; },
      order() { return b; },
      limit() { return b; },
      then(resolve) {
        const rows = state[table].filter((r) => filters.every((f) => f(r)));
        if (op === 'delete') { state[table] = state[table].filter((r) => !rows.includes(r)); return resolve({ data: rows.map((r) => ({ id: r.id })), error: null }); }
        if (op === 'update') { rows.forEach((r) => Object.assign(r, patch)); return resolve({ data: rows.map((r) => ({ id: r.id })), error: null }); }
        return resolve({ data: rows.map((r) => ({ ...r })), error: null });
      },
    };
    return b;
  }
  return { from: (t) => builder(t), _state: state };
}

const NOW = Date.now();
const iso = (off) => new Date(NOW + off).toISOString();
const OLD = iso(-15 * 60000);   // past the 11-min floor
const FRESH = iso(-3 * 60000);  // inside the floor (still legitimately dispatching)
// an orphan row: non-terminal, NULL modal_call_id
const orphan = (o) => ({
  id: 'o1', user_id: 'u1', status: 'processing', modal_call_id: null,
  video_url: 'https://cf/sources/u1/key.mp4', vibe_input: 'clean',
  edit_recipe: null, reedit_mode: null, change_request: null, parent_job_id: null,
  transcript: null, analysis_data: null, resolved_broll: null, trend_snapshot: null,
  created_at: OLD, result: null, refunded_at: null, ...o,
});

const present = async () => true;
const absent = async () => false;
const unknown = async () => null;
const noop = () => {};

test('selector: NULL call_id + non-terminal + past floor → redispatchable; not otherwise', () => {
  assert.equal(isRedispatchable({ status: 'processing', modal_call_id: null, created_at: OLD }, NOW), true);
  assert.equal(isRedispatchable({ status: 'queued', modal_call_id: null, created_at: OLD }, NOW), true, 'queued orphans count too');
  assert.equal(isRedispatchable({ status: 'processing', modal_call_id: 'ap-123', created_at: OLD }, NOW), false, 'has call_id = dispatched, not an orphan');
  assert.equal(isRedispatchable({ status: 'processing', modal_call_id: null, created_at: FRESH }, NOW), false, 'inside the floor = maybe still waiting on source');
  assert.equal(isRedispatchable({ status: 'completed', modal_call_id: null, created_at: OLD }, NOW), false, 'terminal never re-dispatches');
  assert.equal(isRedispatchable({ status: 'failed', modal_call_id: null, created_at: OLD }, NOW), false);
});

test('source PRESENT → re-dispatched (idempotent call made, attempt stamped, still processing)', async () => {
  const fake = makeFake({ video_jobs: [orphan({})] });
  const calls = [];
  const out = await sweepOrphanRedispatch(fake, {
    pushProgressToSSE: noop,
    dispatchJobToModal: async (args) => { calls.push(args); },
    sourceExists: present,
  });
  assert.equal(out.redispatched, 1, 'the recoverable orphan is re-dispatched');
  assert.equal(out.uploadFailed, 0);
  assert.equal(calls.length, 1, 'dispatchJobToModal called once');
  assert.equal(calls[0].jobId, 'o1');
  assert.equal(calls[0].videoUrl, 'https://cf/sources/u1/key.mp4');
  assert.equal(calls[0].premiumPipeline, false, 'premium ≡ standard today → no downgrade');
  const row = fake._state.video_jobs[0];
  assert.equal(row.status, 'processing', 'still processing — the re-dispatch owns it now');
  assert.equal(row.result._redispatch.attempts, 1, 'attempt stamped for the cap');
});

test('source ABSENT → honest UPLOAD terminal, NO re-dispatch (no 600s wait for bytes that never arrive)', async () => {
  const fake = makeFake({ video_jobs: [orphan({})] });
  const calls = [];
  const sse = [];
  const out = await sweepOrphanRedispatch(fake, {
    pushProgressToSSE: (id, ev) => sse.push(ev),
    dispatchJobToModal: async (args) => { calls.push(args); },
    sourceExists: absent,
  });
  assert.equal(out.uploadFailed, 1);
  assert.equal(out.redispatched, 0);
  assert.equal(calls.length, 0, 'never re-dispatched — the upload never completed');
  const row = fake._state.video_jobs[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.result.error_code, 'UPLOAD_NEVER_STARTED');
  assert.equal(row.result.requires_new_video, true, 'routes to the picker — a fresh key is the only fix');
  assert.ok(/didn.t finish/i.test(row.error_message));
  assert.equal(sse[0] && sse[0].final, true);
});

test('attempt cap: source present but already re-dispatched once (grace elapsed) → give up NEVER_DISPATCHED', async () => {
  const spent = orphan({ result: { _redispatch: { attempts: 1, last_at: iso(-15 * 60000) } } });
  const fake = makeFake({ video_jobs: [spent] });
  const calls = [];
  const out = await sweepOrphanRedispatch(fake, {
    pushProgressToSSE: noop,
    dispatchJobToModal: async (args) => { calls.push(args); },
    sourceExists: present,
  });
  assert.equal(out.gaveUp, 1);
  assert.equal(calls.length, 0, 'no more re-dispatches after the cap');
  const row = fake._state.video_jobs[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.result.error_code, 'NEVER_DISPATCHED');
});

test('grace window: a re-dispatch from moments ago is NOT retried', async () => {
  const inflight = orphan({ result: { _redispatch: { attempts: 1, last_at: iso(-60 * 1000) } } }); // 1min ago
  const fake = makeFake({ video_jobs: [inflight] });
  const calls = [];
  const out = await sweepOrphanRedispatch(fake, {
    pushProgressToSSE: noop,
    dispatchJobToModal: async (args) => { calls.push(args); },
    sourceExists: present,
  });
  assert.equal(out.redispatched, 0);
  assert.equal(out.gaveUp, 0);
  assert.equal(calls.length, 0, 'inside the grace window — left to land its call_id');
  assert.equal(fake._state.video_jobs[0].status, 'processing');
});

test('source UNMEASURABLE (S3 blip) → FAIL OPEN, re-dispatch rather than mass-fail', async () => {
  const fake = makeFake({ video_jobs: [orphan({})] });
  const calls = [];
  const out = await sweepOrphanRedispatch(fake, {
    pushProgressToSSE: noop,
    dispatchJobToModal: async (args) => { calls.push(args); },
    sourceExists: unknown,
  });
  assert.equal(out.uploadFailed, 0, 'an unmeasurable check must not terminalize');
  assert.equal(out.redispatched, 1);
  assert.equal(calls.length, 1);
});

test('a dispatched job (call_id present) is never touched', async () => {
  const fake = makeFake({ video_jobs: [orphan({ modal_call_id: 'ap-live-123' })] });
  const calls = [];
  const out = await sweepOrphanRedispatch(fake, {
    pushProgressToSSE: noop,
    dispatchJobToModal: async (args) => { calls.push(args); },
    sourceExists: absent, // even if we'd terminalize, the query must exclude it
  });
  assert.equal(out.scanned, 0, 'call_id present → not selected as an orphan');
  assert.equal(calls.length, 0);
  assert.equal(fake._state.video_jobs[0].status, 'processing');
});

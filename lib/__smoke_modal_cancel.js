'use strict';
// Cancel-on-reap, tested in both directions.
//
// The load-bearing property is NOT "it cancels" — it is "it never blocks the
// reap". The row write is the user-facing contract; the cancel is only money. A
// cancel that throws, hangs, or is unconfigured must leave the reaper exactly as
// it behaves today.

const assert = require('assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test';

const { cancelModalCall, callIdFromRow, cancelUrl } = require('./modal-cancel');
const quiet = { log() {}, warn() {} };

// ── the handle is read from where dispatch puts it ──────────────────────────
assert.strictEqual(callIdFromRow({ progress_step: 'modal_call:fc-abc123' }), 'fc-abc123');
assert.strictEqual(callIdFromRow({ progress_step: '  modal_call:fc-xyz  ' }), 'fc-xyz');
// Anything that is NOT ours must be ignored, or we would POST garbage as a call id.
for (const bad of [
  { progress_step: 'render' }, { progress_step: '' }, { progress_step: 'modal_call:' },
  { progress_step: null }, { progress_step: 42 }, {}, null, undefined,
]) {
  assert.strictEqual(callIdFromRow(bad), null, `must not read a call id from ${JSON.stringify(bad)}`);
}

// ── the URL is derived, so there is nothing new to configure ────────────────
process.env.MODAL_ENDPOINT_URL = 'https://acme--promptly-gpu-worker-promptlyworker-run-job.modal.run';
delete process.env.MODAL_CANCEL_URL;
assert.strictEqual(cancelUrl(),
  'https://acme--promptly-gpu-worker-cancel-call.modal.run');
process.env.MODAL_CANCEL_URL = 'https://override.example/cancel';
assert.strictEqual(cancelUrl(), 'https://override.example/cancel', 'an explicit override wins');
delete process.env.MODAL_CANCEL_URL;

(async () => {
  process.env.MODAL_CALLBACK_SECRET = 's3cret';
  const ROW = { id: 'j1', progress_step: 'modal_call:fc-abc123' };

  // ── DIRECTION 1: it cancels, and sends the right thing ────────────────────
  let seen = null;
  let r = await cancelModalCall(ROW, {
    log: quiet,
    fetchImpl: async (url, opts) => {
      seen = { url, body: JSON.parse(opts.body), method: opts.method };
      return { status: 200, json: async () => ({ ok: true, cancelled: true }) };
    },
  });
  assert.deepStrictEqual(
    { attempted: r.attempted, cancelled: r.cancelled }, { attempted: true, cancelled: true });
  assert.strictEqual(seen.method, 'POST');
  assert.strictEqual(seen.body.call_id, 'fc-abc123');
  assert.strictEqual(seen.body.secret, 's3cret', 'the shared secret must be sent, not a new one');
  assert.ok(/cancel-call/.test(seen.url));

  // ── DIRECTION 2: it must NOT claim success when it did not cancel ──────────
  // A cancel that reports cancelled:false is the case where the money is still
  // being spent; reporting it as success is how a no-op reads as a fix.
  r = await cancelModalCall(ROW, {
    log: quiet,
    fetchImpl: async () => ({ status: 200, json: async () => ({ ok: false, cancelled: false, error: 'already finished' }) }),
  });
  assert.strictEqual(r.attempted, true);
  assert.strictEqual(r.cancelled, false, 'a not-cancelled response is NOT a cancel');

  r = await cancelModalCall(ROW, {
    log: quiet,
    fetchImpl: async () => ({ status: 401, json: async () => ({ ok: false, error: 'unauthorized' }) }),
  });
  assert.strictEqual(r.cancelled, false, 'a 401 is not a cancel');

  // ── THE ONE THAT MATTERS: nothing here may ever throw ─────────────────────
  // The reaper awaits this before its terminal write. If it throws, the row is
  // never written and a stalled job hangs forever — strictly worse than the bug.
  for (const [label, impl] of [
    ['fetch throws', async () => { throw new Error('ECONNREFUSED'); }],
    ['fetch returns junk', async () => ({ status: 200, json: async () => { throw new Error('not json'); } })],
    ['fetch returns null', async () => null],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const rr = await cancelModalCall(ROW, { log: quiet, fetchImpl: impl });
    assert.strictEqual(rr.cancelled, false, `${label} must not report a cancel`);
    assert.ok(typeof rr.reason === 'string' && rr.reason, `${label} must give a reason`);
  }

  // ── unconfigured must be a clean no-op, and must SAY it never tried ───────
  // "attempted but failed" and "never attempted" are different facts; collapsing
  // them is how a silently disabled fix looks like a working one.
  const noSecret = { ...process.env.MODAL_CALLBACK_SECRET };
  delete process.env.MODAL_CALLBACK_SECRET;
  r = await cancelModalCall(ROW, { log: quiet, fetchImpl: async () => ({ status: 200, json: async () => ({}) }) });
  assert.deepStrictEqual({ a: r.attempted, c: r.cancelled, why: r.reason },
    { a: false, c: false, why: 'no_secret' });
  process.env.MODAL_CALLBACK_SECRET = 's3cret';
  void noSecret;

  const keepUrl = process.env.MODAL_ENDPOINT_URL;
  delete process.env.MODAL_ENDPOINT_URL;
  r = await cancelModalCall(ROW, { log: quiet, fetchImpl: async () => ({ status: 200, json: async () => ({}) }) });
  assert.strictEqual(r.reason, 'no_cancel_url');
  process.env.MODAL_ENDPOINT_URL = keepUrl;

  // a job with no persisted handle is the pre-fix world: no attempt, no noise
  r = await cancelModalCall({ id: 'j2', progress_step: 'render' }, { log: quiet });
  assert.deepStrictEqual({ a: r.attempted, why: r.reason }, { a: false, why: 'no_call_id' });

  // ── the reaper must actually call it, BEFORE the terminal write ───────────
  const src = require('fs').readFileSync(require('path').join(__dirname, 'job-reaper.js'), 'utf8');
  assert.ok(src.includes('cancelModalCall'), 'the reaper must attempt the cancel');
  assert.ok(src.indexOf('await cancelModalCall') < src.indexOf("status: 'failed'"),
    'the cancel must be awaited BEFORE the terminal write, or the row bounds nothing');

  // ── and the stale 900s comments that cost an hour must be gone ────────────
  const stale = src.split('\n').filter((l) => /900\s*s|timeout=900|its 900/.test(l));
  assert.strictEqual(stale.length, 0,
    `stale 900s claims remain (the worker timeout is 3000s): ${stale.join(' | ')}`);

  console.log('[smoke] modal cancel: ALL PASS (cancels; never throws; never blocks the reap; 900s comments gone)');
})().catch((e) => { console.error('[smoke] FAILED:', e && e.message); process.exit(1); });

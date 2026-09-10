'use strict';
// Four states that must stay four states. Every conflation below has a
// production precedent in this repo.
const assert = require('assert');
const path = require('path');

// Stub S3 before the module under test binds it.
const s3Path = require.resolve('../services/s3');
let _obj = null;       // what the "bucket" holds, or an Error to throw
require.cache[s3Path] = {
  id: s3Path, filename: s3Path, loaded: true,
  exports: {
    createPresignedPutUrl: async (key) => `https://s3.test/${key}?sig=x`,
    getObjectBuffer: async (key, maxBytes) => {
      if (_obj instanceof Error) throw _obj;
      if (_obj === null) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; }
      const buffer = Buffer.from(_obj, 'utf8');
      if (maxBytes && buffer.length > maxBytes) {
        const e = new Error('too_large'); e.statusCode = 413;
        e.detail = { size: buffer.length, limit: maxBytes }; throw e;
      }
      return { buffer, contentType: 'application/json', size: buffer.length };
    },
  },
};

const C = require('./agentic-collect');
const entry = (o = {}) => ({ src_t0: 0, src_t1: 1, id: 'a1b2c3d4e5f6', ...o });

(async () => {
  // ── the key is derived from the job id ALONE ──────────────────────────────
  assert.strictEqual(C.agenticResultKey('job-1'), 'agentic-results/job-1.json');
  assert.strictEqual(C.agenticResultKey('job-1'), C.agenticResultKey('job-1'), 'stable');
  assert.notStrictEqual(C.agenticResultKey('job-1'), C.agenticResultKey('job-2'), 'per job');
  assert.ok((await C.presignResultUrl('job-1')).includes('agentic-results/job-1.json'));
  // THE DEPLOY-SURVIVABILITY PROPERTY, stated as a test: collection needs no
  // argument that lives in this process. If this ever grows a call_id
  // parameter, a deploy mid-edit strands the job again.
  // (Function.length stops at the first defaulted parameter, so it says 1 here
  // and proves nothing. Read the signature instead.)
  const sig = C.collectAgenticResult.toString().slice(0, 120);
  assert.ok(/^async function collectAgenticResult\(jobId,/.test(sig), sig);
  assert.ok(!/call_?[Ii]d/.test(C.collectAgenticResult.toString()),
    'collection must not take or use a call_id. A handle held in THIS process '
    + 'is the shape that made the completion tail un-survivable across a deploy '
    + '— the whole reason the worker swapped it for a presigned result_url.');

  const quiet = { log() {}, error() {} };

  // ── 1. NOT WRITTEN YET IS NOT A FAILURE ──────────────────────────────────
  _obj = null;
  assert.deepStrictEqual(await C.collectAgenticResult('j', { log: quiet }), { state: 'RUNNING' },
    'an absent object means the worker has not written yet. Reading 404 as '
    + 'FAILED refunds the credit and then the video lands anyway.');

  // ── 2. RUNNING stays RUNNING ─────────────────────────────────────────────
  _obj = JSON.stringify({ state: 'RUNNING' });
  assert.strictEqual((await C.collectAgenticResult('j', { log: quiet })).state, 'RUNNING');

  // ── 3. DONE with a real plan ─────────────────────────────────────────────
  _obj = JSON.stringify({ state: 'DONE', result: { plan: [entry(), entry({ id: '0123456789ab' })], video_url: 'x' } });
  let r = await C.collectAgenticResult('j', { log: quiet });
  assert.strictEqual(r.state, 'DONE');
  assert.strictEqual(r.planEntries, 2);
  assert.strictEqual(r.result.video_url, 'x');

  // ── 4. DONE with an UNUSABLE plan is NOT done ────────────────────────────
  for (const [what, plan] of [
    ['empty', []],
    ['a handler recipe dict', { cuts: [] }],
    ['a list of the wrong dicts', [{ start: 0, end: 3 }]],
    ['missing entirely', undefined],
  ]) {
    _obj = JSON.stringify({ state: 'DONE', result: { plan } });
    r = await C.collectAgenticResult('j', { log: quiet });
    assert.strictEqual(r.state, 'UNREADABLE', `DONE with ${what} must not be DONE`);
    assert.ok(/plan is unusable/.test(r.reason), what);
  }
  // The empty case specifically: stored and handed back as prior_plan, the
  // worker reads it as "modify nothing" — a fresh edit counted as a re-edit,
  // and free, because shouldDebit is false for every re-edit variant.

  // ── 5. FAILED carries a CODE, and a designed refusal is not an error ─────
  _obj = JSON.stringify({ state: 'FAILED', error_code: 'UNSUPPORTED', error: 'no speech' });
  r = await C.collectAgenticResult('j', { log: quiet });
  assert.strictEqual(r.state, 'FAILED');
  assert.strictEqual(r.code, 'UNSUPPORTED');
  assert.strictEqual(r.designedRefusal, true,
    'UNSUPPORTED is a DESIGNED REFUSAL. Bucketing it with real errors is what '
    + 'made a one-user clip look like an outage — the bleed meter needs them apart.');
  _obj = JSON.stringify({ state: 'FAILED', error_code: 'RENDER_FAILED', error: 'boom' });
  r = await C.collectAgenticResult('j', { log: quiet });
  assert.strictEqual(r.designedRefusal, false, 'a real error is not a refusal');
  assert.strictEqual(r.message, 'boom');

  // an UNKNOWN code is kept verbatim, never flattened to INTERNAL
  _obj = JSON.stringify({ state: 'FAILED', error_code: 'SOMETHING_NEW' });
  r = await C.collectAgenticResult('j', { log: quiet });
  assert.strictEqual(r.code, 'SOMETHING_NEW',
    'a code we have not seen is information; mapping it to INTERNAL is how a '
    + 'new failure class hides inside an old bucket');
  assert.strictEqual(r.designedRefusal, false);

  // ── 6. UNREADABLE is not FAILED ──────────────────────────────────────────
  // A failed edit is the worker telling us something. An unreadable result is
  // US failing to understand it. Folding them together hides a defect on this
  // side inside a bucket we expect to be non-empty.
  _obj = 'this is not json';
  assert.strictEqual((await C.collectAgenticResult('j', { log: quiet })).state, 'UNREADABLE');
  _obj = JSON.stringify([1, 2, 3]);
  assert.strictEqual((await C.collectAgenticResult('j', { log: quiet })).state, 'UNREADABLE');
  _obj = JSON.stringify({ state: 'WAT' });
  assert.strictEqual((await C.collectAgenticResult('j', { log: quiet })).state, 'UNREADABLE');

  // ── 7. an oversized body is refused, not buffered ────────────────────────
  _obj = JSON.stringify({ state: 'DONE', result: { plan: [entry()], pad: 'x'.repeat(C.MAX_RESULT_BYTES) } });
  r = await C.collectAgenticResult('j', { log: quiet });
  assert.strictEqual(r.state, 'UNREADABLE');
  assert.ok(/too large/.test(r.reason), 'a wrong key pointing at a render must not be buffered');

  // ── 8. a REAL storage outage must surface, never read as RUNNING ─────────
  _obj = Object.assign(new Error('connection reset'), { name: 'NetworkingError' });
  await assert.rejects(() => C.collectAgenticResult('j', { log: quiet }), /connection reset/,
    'S3 being down is unmeasurable, not "still running" — reporting RUNNING '
    + 'would poll a dead job forever and never alert');

  console.log('[smoke] agentic collect: ALL PASS (absent is RUNNING not FAILED; DONE with an '
    + 'unusable plan is not DONE; designed refusal separated from error; unknown codes kept '
    + 'verbatim; UNREADABLE kept apart from FAILED; storage outage surfaces)');
})().catch((e) => { console.error('[smoke] FAILED:', e && e.message); process.exit(1); });

'use strict';
// Real-path smoke for the upload ordering fix.
//
// THE DEFECT: a job row was created and a Modal worker SPAWNED before anyone
// checked the source existed. The worker then HEAD-polled for 600s and failed
// UPLOAD_STALLED — 94 jobs / 60% of ALL failures in the 7 days to 2026-08-02,
// each holding a cpu=16/64GiB container (~$0.62) to learn what one HEAD answers
// in 50ms. The copy then sent the user back to the SAME dead key; our first
// paying subscriber looped that three times over 6.5 hours.
//
// The load-bearing assertions here are the two that keep it safe:
//   * UNMEASURABLE must FAIL OPEN — an S3 blip must never reject a real upload.
//   * a DEAD key must be rejected at CREATION, before any credit is claimed.

const assert = require('assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test';

// stub S3 before source-presence loads it
const s3path = require.resolve('../services/s3');
let EXISTS = false;                  // false | true | null(unknown)
require.cache[s3path] = {
  id: s3path, filename: s3path, loaded: true,
  exports: { objectExists: async () => EXISTS, isConfigured: () => true, S3_BUCKET: 'b' },
};

const sp = require('./source-presence');

(async () => {
  // ── 1. key extraction across every URL shape we store ─────────────────────
  const K = 'sources/u1/1785613240944-ABC_L0_001.mp4';
  assert.strictEqual(sp.sourceKeyFromUrl(`https://d1iax8jos987n3.cloudfront.net/${K}`), K);
  assert.strictEqual(sp.sourceKeyFromUrl(`https://bkt.s3.us-east-1.amazonaws.com/${K}`), K);
  assert.strictEqual(sp.sourceKeyFromUrl(`s3://bkt/${K}`), K);
  assert.strictEqual(sp.sourceKeyFromUrl(K), K, 'a bare key passes through');
  assert.strictEqual(sp.sourceKeyFromUrl(`https://cdn/${K}?X-Amz-Signature=zz`), K,
    'a presigned query string must not become part of the key');
  assert.strictEqual(sp.sourceKeyFromUrl(''), null);
  assert.strictEqual(sp.sourceKeyFromUrl(null), null);

  // ── 2. present -> dispatch immediately, ONE HEAD ──────────────────────────
  EXISTS = true;
  let r = await sp.waitForSource(K, { budgetMs: 5_000 });
  assert.strictEqual(r.present, true);
  assert.strictEqual(r.attempts, 1, 'a source already on S3 must cost exactly one HEAD');

  // ── 3. THE LOAD-BEARING ONE: unmeasurable must FAIL OPEN ──────────────────
  EXISTS = null;
  r = await sp.waitForSource(K, { budgetMs: 5_000 });
  assert.strictEqual(r.present, true, 'S3 unable to answer must NOT reject the upload');
  assert.strictEqual(r.unknown, true, 'and it must be flagged unknown, not claimed as present');

  // ── 4. absent for the whole budget -> definite miss, bounded ──────────────
  EXISTS = false;
  const t0 = Date.now();
  r = await sp.waitForSource(K, { budgetMs: 1_200 });
  const took = Date.now() - t0;
  assert.strictEqual(r.present, false, 'a source that never lands must be reported absent');
  assert.strictEqual(r.reason, 'deadline');
  assert.ok(took >= 1_000 && took < 6_000, `must honour the budget, took ${took}ms`);
  assert.ok(r.attempts > 1, 'must actually retry, not give up on the first HEAD');

  // ── 5. arrives mid-wait -> dispatches, does not burn the budget ───────────
  EXISTS = false;
  setTimeout(() => { EXISTS = true; }, 600);
  const t1 = Date.now();
  r = await sp.waitForSource(K, { budgetMs: 30_000 });
  assert.strictEqual(r.present, true);
  assert.ok(Date.now() - t1 < 10_000, 'a late arrival must dispatch, not wait out the budget');

  // ── 6. dead-key lookup: only upload-family codes count ────────────────────
  const rows = (code) => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({
        order: () => ({ limit: () => Promise.resolve({
          data: code ? [{ id: 'j1', created_at: 'x', result: { error_code: code } }] : [],
        }) }),
      }) }) }) }),
    }),
  });
  assert.ok(await sp.findDeadSourceJob(rows('UPLOAD_STALLED'), 'u', 'url'),
    'a prior UPLOAD_STALLED on this exact URL means the key is dead');
  assert.ok(await sp.findDeadSourceJob(rows('UPLOAD_NEVER_STARTED'), 'u', 'url'));
  assert.strictEqual(await sp.findDeadSourceJob(rows('RENDER_FATAL'), 'u', 'url'), null,
    'a RENDER failure means the source uploaded FINE — must not block a retry');
  assert.strictEqual(await sp.findDeadSourceJob(rows(null), 'u', 'url'), null);
  assert.strictEqual(await sp.findDeadSourceJob(null, 'u', 'url'), null,
    'no db handle -> never block a job');
  const throwing = { from: () => { throw new Error('pg down'); } };
  assert.strictEqual(await sp.findDeadSourceJob(throwing, 'u', 'url'), null,
    'a lookup outage must never block a job');

  // ── 7. the copy points at the ONE action that works ───────────────────────
  const { sourceMissingMessage } = require('./failure-copy');
  const copy = sourceMissingMessage();
  assert.ok(/pick it again/i.test(copy), 'must tell the user to RE-PICK (a fresh key)');
  assert.ok(!/check your connection/i.test(copy),
    'must NOT send them back to the same dead upload');
  assert.ok(/haven't been charged|not been charged/i.test(copy),
    'must confirm no credit was consumed');

  console.log('[smoke] source presence: ALL PASS (fail-open on unknown; dead key rejected; re-pick copy)');
})().catch((e) => { console.error('[smoke] FAILED:', e && e.message); process.exit(1); });

'use strict';
// DON'T WAIT 600s FOR BYTES THE CLIENT SAID ARE NOT COMING.
//
// MEASURED: 76% of orphaned jobs never completed their upload (37 of 49) vs 6%
// of successful jobs — a 12x enrichment, control-verified. Those users wait the
// full 600s source budget and only then learn the upload never arrived. The
// client already knows: it emits upload_failed with a mechanism
// (background_orphan/cancelled, timeout, http_403) the moment its URLSession
// dies on suspension.
//
// This helps the largest live class WITHOUT an app release. The 225
// background-URLSession fix is the cure; this is the honest wait until then.
//
// THE LOAD-BEARING DIRECTION IS THE NEGATIVE ONE: a slow-but-working upload
// must NEVER be cut short. A false abort turns a working render into a failure,
// which is strictly worse than waiting.

const assert = require('assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test';

const sp = require('./source-presence');
const src = require('fs').readFileSync(require('path').join(__dirname, 'source-presence.js'), 'utf8');

// ── POSITIVE CONTROL: the helper must FIND a real report ────────────────────
// Without this, "no failure found" could mean the query is broken and every
// assertion below would pass on a helper that never returns anything.
(async () => {
  const withHit = {
    from: () => ({
      select: () => ({ eq: () => ({ gte: () => ({ order: () => ({ limit: async () => ({
        data: [{ created_at: '2026-08-04T10:00:00Z',
                 props: { job_id: 'job-1', mechanism: 'background_orphan' } }],
        error: null,
      }) }) }) }) }),
    }),
  };
  // Injected as a PARAMETER. Reassigning the module export does not work — the
  // module destructures supabaseAdmin at import time, so the local binding is
  // already captured. The positive control below is what caught that.
  let hit = await sp.clientReportedUploadFailure('job-1', '2026-08-04T09:00:00Z', { db: withHit });
  assert.ok(hit, 'POSITIVE CONTROL FAILED — the helper found nothing on a row that exists, '
    + 'so every negative result below would be meaningless');
  assert.strictEqual(hit.mechanism, 'background_orphan');

  // ── NEGATIVE CONTROL: a report for a DIFFERENT job must not match ──────────
  hit = await sp.clientReportedUploadFailure('job-OTHER', '2026-08-04T09:00:00Z', { db: withHit });
  assert.strictEqual(hit, null,
    'a failure reported for another job must never abort THIS upload');

  // ── empty result set -> no signal, not a false positive ───────────────────
  const empty = { from: () => ({ select: () => ({ eq: () => ({ gte: () => ({ order: () => ({
    limit: async () => ({ data: [], error: null }) }) }) }) }) }) };
  assert.strictEqual(await sp.clientReportedUploadFailure('job-1', '2026-08-04T09:00:00Z', { db: empty }), null);

  // ── FAIL-OPEN: a DB error must mean "keep waiting", never "abort" ─────────
  const dbErr = { from: () => ({ select: () => ({ eq: () => ({ gte: () => ({ order: () => ({
    limit: async () => ({ data: null, error: { message: 'pg down' } }) }) }) }) }) }) };
  assert.strictEqual(await sp.clientReportedUploadFailure('job-1', '2026-08-04T09:00:00Z', { db: dbErr }), null,
    'a DB error must NOT be read as a dead upload — unmeasurable means keep waiting');

  const thrower = { from: () => { throw new Error('boom'); } };
  assert.strictEqual(await sp.clientReportedUploadFailure('job-1', '2026-08-04T09:00:00Z', { db: thrower }), null,
    'a throw must fail open');

  // ── missing args are not a signal ─────────────────────────────────────────
  assert.strictEqual(await sp.clientReportedUploadFailure(null, '2026-08-04T09:00:00Z', { db: withHit }), null);
  assert.strictEqual(await sp.clientReportedUploadFailure('job-1', null, { db: withHit }), null);

  // ── the check must only run while the object is ABSENT ───────────────────
  // Consulting it before the existence check could abort an upload that had
  // already landed.
  const iExists = src.indexOf('if (exists) return { present: true');
  const iDead = src.indexOf('clientReportedUploadFailure(jobId, since)');
  assert.ok(iExists > 0 && iDead > 0, 'could not locate the ordering anchors');
  assert.ok(iDead > iExists,
    'the client-failure check must come AFTER the object-exists check — a present '
    + 'object must never be aborted');

  // ...and it must be OPT-IN, so callers that pass no jobId behave exactly as before.
  assert.ok(/if \(jobId && since &&/.test(src),
    'the fast-fail must be guarded on jobId+since so existing callers are unchanged');

  // ...and it must report WHY, so the class stays countable.
  assert.ok(src.includes("reason: 'client_reported_failure'"),
    'the early return must name itself, not masquerade as a deadline');

  console.log('[smoke] dead-upload fast-fail: ALL PASS '
    + '(positive control finds a real report; wrong-job/empty/db-error/throw all fail OPEN; '
    + 'only consulted while absent; opt-in; names its own reason)');
})().catch((e) => { console.error('[smoke] FAILED:', e && e.message); process.exit(1); });

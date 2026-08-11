'use strict';
// Gate for evidence-based terminalisation (2026-08-11).
//
// FORGED FROM 9 LOST USERS. Clean cohort (created >= 18:29Z, both DELIVERY
// halves live, v526 hang fix live): 34 terminal jobs / 32 users; 9 jobs /
// 9 USERS terminalised 'failed' with "trouble reaching the render service"
// while S3 held their finished render — 10/10 probed, 7.5-42 MB, all
// -edited.mp4. The chain: worker writes the mp4 -> completion POST carries no
// deliverable URL -> CHECK 23514 refuses status='completed' -> the error was
// discarded so it read as a 0-row match -> ~900s fallback called it failed and
// refunded a delivered render.
//
// Laws:
//   1. NO RENDER, NO REPAIR. A missing/short/HLS-only object must never produce
//      a 'completed' row — that would hand a user a job with no video, which is
//      worse than the failure it replaces.
//   2. The URL and the terminal are written TOGETHER. That is what satisfies
//      the 23514 constraint instead of fighting it.
//   3. The write is guarded against terminal rows, so racing the real
//      completion tail is a no-op, never a clobber (single-writer law).
//   4. S3 unreadable => "cannot tell" => NO repair and NO crash. It must fall
//      through to the caller's normal failure path.
//   5. completion_delivery='repair' rides the write, or the delivery-mix
//      instrument cannot count the very class this fixes.
//   6. WIRING: both fallback failure sites must consult it BEFORE writing
//      failed, and return without failing/refunding when it repairs.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  hasCompletionClaim, deliverableOnRow, repairCompletedRender,
} = require('./completion-repair');

// ── claim detection (the signal that says "look in S3", not proof of delivery)
assert.ok(hasCompletionClaim({ progress: 100, current_step: 'complete' }));
assert.ok(hasCompletionClaim({ progress: 100, current_step: 'completed' }));
assert.ok(!hasCompletionClaim({ progress: 99, current_step: 'complete' }));
assert.ok(!hasCompletionClaim({ progress: 100, current_step: 'render' }));
assert.ok(!hasCompletionClaim(null));

assert.strictEqual(deliverableOnRow({ rendered_video_url: 'u' }), 'u');
assert.strictEqual(deliverableOnRow({ result: { video_url: 'v' } }), 'v');
assert.strictEqual(deliverableOnRow({ result: null }), null);
assert.strictEqual(deliverableOnRow({}), null);

// ── harnesses
const S3_OK = { isConfigured: () => true, S3_BUCKET: 'b', AWS_REGION: 'r',
  createPresignedGetUrl: async (k) => `https://cdn/${k}?sig` };
const listing = (contents) => ({ send: async () => ({ Contents: contents }) });
const LOC = function ListObjectsV2Command(a) { return a; };
const REAL = [{ Key: 'renders/j/1786-edited.mp4', Size: 22_000_000 },
  { Key: 'renders/j/1786-edited-hls/stream_1080p/init.mp4', Size: 800 }];
const HLS_ONLY = [{ Key: 'renders/j/x-hls/stream_1080p/init.mp4', Size: 800 },
  { Key: 'renders/j/x-hls/master.m3u8', Size: 300 }];

function db({ rows = [{ id: 'j' }], error = null, capture = {} } = {}) {
  return { from: () => ({ update(p) { capture.payload = p; return this; },
    eq() { return this; },
    not(col, op, val) { capture.guard = `${col} ${op} ${val}`; return this; },
    select: async () => ({ data: rows, error }) }) };
}
const quiet = { error: () => {} };

(async () => {
  // 1. happy path — render exists ⇒ repaired, URL + terminal together
  let cap = {};
  let r = await repairCompletedRender({ jobId: 'j', supabaseAdmin: db({ capture: cap }),
    s3: S3_OK, s3Client: listing(REAL), ListObjectsV2Command: LOC, log: quiet });
  assert.strictEqual(r.repaired, true, 'a real render must repair');
  assert.ok(/-edited\.mp4$/.test(r.key), 'must pick the deliverable, never the HLS init');
  assert.strictEqual(cap.payload.status, 'completed');
  assert.ok(cap.payload.rendered_video_url, 'LAW 2: URL and terminal in ONE write (23514)');
  assert.strictEqual(cap.payload.progress, 100);
  assert.strictEqual(cap.payload.completion_delivery, 'repair', 'LAW 5: countable');
  assert.ok(/status in \(completed,failed,canceled,needs_input\)/.test(cap.guard),
    'LAW 3: must be guarded against terminal rows');

  // 2. LAW 1 — no render, no repair
  for (const [label, contents] of [['empty', []], ['hls-only', HLS_ONLY],
    ['too-small', [{ Key: 'renders/j/a-edited.mp4', Size: 4000 }]]]) {
    cap = {};
    r = await repairCompletedRender({ jobId: 'j', supabaseAdmin: db({ capture: cap }),
      s3: S3_OK, s3Client: listing(contents), ListObjectsV2Command: LOC, log: quiet });
    assert.strictEqual(r.repaired, false, `LAW 1: ${label} must NOT repair`);
    assert.strictEqual(r.reason, 'no_render_in_s3');
    assert.strictEqual(cap.payload, undefined, `LAW 1: ${label} must not write at all`);
  }

  // 3. LAW 4 — S3 unreadable / unconfigured ⇒ no repair, no throw
  cap = {};
  r = await repairCompletedRender({ jobId: 'j', supabaseAdmin: db({ capture: cap }), s3: S3_OK,
    s3Client: { send: async () => { throw new Error('AccessDenied'); } },
    ListObjectsV2Command: LOC, log: quiet });
  assert.strictEqual(r.repaired, false, 'LAW 4: S3 error must not repair');
  assert.strictEqual(cap.payload, undefined, 'LAW 4: and must not write');
  r = await repairCompletedRender({ jobId: 'j', supabaseAdmin: db(),
    s3: { isConfigured: () => false }, s3Client: listing(REAL),
    ListObjectsV2Command: LOC, log: quiet });
  assert.strictEqual(r.repaired, false, 'LAW 4: unconfigured S3 must not repair');

  // 4. LAW 3 — lost the race ⇒ no repair claimed, and it is not an error
  r = await repairCompletedRender({ jobId: 'j', supabaseAdmin: db({ rows: [] }), s3: S3_OK,
    s3Client: listing(REAL), ListObjectsV2Command: LOC, log: quiet });
  assert.strictEqual(r.repaired, false);
  assert.strictEqual(r.reason, 'already_terminal', 'a row that settled first is correct, not a defect');

  // 5. a DB error must be reported, never reported as a repair
  r = await repairCompletedRender({ jobId: 'j',
    supabaseAdmin: db({ rows: null, error: { message: 'boom', code: '23514' } }),
    s3: S3_OK, s3Client: listing(REAL), ListObjectsV2Command: LOC, log: quiet });
  assert.strictEqual(r.repaired, false);
  assert.ok(/update_failed/.test(r.reason));

  // 6. presign failure must not produce a URL-less completion
  cap = {};
  r = await repairCompletedRender({ jobId: 'j', supabaseAdmin: db({ capture: cap }),
    s3: { ...S3_OK, createPresignedGetUrl: async () => { throw new Error('nope'); } },
    s3Client: listing(REAL), ListObjectsV2Command: LOC, log: quiet });
  assert.strictEqual(r.repaired, false);
  assert.strictEqual(cap.payload, undefined, 'no URL ⇒ no write (23514 would refuse it anyway)');

  // 7. LAW 6 — WIRING. Both fallback failure sites must ask BEFORE failing.
  const d = fs.readFileSync(path.join(__dirname, 'video-processor', 'dispatch-to-modal.js'), 'utf8');
  assert.ok(/repairCompletedRender/.test(d), 'dispatch must import the repair');
  const guards = d.match(/if \(await deliveredNotFailed\(jobId, userId, pushProgressToSSE\)\) return;/g) || [];
  assert.strictEqual(guards.length, 2,
    `both fallback failure sites must consult S3 before writing failed (found ${guards.length}/2)`);
  // each guard must sit BEFORE its failure write, not after it
  for (const seg of d.split('deliveredNotFailed').slice(1)) {
    assert.ok(seg.indexOf("status: 'failed'") !== -1 || seg.indexOf('repaired') !== -1,
      'each evidence check must precede a failure write');
  }
  assert.ok(d.indexOf('deliveredNotFailed') < d.indexOf("error_message: dispatchErrorMessage()"),
    'the evidence check must come BEFORE the first dispatch-failure write');

  console.log('completion-repair smoke: PASS (no-render never repairs incl. hls-only/too-small, '
    + 'URL+terminal in one write, terminal-guarded, S3-unreadable degrades, race is not a defect, '
    + 'presign failure writes nothing, both fallback sites wired before their failure write)');
  process.exit(0);
})().catch((e) => { console.error('completion-repair smoke FAILED:', e && e.message); process.exit(1); });

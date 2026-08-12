'use strict';
// The multipart upload path must stay INTACT — item 7 depends on it.
//
// [MEASURED 2026-08-12, since 08-06] `upload_url_requested` ran 13,317 times:
// 13,310 `single`, **7 `multipart`**. The multipart path is effectively dead
// traffic — the client stopped calling it — while being the exact remedy the
// UNS mechanism needs (79% of upload failures died with under 1% transferred,
// after hanging p90 30.4 min; a single PUT cannot resume, chunked parts can).
//
// Dead code rots silently, and the discovery moment must not be the client half
// shipping. This asserts both endpoints and all four S3 primitives are still
// present and wired, so a refactor cannot quietly delete the thing item 7 is
// specced against.
//
// It also PINS the two facts that ruled suspects out, so a future change cannot
// silently reintroduce them:
//   * the single-PUT presign TTL is 604800s (7 days, SigV4 max). Expiry is NOT
//     the current mechanism — an earlier UPLOAD_NEVER_STARTED class was closed
//     by moving 600s -> 3600s -> 7d, and UNS still sits at 13%, so the dominant
//     mechanism today is the transfer dying, not the URL expiring. Shrinking
//     this TTL would reopen a class that is already closed.
//   * multipart part URLs must carry a TTL long enough to outlive a slow
//     transfer.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const s3src = fs.readFileSync(path.join(__dirname, '..', 'services', 's3.js'), 'utf8');
const s3 = require('../services/s3');

// ── endpoints still mounted
for (const route of ['/api/upload-multipart-init', '/api/upload-multipart-complete']) {
  assert.ok(server.includes(`parsed.pathname === '${route}'`),
    `${route} is gone — item 7's resumable upload has no server half to call`);
}
assert.ok(server.includes("parsed.pathname === '/api/upload-url'"),
  '/api/upload-url is gone — the single-PUT path every current client uses');

// ── S3 primitives still exported and callable
for (const fn of ['initMultipartUpload', 'completeMultipartUpload', 'abortMultipartUpload',
  'createPresignedPutUrl']) {
  assert.strictEqual(typeof s3[fn], 'function', `services/s3.${fn} is missing or not a function`);
}

// ── the 7-day single-PUT TTL is PINNED, with its reason
assert.ok(/createPresignedPutUrl\(key,\s*604800\)/.test(server),
  'the single-PUT presign TTL is no longer 604800s (7 days). It was raised 600 -> 3600 -> 7d '
  + 'precisely to close an UPLOAD_NEVER_STARTED class where a background URLSession resumed '
  + 'hours later against an expired URL. Shrinking it reopens that class.');

// ── multipart parts must not expire faster than a slow transfer. The observed
// p90 hang before failure is 30.4 min; anything under an hour is too tight.
const initCall = server.match(/initMultipartUpload\(key,\s*partCount,\s*(\d+)\)/);
assert.ok(initCall, 'multipart init no longer passes an explicit TTL');
assert.ok(Number(initCall[1]) >= 3600,
  `multipart part URLs expire in ${initCall[1]}s — under the 3600s floor. Uploads that hang `
  + 'p90 30.4 min (max 133) would start failing on expiry, which is a DIFFERENT failure than '
  + 'the one item 7 fixes and would be misread as it.');

// ── part-count bounds: the clamp is what keeps a hostile/buggy client from
// asking us to presign unbounded URLs.
assert.ok(/Math\.min\(1000,\s*parseInt\(body\?\.partCount/.test(server),
  'the partCount upper clamp (1000) is gone');
assert.ok(/partCount === 0.*400/s.test(server.slice(server.indexOf('/api/upload-multipart-init'),
  server.indexOf('/api/upload-multipart-init') + 2500)),
  'multipart init must 400 on a missing partCount rather than presigning nothing');

// ── both upload doors must still emit the server-truth funnel event, since it
// is the ONLY reliable signal (the client's upload_started drops on weak
// networks — exactly the population that fails).
const initSeg = server.slice(server.indexOf("'/api/upload-multipart-init'"),
  server.indexOf("'/api/upload-multipart-init'") + 2500);
assert.ok(/serverFunnel\([^)]*upload_url_requested[^)]*multipart/s.test(initSeg),
  "multipart init must emit upload_url_requested with path:'multipart' — it is how we measure "
  + 'whether the path is alive at all (7 of 13,317 today)');

console.log('multipart-intact smoke: PASS (both endpoints mounted, 4 S3 primitives exported, '
  + '7-day single-PUT TTL pinned with reason, part TTL >= 3600s floor, partCount clamp + 400, '
  + 'server-truth funnel wired)');
process.exit(0);

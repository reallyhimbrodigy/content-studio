'use strict';

// DISPATCH-PRESIGN — the change that makes sources/ restrictable
//
// The worker downloads whatever string lands in payload.video_url. While that
// string is the PUBLIC CDN url, sources/ CANNOT be restricted without breaking
// every render — 9,306 raw user videos across 577 users stay permanently
// fetchable purely to keep the download working (POSTURE_S3_PREFIXES.md).
//
// This pins the three properties that make the later restriction safe, and one
// trap that would have silently cost money.
//
// Source-level assertions, deliberately. dispatchToModal() needs Supabase, S3,
// a Modal endpoint and a live job row; a runtime harness for it would test the
// mock. What can regress here is someone reverting to `video_url: videoUrl`, or
// "tidying" the cache lookup to use the signed url — both are visible in the
// source and neither is visible in a mock.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'video-processor', 'dispatch-to-modal.js');
const raw = fs.readFileSync(SRC, 'utf8');
// Strip comments before asserting on code. A comment that merely DISCUSSES
// `video_url: videoUrl` must not read as the defect — the failure mode that
// broke __smoke_chat_model_pinned.js (a path glob whose `/*` opened a phantom
// block comment) and then my own chat-media privacy assertion.
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

const failures = [];
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures.push(`${name} — ${e.message}`); console.log(`  FAIL ${name} — ${e.message}`); }
}

// Prove the stripper left the file usable before trusting any absence test.
check('comment-stripping preserved the payload builder', () => {
  assert.ok(/const payload = \{/.test(src), 'payload builder vanished');
  assert.ok(/job_id: jobId/.test(src), 'payload body vanished');
});

// ── 1. THE PAYLOAD CARRIES A GRANT, NOT THE STORED URL ─────────────────────
check('payload.video_url is the presigned url, NOT the raw stored one', () => {
  assert.ok(/video_url: dispatchVideoUrl/.test(src),
    'payload.video_url is not dispatchVideoUrl — the worker would download the '
    + 'public url and sources/ could never be restricted');
  assert.ok(!/\bvideo_url: videoUrl\b/.test(src),
    'a payload still sends the raw stored url');
});

check('the proxy url is granted the same way', () => {
  assert.ok(/proxy_video_url: dispatchProxyUrl/.test(src),
    'the proxy still ships the public url — restricting sources/ would break '
    + 'Gemini analysis while leaving the render working, the worst split');
});

// ── 2. THE CACHE KEY MUST NOT BECOME THE SIGNED URL ────────────────────────
// video_analysis_cache is keyed by video_url. A signed url carries a unique
// Signature/Expires per mint, so keying on it makes EVERY lookup a miss and
// every dispatch pay for a fresh Gemini analysis — a silent, recurring cost
// that looks like a cache that simply never warms.
check('the analysis cache still looks up by the STABLE url', () => {
  assert.ok(/\.eq\('video_url', videoUrl\)/.test(src),
    "the cache lookup no longer uses the stable `videoUrl` — if it now keys on "
    + 'a signed url, every dispatch is a guaranteed cache MISS and pays for a '
    + 'fresh Gemini analysis');
});

check('videoUrl is never reassigned BEFORE the payload is built', () => {
  // It is the cache key AND the prewarm registry key in this region, so
  // rebinding it here would break both at once and neither failure is visible
  // at dispatch time.
  //
  // SCOPED, not file-wide. The first cut asserted file-wide and failed on a
  // legitimate `videoUrl = await createPresignedGetUrl(s3OutputKey, ...)` in
  // the COMPLETION path — a different function where videoUrl is the RENDERED
  // output (renders/...), not the source. A whole-file absence test cannot tell
  // two same-named locals apart, and the fix is to name the region, not to
  // delete the assertion.
  const start = src.indexOf('const modalEndpointUrl = process.env.MODAL_ENDPOINT_URL');
  const end = src.indexOf('const payload = {', start);
  assert.ok(start > 0 && end > start, 'could not slice the dispatch region');
  const region = src.slice(start, end);
  assert.ok(!/^\s*videoUrl\s*=/m.test(region),
    'videoUrl is reassigned inside the dispatch region — the analysis cache key '
    + 'and the prewarm registry key both move with it');
  // and confirm the slice is the right one
  assert.ok(/dispatchVideoUrl = await s3\.createPresignedGetUrl|set\(await s3\.createPresignedGetUrl/.test(region),
    'the sliced region does not contain the presign — the anchors moved');
});

// ── 3. IDEMPOTENT + FAIL-OPEN ──────────────────────────────────────────────
check('the key is derived with sourceKeyFromUrl (query-stripping ⇒ idempotent)', () => {
  assert.ok(/sourceKeyFromUrl\(src\)/.test(src),
    'the presign does not derive its key via sourceKeyFromUrl — re-dispatching '
    + 'an already-signed url would nest credentials instead of re-minting');
});

check('a non-S3 url is left alone rather than signed against the wrong bucket', () => {
  assert.ok(/if \(!k\) continue;/.test(src),
    'a null key does not skip — a legacy Supabase Storage url would be handed a '
    + 'grant for a bucket it does not live in');
});

check('a presign failure falls back to the stored url and is LOUD', () => {
  const m = /presign FAILED/.test(src);
  assert.ok(m, 'no loud log on presign failure — while sources/ is public this '
    + 'degrades invisibly, and after the restriction it is the failure that matters');
  assert.ok(/console\.error\(`\[dispatch\] \$\{label\} presign FAILED/.test(src),
    'the failure is not on console.error');
});

check('the grant is the SigV4 maximum, matching the upload presign', () => {
  const m = /SOURCE_GRANT_S = (\d+)/.exec(src);
  assert.ok(m, 'SOURCE_GRANT_S not found');
  assert.strictEqual(Number(m[1]), 604800,
    'a shorter grant reintroduces the UPLOAD_NEVER_STARTED class on the download '
    + 'side: a job respawned hours later would find its url expired');
});

// ── 4. IDEMPOTENCE, EXECUTED (not merely asserted in source) ───────────────
const { sourceKeyFromUrl } = require('./source-presence');
check('signing an already-signed url yields the SAME key', () => {
  const plain = 'https://d1iax8jos987n3.cloudfront.net/sources/abc-123/1787-file.mp4';
  const signed = `${plain}?Expires=1787519496&Key-Pair-Id=K2JCJMDEHXQW5F&Signature=abc%2Fdef`;
  const s3ish = `${plain}?X-Amz-Signature=deadbeef&X-Amz-Expires=604800`;
  const k = sourceKeyFromUrl(plain);
  assert.strictEqual(k, 'sources/abc-123/1787-file.mp4');
  assert.strictEqual(sourceKeyFromUrl(signed), k, 'a CF-signed url derives a different key');
  assert.strictEqual(sourceKeyFromUrl(s3ish), k, 'an S3-presigned url derives a different key');
});

if (failures.length) {
  console.error(`\n[smoke] FAILED: ${failures.length} dispatch-presign assertion(s)`);
  process.exit(1);
}
console.log('[smoke] dispatch presign: OK');

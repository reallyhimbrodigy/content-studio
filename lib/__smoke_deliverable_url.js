'use strict';

// EVERY COMPLETION WRITES A GRANT
//
// 6,200 of 6,210 stored rendered_video_url values were BARE permanent CloudFront
// links held by 5,121 users (88.7% of the last 24h). That is the single reason
// `renders/` cannot be restricted, and it makes writes-forward to a private
// render prefix INERT — the prefix would go private while completions kept
// writing urls that 403.
//
// The behaviour is asserted by EXECUTION (a fake s3, no AWS needed); the wiring
// is asserted against source, because what regresses is a new completion path
// storing `res.public_url` directly and never touching this module.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { toDeliverableUrl } = require('./deliverable-url');
const CDN = 'https://d1iax8jos987n3.cloudfront.net';
// The host guard reads CLOUDFRONT_DOMAIN and s3.S3_BUCKET; a fake s3 without a
// bucket would make every url look foreign and pass every test vacuously.
process.env.CLOUDFRONT_DOMAIN = 'd1iax8jos987n3.cloudfront.net';
const BUCKET = 'thisismybucketagainwooo';

const failures = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch((e) => { failures.push(`${name} — ${e.message}`); console.log(`  FAIL ${name} — ${e.message}`); });
}

const fakeS3 = (opts = {}) => ({
  S3_BUCKET: BUCKET,
  isConfigured: () => opts.configured !== false,
  createPresignedGetUrl: async (key, ttl) => {
    if (opts.throws) throw new Error('signer down');
    if (opts.empty) return null;
    fakeS3.lastTtl = ttl;
    return `${CDN}/${key}?Expires=1&Key-Pair-Id=K2WEEJG4C5B2OB&Signature=SIG`;
  },
});

(async () => {
  // ── BEHAVIOUR ────────────────────────────────────────────────────────────
  await check('a bare CDN url becomes a signed grant', async () => {
    const out = await toDeliverableUrl(`${CDN}/renders/job-1/1787-edited.mp4`, { s3: fakeS3() });
    assert.ok(/[?&]Signature=/.test(out), `not signed: ${out}`);
    assert.ok(out.includes('renders/job-1/1787-edited.mp4'), 'key not preserved');
  });

  await check('the grant is the SigV4 maximum (7 days)', async () => {
    await toDeliverableUrl(`${CDN}/renders/job-1/x.mp4`, { s3: fakeS3() });
    assert.strictEqual(fakeS3.lastTtl, 60 * 60 * 24 * 7);
  });

  await check('IDEMPOTENT — re-granting a signed url re-derives the same key', async () => {
    const once = await toDeliverableUrl(`${CDN}/renders/job-1/x.mp4`, { s3: fakeS3() });
    const twice = await toDeliverableUrl(once, { s3: fakeS3() });
    // the query is stripped before the key is derived, so no nesting
    assert.ok(!/Signature=SIG.*Signature=SIG/.test(twice), 'credentials nested');
    assert.strictEqual(new URL(twice).pathname, '/renders/job-1/x.mp4');
  });

  await check('a NEW private prefix is granted the same way', async () => {
    const out = await toDeliverableUrl(`${CDN}/renders-private/job-1/x.mp4`, { s3: fakeS3() });
    assert.ok(/[?&]Signature=/.test(out));
    assert.strictEqual(new URL(out).pathname, '/renders-private/job-1/x.mp4');
  });

  // ── PASS-THROUGH, never a wrong grant ────────────────────────────────────
  await check('a foreign host is left alone, not signed against our bucket', async () => {
    const foreign = 'https://legacy.supabase.co/storage/v1/object/public/v/x.mp4';
    // sourceKeyFromUrl returns a path for ANY http url, so the guard that matters
    // is that we never mint against a bucket the object does not live in. This is
    // the one case where a "helpful" grant would be actively wrong.
    const out = await toDeliverableUrl(foreign, { s3: fakeS3() });
    assert.strictEqual(out, foreign,
      `a foreign url was rewritten onto our CDN: ${out}`);
  });

  await check('a foreign S3 BUCKET is left alone', async () => {
    const other = 'https://someone-elses-bucket.s3.us-west-2.amazonaws.com/renders/x.mp4';
    assert.strictEqual(await toDeliverableUrl(other, { s3: fakeS3() }), other);
  });

  await check('a bare key (no scheme) is treated as ours and granted', async () => {
    const out = await toDeliverableUrl('renders/job-1/x.mp4', { s3: fakeS3() });
    assert.ok(/[?&]Signature=/.test(out), `bare key not granted: ${out}`);
  });

  await check('an s3:// url for OUR bucket is granted, a foreign one is not', async () => {
    const mine = await toDeliverableUrl(`s3://${BUCKET}/renders/job-1/x.mp4`, { s3: fakeS3() });
    assert.ok(/[?&]Signature=/.test(mine), 'our own s3:// url was not granted');
    const theirs = 's3://not-our-bucket/renders/job-1/x.mp4';
    assert.strictEqual(await toDeliverableUrl(theirs, { s3: fakeS3() }), theirs);
  });

  for (const [label, input] of [['null', null], ['undefined', undefined], ['empty', ''], ['non-string', 42]]) {
    await check(`${label} input passes through untouched`, async () => {
      assert.strictEqual(await toDeliverableUrl(input, { s3: fakeS3() }), input);
    });
  }

  await check('S3 not configured → pass through (dev/test never breaks)', async () => {
    const u = `${CDN}/renders/job-1/x.mp4`;
    assert.strictEqual(await toDeliverableUrl(u, { s3: fakeS3({ configured: false }) }), u);
  });

  // ── FAIL-OPEN, AND LOUD ──────────────────────────────────────────────────
  // A signing blip must never un-deliver a video that actually rendered — the
  // standing deliver-first rule. But it must be visible, because once the prefix
  // is private this is the failure that matters.
  await check('a signing failure falls back to the input AND logs on error', async () => {
    const u = `${CDN}/renders/job-1/x.mp4`;
    let logged = '';
    const out = await toDeliverableUrl(u, {
      s3: fakeS3({ throws: true }),
      log: { error: (m) => { logged += m; } },
    });
    assert.strictEqual(out, u, 'did not fall back — a rendered video would be un-delivered');
    assert.ok(/grant FAILED/.test(logged), 'the failure was silent');
    assert.ok(/renders\/job-1/.test(logged), 'the log does not name the key');
  });

  await check('an empty signer result falls back rather than storing null', async () => {
    const u = `${CDN}/renders/job-1/x.mp4`;
    assert.strictEqual(await toDeliverableUrl(u, { s3: fakeS3({ empty: true }) }), u);
  });

  // ── WIRING: every completion path routes through the chokepoint ──────────
  const root = path.join(__dirname, '..');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

  for (const f of ['lib/completion-reconcile.js',
                   'lib/video-processor/process-job.js',
                   'lib/video-processor/dispatch-to-modal.js']) {
    await check(`${f} routes its completion write through toDeliverableUrl`, async () => {
      const src = strip(fs.readFileSync(path.join(root, f), 'utf8'));
      assert.ok(/toDeliverableUrl\(/.test(src),
        'writes rendered_video_url without granting — a bare url here is a '
        + 'permanent public link and blocks restricting the render prefix');
    });
  }

  await check('the reconciler no longer stores result.public_url verbatim', async () => {
    const src = strip(fs.readFileSync(path.join(root, 'lib/completion-reconcile.js'), 'utf8'));
    // the dominant path, and the origin of all 6,200 bare urls
    assert.ok(!/rendered_video_url:\s*rawUrl\b/.test(src), 'stores the raw url');
    assert.ok(/rendered_video_url:\s*videoUrl\b/.test(src), 'no longer writes the granted variable');
    assert.ok(/toDeliverableUrl\(rawUrl/.test(src), 'the raw url is not passed through the grant');
  });

  await check('new renders are written to the RESTRICTED prefix, not renders/', async () => {
    const src = strip(fs.readFileSync(path.join(root, 'lib/video-processor/dispatch-to-modal.js'), 'utf8'));
    assert.ok(/s3OutputKey = `renders-private\/\$\{jobId\}/.test(src),
      'renders are still written to the public renders/ prefix — writes-forward is inert');
    assert.ok(/s3ThumbKey = `thumbnails\/\$\{jobId\}/.test(src),
      'thumbnails moved — they are public BY DECISION (og:image crawler caching)');
  });

  if (failures.length) {
    console.error(`\n[smoke] FAILED: ${failures.length} deliverable-url assertion(s)`);
    process.exit(1);
  }
  console.log('[smoke] every completion writes a grant: OK');
})();

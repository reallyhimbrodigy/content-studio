#!/usr/bin/env node
'use strict';
/**
 * s3_abort_mpu_lifecycle.js — reclaim abandoned multipart uploads.
 *
 * THE COST NOBODY HAS LOOKED AT. Every client upload goes through
 * initMultipartUpload (server.js:2245, key `sources/<userId>/<ts>-<file>`). If
 * the browser closes, the network drops, or the wall denies the job mid-flight,
 * the parts already PUT stay in S3 FOREVER, billed as storage, invisible in the
 * object listing. abortMultipartUpload exists but only runs when a client is
 * alive to call it — which is exactly not the abandoned case.
 *
 * The part URLs expire after 3600s, so an MPU that has not completed within an
 * hour can NEVER complete. It is dead the moment the hour passes.
 *
 * WHY THIS ACTION IS SAFE. AbortIncompleteMultipartUpload is the only lifecycle
 * action that CANNOT touch a completed object: it deletes uncommitted parts of
 * uploads that were never finished. No expiration, no transition, no versioning
 * change. A completed render, source, thumbnail or export is untouchable by it.
 *
 * WHY THE MERGE MATTERS MORE THAN THE RULE. PutBucketLifecycleConfiguration
 * REPLACES the bucket's entire configuration — it is not additive. Writing this
 * rule alone would silently delete every other lifecycle rule on the bucket.
 * Same shape as `modal secret create --force`, which is why this reads first,
 * merges, writes, then READS BACK and diffs.
 *
 *   node scripts/s3_abort_mpu_lifecycle.js            # READ-ONLY report
 *   node scripts/s3_abort_mpu_lifecycle.js --apply    # merge + write + verify
 */
const {
  S3Client, GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand, ListMultipartUploadsCommand,
} = require('@aws-sdk/client-s3');

const BUCKET = process.env.S3_BUCKET_NAME || 'thisismybucketagainwooo';
// us-west-2, RESOLVED via GetBucketLocation — not inherited from the server's
// AWS_REGION, which is us-west-1 and produces a PermanentRedirect against this
// bucket. The worker had it right all along ("AWS S3 OK (region=us-west-2)");
// content-studio's default is simply a different region that happens not to be
// where the data lives.
const REGION = process.env.S3_BUCKET_REGION || 'us-west-2';
const RULE_ID = 'abort-incomplete-multipart-uploads';
const DAYS = parseInt(process.env.MPU_ABORT_DAYS || '7', 10);
const APPLY = process.argv.includes('--apply');

const RULE = {
  ID: RULE_ID,
  Status: 'Enabled',
  // Bucket-wide ON PURPOSE. Abandoned MPUs are not confined to `sources/` —
  // the worker's boto3/s3-crt transfers switch to multipart above a size
  // threshold for exports/, thumbnails/ and HLS segments too. A prefix filter
  // would reclaim the uploads we happen to have thought of.
  Filter: { Prefix: '' },
  AbortIncompleteMultipartUpload: { DaysAfterInitiation: DAYS },
};

(async () => {
  const s3 = new S3Client({ region: REGION });
  console.log(`  bucket=${BUCKET} region=${REGION} rule=${RULE_ID} days=${DAYS}`);
  console.log(`  mode=${APPLY ? 'APPLY' : 'READ-ONLY'}\n`);

  // ── what is billing right now ──────────────────────────────────────────
  try {
    const mpu = await s3.send(new ListMultipartUploadsCommand({ Bucket: BUCKET, MaxUploads: 1000 }));
    const ups = mpu.Uploads || [];
    const now = Date.now();
    const old = ups.filter((u) => (now - new Date(u.Initiated).getTime()) > 3600e3);
    console.log(`  IN-FLIGHT MULTIPART UPLOADS: ${ups.length}`
      + (mpu.IsTruncated ? ' (TRUNCATED — there are more)' : ''));
    console.log(`  older than the 1h URL expiry (can never complete): ${old.length}`);
    const byPrefix = {};
    for (const u of old) {
      const p = String(u.Key || '').split('/')[0] || '(root)';
      byPrefix[p] = (byPrefix[p] || 0) + 1;
    }
    if (old.length) {
      console.log(`  by prefix: ${JSON.stringify(byPrefix)}`);
      const oldest = old.reduce((a, b) =>
        new Date(a.Initiated) < new Date(b.Initiated) ? a : b);
      console.log(`  oldest: ${oldest.Key} initiated ${oldest.Initiated}`);
    }
  } catch (e) {
    console.log(`  (could not list multipart uploads: ${e.name} — ${e.message})`);
  }

  // ── existing lifecycle config: READ BEFORE WRITE ───────────────────────
  let existing = [];
  try {
    const cur = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET }));
    existing = cur.Rules || [];
  } catch (e) {
    if (e.name === 'NoSuchLifecycleConfiguration') existing = [];
    else { console.error(`  FAILED to read lifecycle config: ${e.name}`); process.exit(2); }
  }
  console.log(`\n  existing lifecycle rules: ${existing.length}`);
  for (const r of existing) {
    console.log(`    - ${r.ID} [${r.Status}] `
      + `${r.AbortIncompleteMultipartUpload ? 'abortMPU=' + r.AbortIncompleteMultipartUpload.DaysAfterInitiation + 'd ' : ''}`
      + `${r.Expiration ? 'EXPIRATION=' + JSON.stringify(r.Expiration) + ' ' : ''}`
      + `${r.Transitions ? 'transitions=' + r.Transitions.length : ''}`);
  }

  const already = existing.find((r) => r.ID === RULE_ID);
  if (already && already.AbortIncompleteMultipartUpload?.DaysAfterInitiation === DAYS
      && already.Status === 'Enabled') {
    console.log('\n  RULE ALREADY PRESENT AND CORRECT — nothing to do.');
    return;
  }
  const merged = existing.filter((r) => r.ID !== RULE_ID).concat([RULE]);
  console.log(`\n  merged config would carry ${merged.length} rule(s) `
    + `(${existing.length} existing preserved, 1 ${already ? 'updated' : 'added'})`);

  if (!APPLY) {
    console.log('\n  READ-ONLY. Re-run with --apply to write. Nothing was changed.');
    return;
  }

  await s3.send(new PutBucketLifecycleConfigurationCommand({
    Bucket: BUCKET, LifecycleConfiguration: { Rules: merged },
  }));

  // ── READ BACK. A write that is not verified is a claim, not a change. ──
  const after = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET }));
  const got = after.Rules || [];
  const mine = got.find((r) => r.ID === RULE_ID);
  const lostIds = existing.map((r) => r.ID).filter((id) => id !== RULE_ID
    && !got.some((r) => r.ID === id));
  console.log(`\n  READBACK: ${got.length} rule(s)`);
  console.log(`    our rule present : ${!!mine}`
    + (mine ? ` (abortMPU=${mine.AbortIncompleteMultipartUpload?.DaysAfterInitiation}d, ${mine.Status})` : ''));
  console.log(`    pre-existing rules DROPPED: ${lostIds.length ? lostIds.join(', ') : 'none'}`);
  if (!mine || lostIds.length) {
    console.error('  VERIFY FAILED — investigate before trusting this bucket.');
    process.exit(1);
  }
  console.log('\n  APPLIED AND VERIFIED.');
})().catch((e) => { console.error('FAILED:', e.name, e.message); process.exit(1); });

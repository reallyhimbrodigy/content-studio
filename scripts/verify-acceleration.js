#!/usr/bin/env node
'use strict';
// IS THE ACCELERATE ENDPOINT ACTUALLY DOING ANYTHING? Read-only.
//
//   render shell promptly -> node scripts/verify-acceleration.js
//
// ── WHY THIS IS A SCRIPT AND NOT AN ASSERTION ───────────────────────────────
// The code has signed accelerate URLs since it was written: S3_USE_ACCELERATE
// defaults to 'true' and s3SigningClient is built with useAccelerateEndpoint.
// That is a claim about OUR side. Acceleration is a BUCKET setting, applied
// with put-bucket-accelerate-configuration, and nothing in this repo can turn
// it on. So there are three independent facts and they can disagree:
//
//   1. the FLAG        S3_USE_ACCELERATE in this process's env
//   2. the SIGNATURE   the host a presigned URL actually carries
//   3. the BUCKET      what GetBucketAccelerateConfiguration returns
//
// A flag that is on, a URL that says s3-accelerate, and a bucket that is
// Suspended is a live failure — every PUT goes to an endpoint the bucket does
// not answer on. Only reading all three separates it from "working".
//
// ── IT NEVER PRINTS THE PRESIGNED URL ───────────────────────────────────────
// A presigned PUT URL IS A CREDENTIAL: anyone holding it can write that key
// until it expires, and this one is signed for the SigV4 maximum. The host is
// the entire question, so only the host is printed. A terminal buffer gets
// pasted, and 7 days is a long time to have handed someone a write.
//
// ── A PRE-REGISTERED EXPECTATION, SO THE RESULT CANNOT BE READ BACKWARDS ────
// 1,550 upload_completed events landed in the last 7 days. If the flag were
// on and the bucket were NOT accelerated, every upload would fail, not 14 of
// them. So this run should find either an accelerated bucket or the flag off.
// A third answer would mean the successes are arriving some way I have not
// modelled — worth more than the check itself, and I want that written down
// before the number, not after.

const {
  S3Client,
  GetBucketAccelerateConfigurationCommand,
  PutObjectCommand,
  HeadBucketCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = process.env.S3_BUCKET_NAME || '';
const REGION = process.env.AWS_REGION || 'us-west-1';
const FLAG_RAW = process.env.S3_USE_ACCELERATE;
const FLAG = String(FLAG_RAW === undefined ? 'true' : FLAG_RAW).toLowerCase() === 'true';

if (!BUCKET || !process.env.AWS_ACCESS_KEY_ID) {
  console.error('S3_BUCKET_NAME / AWS_ACCESS_KEY_ID must be set. Run in the Render shell.');
  process.exit(2);
}

const creds = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};

(async () => {
  console.log('\n── 1. THE FLAG ─────────────────────────────────────────────');
  console.log(`  S3_USE_ACCELERATE = ${FLAG_RAW === undefined
    ? '(unset -> defaults to true)' : JSON.stringify(FLAG_RAW)}  -> ${FLAG}`);
  console.log(`  AWS_REGION        = ${REGION}`);
  console.log(`  bucket            = ${BUCKET}`);

  // ACCELERATION REQUIRES A DNS-COMPLIANT NAME WITH NO DOTS. A bucket with a
  // dot cannot be accelerated at all, and the failure is a TLS/virtual-host
  // error rather than an S3 error code — which reads as a network problem.
  const dots = BUCKET.includes('.');
  console.log(`  name has a dot    = ${dots}${dots
    ? '   <-- ACCELERATION IS IMPOSSIBLE ON THIS NAME' : '   (ok for acceleration)'}`);

  console.log('\n── 2. THE SIGNATURE (host only — the URL is a credential) ──');
  let signedHost = null;
  try {
    const signer = new S3Client({
      region: REGION, credentials: creds,
      ...(FLAG ? { useAccelerateEndpoint: true } : {}),
    });
    const url = await getSignedUrl(signer, new PutObjectCommand({
      Bucket: BUCKET, Key: `__accel_probe/${Date.now()}.bin`,
    }), { expiresIn: 60 });
    signedHost = new URL(url).host;
    console.log(`  presigned PUT host = ${signedHost}`);
    console.log(`  is accelerate      = ${signedHost.includes('s3-accelerate')}`);
  } catch (e) {
    console.log(`  presign FAILED: ${e.message}`);
  }

  console.log('\n── 3. THE BUCKET ───────────────────────────────────────────');
  let status = null;
  try {
    // Read against the REGIONAL client: the accelerate endpoint does not
    // serve bucket-configuration reads, so asking it would fail for a reason
    // that has nothing to do with the answer.
    const plain = new S3Client({ region: REGION, credentials: creds });
    const r = await plain.send(new GetBucketAccelerateConfigurationCommand({ Bucket: BUCKET }));
    // ABSENT IS A STATE. An unset configuration returns NO Status field at
    // all, which is "never enabled" — not "Suspended", and not an error.
    status = r.Status || 'ABSENT (never configured)';
    console.log(`  GetBucketAccelerateConfiguration.Status = ${status}`);
    const head = await plain.send(new HeadBucketCommand({ Bucket: BUCKET }));
    const actual = head.$metadata?.httpHeaders?.['x-amz-bucket-region'];
    if (actual) console.log(`  bucket actually lives in                = ${actual}`);
  } catch (e) {
    console.log(`  bucket read FAILED: ${e.name || ''} ${e.message}`);
    console.log('  (a failure here is NOT "not accelerated" — it is this read failing)');
  }

  console.log('\n── VERDICT ─────────────────────────────────────────────────');
  const enabled = status === 'Enabled';
  const signing = Boolean(signedHost && signedHost.includes('s3-accelerate'));
  if (signing && enabled) {
    console.log('  ACCELERATED AND WORKING. Uploads take the AWS edge network.');
    console.log('  The far-from-Oregon latency is NOT an acceleration gap; look at');
    console.log('  part size and concurrency next.');
  } else if (signing && !enabled) {
    console.log('  *** LIVE FAILURE *** We sign accelerate URLs and the bucket is not');
    console.log(`  accelerated (Status=${status}). Every PUT is aimed at an endpoint`);
    console.log('  this bucket does not answer on.');
    console.log('  BUT CHECK THE DENOMINATOR BEFORE BELIEVING IT: 1,550 uploads');
    console.log('  completed in the last 7 days. If this were true for all traffic');
    console.log('  none of them could have landed, so either the flag differs in the');
    console.log('  web process, or the successes arrive some way this does not model.');
  } else if (!signing && enabled) {
    console.log('  MONEY ON THE TABLE. The bucket IS accelerated and we are signing');
    console.log('  plain regional URLs, so nobody is getting the edge network and we');
    console.log('  may be paying the acceleration line item for nothing.');
    console.log('  Fix: S3_USE_ACCELERATE=true, then redeploy — a secret flip is not');
    console.log('  live until a redeploy.');
  } else {
    console.log('  PLAIN REGIONAL, CONSISTENTLY. Not broken, and not accelerated.');
    console.log(`  Uploads from South Asia cross the Pacific to ${REGION} on the open`);
    console.log('  internet. This is the state acceleration exists to fix.');
  }
  console.log('');
  process.exit(0);
})().catch((e) => { console.error('unhandled:', (e && e.stack) || e); process.exit(1); });

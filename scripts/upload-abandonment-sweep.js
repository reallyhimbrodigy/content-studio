#!/usr/bin/env node
'use strict';

/**
 * upload-abandonment-sweep.js — the silent 62% of upload loss, measured server-side.
 *
 * WHY THIS EXISTS. 1,128 users/week are lost before a job row exists: 80% of ALL
 * delivery loss. 38% of that fires `upload_failed`; the other 62% is silent — and
 * it is silent for a STRUCTURAL reason, not a missing event. `upload_failed` is
 * emitted from BackgroundUploadManager / ResumableMultipartUploader, so when iOS
 * terminates a backgrounded app the process dies WITH the reporting code inside
 * it. A client event cannot report a failure that kills the client, and shipping
 * more client events would only re-measure the population that already reports.
 *
 * An abandoned S3 multipart upload is a DURABLE SERVER-SIDE ARTIFACT. Every
 * upload that started and never finished leaves parts in the bucket. No client
 * cooperation, no App Store build, no waiting on adoption.
 *
 * `bytes_uploaded` is the number this exists to produce — it names the largest
 * loss in the product by saying HOW FAR each dead upload got, which nothing
 * records today for a silent loss.
 *
 * ── READ-ONLY, STRUCTURALLY ────────────────────────────────────────────────
 * This tool lists. It NEVER aborts, deletes or completes an upload. Those parts
 * are a user's video mid-flight and some are still in progress. The guard is not
 * a comment: assertReadOnly() below fails the run if any mutating S3 command is
 * reachable from this file. Aborting abandoned uploads may well be correct — it
 * is a BUILDER change with an owner decision behind it, never a side effect of
 * measuring.
 *
 * Usage:
 *   node upload-abandonment-sweep.js                 # discovery: group by prefix
 *   node upload-abandonment-sweep.js --prefix uploads/   # once BUILDER confirms
 *   node upload-abandonment-sweep.js --json          # machine output
 *
 * Env: S3_BUCKET_NAME, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *      SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (optional — enables the
 *      reported-vs-silent split)
 */

const {
  S3Client, ListMultipartUploadsCommand, ListPartsCommand,
} = require('@aws-sdk/client-s3');

// ── THE READ-ONLY GUARD ────────────────────────────────────────────────────
// Not advice. If a mutating command is ever imported into this file, the run
// dies before it touches the bucket.
const FORBIDDEN = [
  'AbortMultipartUploadCommand', 'CompleteMultipartUploadCommand',
  'DeleteObjectCommand', 'DeleteObjectsCommand', 'PutObjectCommand',
  'UploadPartCommand', 'CreateMultipartUploadCommand',
];
function assertReadOnly() {
  const src = require('fs').readFileSync(__filename, 'utf8');
  // Look for real imports/uses, not the FORBIDDEN list itself.
  const body = src.replace(/const FORBIDDEN = \[[\s\S]*?\];/, '');
  const hit = FORBIDDEN.filter((c) => body.includes(c));
  if (hit.length) {
    console.error(`REFUSING TO RUN — mutating S3 command(s) reachable: ${hit.join(', ')}.`);
    console.error('This sweep measures; it does not modify. Aborting abandoned uploads is a');
    console.error('BUILDER change with an owner decision behind it, never a measurement side effect.');
    process.exit(2);
  }
}

const args = process.argv.slice(2);
const PREFIX = (args.find((a) => a.startsWith('--prefix=')) || '').split('=')[1]
  || (args.includes('--prefix') ? args[args.indexOf('--prefix') + 1] : '');
const AS_JSON = args.includes('--json');
const BUCKET = process.env.S3_BUCKET_NAME;

// S3 Standard, us-east-1 list price. Abandoned parts are BILLED until aborted.
const S3_GB_MONTH = 0.023;

const pct = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(q * (arr.length - 1)))] : 0);
const mb = (b) => b / (1024 * 1024);

async function listAllUploads(s3) {
  const out = [];
  let KeyMarker, UploadIdMarker;
  do {
    const r = await s3.send(new ListMultipartUploadsCommand({
      Bucket: BUCKET, Prefix: PREFIX || undefined, KeyMarker, UploadIdMarker, MaxUploads: 1000,
    }));
    for (const u of r.Uploads || []) out.push(u);
    KeyMarker = r.NextKeyMarker; UploadIdMarker = r.NextUploadIdMarker;
    if (!r.IsTruncated) break;
  } while (KeyMarker || UploadIdMarker);
  return out;
}

async function partsFor(s3, Key, UploadId) {
  let n = 0, bytes = 0, PartNumberMarker;
  do {
    const r = await s3.send(new ListPartsCommand({
      Bucket: BUCKET, Key, UploadId, PartNumberMarker, MaxParts: 1000,
    }));
    for (const p of r.Parts || []) { n += 1; bytes += p.Size || 0; }
    PartNumberMarker = r.NextPartNumberMarker;
    if (!r.IsTruncated) break;
  } while (PartNumberMarker);
  return { parts: n, bytes };
}

(async () => {
  assertReadOnly();
  if (!BUCKET) {
    console.error('S3_BUCKET_NAME unset — cannot sweep. Not a zero: UNKNOWN.');
    process.exit(2);
  }
  const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

  const uploads = await listAllUploads(s3);
  if (!uploads.length) {
    console.log(`No in-flight or abandoned multipart uploads under ${PREFIX ? `prefix "${PREFIX}"` : 'the whole bucket'}.`);
    console.log('THIS IS NOT A ZERO-LOSS RESULT. It means either the prefix is wrong, or a');
    console.log('lifecycle rule already expires abandoned parts — in which case the artifact');
    console.log('this sweep depends on is being deleted before it can be measured, and the');
    console.log('silent 62% needs a different instrument. Confirm which before reporting.');
    process.exit(0);
  }

  const now = Date.now();
  const rows = [];
  for (const u of uploads) {
    const { parts, bytes } = await partsFor(s3, u.Key, u.UploadId);
    rows.push({
      key: u.Key,
      prefix: String(u.Key).split('/')[0] + '/',
      initiated_at: u.Initiated,
      age_h: (now - new Date(u.Initiated).getTime()) / 3.6e6,
      parts, bytes,
    });
  }

  // AGE SPLIT — an in-flight upload is not an abandoned one. 6h is generous
  // against a resumable uploader; anything older is not coming back.
  const ABANDONED_H = 6;
  const dead = rows.filter((r) => r.age_h >= ABANDONED_H);
  const live = rows.filter((r) => r.age_h < ABANDONED_H);

  if (AS_JSON) { console.log(JSON.stringify({ rows, dead: dead.length, live: live.length }, null, 1)); return; }

  console.log(`\n=== UPLOAD ABANDONMENT SWEEP — bucket ${BUCKET}${PREFIX ? `, prefix ${PREFIX}` : ' (ALL prefixes)'}`);
  console.log(`  multipart uploads open: ${rows.length}   in-flight (<${ABANDONED_H}h): ${live.length}   ABANDONED (>=${ABANDONED_H}h): ${dead.length}\n`);

  if (!PREFIX) {
    console.log('PREFIX DISCOVERY — confirm which of these is the user-upload path:');
    const byP = new Map();
    for (const r of rows) {
      const c = byP.get(r.prefix) || { n: 0, bytes: 0 };
      c.n += 1; c.bytes += r.bytes; byP.set(r.prefix, c);
    }
    for (const [p, c] of [...byP.entries()].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${p.padEnd(28)} ${String(c.n).padStart(6)} uploads   ${mb(c.bytes).toFixed(1)} MB`);
    }
    console.log('');
  }

  // ── THE HEADLINE: bytes_uploaded distribution ─────────────────────────────
  const b = dead.map((r) => r.bytes).sort((x, y) => x - y);
  const zero = dead.filter((r) => r.bytes === 0).length;
  console.log('bytes_uploaded — HOW FAR EACH DEAD UPLOAD GOT (the number this sweep exists for):');
  console.log(`  n=${b.length}   zero-byte: ${zero} (${b.length ? (100 * zero / b.length).toFixed(1) : '0.0'}%)`);
  for (const [l, q] of [['min', 0], ['p10', 0.10], ['p25', 0.25], ['p50', 0.50], ['p75', 0.75], ['p90', 0.90], ['max', 1]]) {
    console.log(`  ${l.padEnd(5)} ${mb(pct(b, q)).toFixed(2)} MB`);
  }

  console.log('\nPRE-REGISTERED READS (locked before the data — see UPLOAD_INSTRUMENTATION_SPEC.md):');
  const p50 = mb(pct(b, 0.50));
  const zeroShare = b.length ? zero / b.length : 0;
  if (zeroShare >= 0.5) {
    console.log('  -> INITIATION FAILURE dominates: most dead uploads moved ZERO bytes. The target');
    console.log('     is permissions / disk / Photos export ("Export failed: Disk Full", PHPhotos');
    console.log('     errors), NOT network or background-transfer robustness.');
  } else if (p50 > 0.5) {
    console.log('  -> TRANSFER DEATH dominates: dead uploads moved real bytes before stopping.');
    console.log('     Consistent with background_orphan (73% of reported failures); the target is');
    console.log('     background-transfer robustness.');
  } else {
    console.log('  -> MIXED / inconclusive at this n. Report the distribution, name no single mode.');
  }

  // COST — abandoned parts are billed storage until aborted.
  const deadBytes = dead.reduce((a, r) => a + r.bytes, 0);
  console.log(`\nCOST SIDE: ${mb(deadBytes).toFixed(1)} MB of abandoned parts held`
    + ` = $${(deadBytes / 1073741824 * S3_GB_MONTH).toFixed(2)}/mo at S3 Standard.`);
  console.log('  Billed until aborted. If this grows sweep-over-sweep there is no lifecycle rule,');
  console.log('  and it becomes the first cost-board line CAUSED BY the delivery-rate defect.');

  console.log('\nSTILL OWED — the reported-vs-silent split. It needs the user id, which lives in');
  console.log('the key convention BUILDER has not confirmed yet. Once the prefix is known, join');
  console.log('these keys to analytics_events on upload_failed to split REPORTED from SILENT on');
  console.log('the SAME population — that is what tests the same-mode hypothesis instead of');
  console.log('assuming it, and it is the half of the spec this run does not deliver.');
})().catch((e) => { console.error('SWEEP FAILED (not a zero):', e && e.message); process.exit(2); });

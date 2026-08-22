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
 *   node upload-abandonment-sweep.js --from-snapshot <file.json>  # replay, no AWS
 *
 * Env: S3_BUCKET_NAME, S3_BUCKET_REGION (NOT AWS_REGION — see the region note
 *      below), AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
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
let REPLAY_BUCKET = null;   // set in --from-snapshot mode so the header is honest

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

// ── SNAPSHOT REPLAY ────────────────────────────────────────────────────────
// A lifecycle rule was applied 2026-08-22 and now aborts abandoned uploads, so
// the bucket DRAINS: every live sweep from here reads a post-lifecycle regime
// and is NOT comparable to the pre-lifecycle baseline. BUILDER captured the full
// inventory first. Replaying it keeps the measurement REPRODUCIBLE rather than
// merely archived — the finding can be re-derived and re-checked after the
// evidence itself is gone.
function loadSnapshot(file) {
  const d = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  const ups = Array.isArray(d) ? d : (d.uploads || d.Uploads || d.rows || []);
  const now = d.captured_at ? new Date(d.captured_at).getTime() : Date.now();
  return {
    meta: d,
    rows: ups.map((u) => ({
      key: u.Key || u.key,
      prefix: String(u.Key || u.key).split('/')[0] + '/',
      initiated_at: u.Initiated || u.initiated_at,
      age_h: (now - new Date(u.Initiated || u.initiated_at).getTime()) / 3.6e6,
      parts: u.parts || 0,
      bytes: u.bytes || 0,
    })),
  };
}

(async () => {
  assertReadOnly();

  const snapIdx = args.indexOf('--from-snapshot');
  if (snapIdx !== -1) {
    const f = args[snapIdx + 1];
    const { meta, rows } = loadSnapshot(f);
    console.log(`\n=== REPLAY from ${f}`);
    console.log(`  captured_at ${meta.captured_at || '?'}  bucket ${meta.bucket || '?'}  region ${meta.region || '?'}`);
    console.log('  PRE-LIFECYCLE BASELINE. A lifecycle rule now aborts abandoned uploads, so');
    console.log('  live sweeps read a DIFFERENT REGIME and must not be compared to this.\n');
    REPLAY_BUCKET = meta.bucket || '(from snapshot)';
    report(rows);
    return;
  }

  if (!BUCKET) {
    console.error('S3_BUCKET_NAME unset — cannot sweep. Not a zero: UNKNOWN.');
    process.exit(2);
  }
  // REGION IS PINNED, AND BOTH OLD FALLBACKS WERE WRONG. The bucket is
  // us-west-2; content-studio's AWS_REGION is us-west-1 and the previous default
  // was us-east-1 — BOTH return PermanentRedirect. A redirect swallowed as an
  // empty list reads as "no abandoned uploads", the sweep is marked complete, a
  // lifecycle rule aborts 448 uploads (the oldest billing since 2026-05-02), and
  // the bytes_uploaded distribution is destroyed before it is ever measured.
  // A wrong region must NEVER be able to look like a clean zero.
  const REGION = process.env.S3_BUCKET_REGION || 'us-west-2';
  const s3 = new S3Client({ region: REGION });

  // REACHABILITY PROBE BEFORE INTERPRETING ANYTHING. HeadBucket surfaces
  // PermanentRedirect as an error instead of letting it degrade into silence.
  try {
    const { HeadBucketCommand } = require('@aws-sdk/client-s3');
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch (e) {
    const code = e && (e.name || e.Code || '');
    const hinted = e && (e.$metadata?.headers?.['x-amz-bucket-region']
      || e.BucketRegion || '');
    console.error(`REGION UNCONFIRMED — HeadBucket(${BUCKET}) failed in ${REGION}: ${code}`);
    if (hinted) console.error(`  S3 says the bucket lives in: ${hinted} — re-run with S3_BUCKET_REGION=${hinted}`);
    console.error('  RESULT IS UNKNOWN, NOT ZERO. Do not mark this sweep complete and do not');
    console.error('  let any lifecycle rule act on an unmeasured bucket.');
    process.exit(2);
  }

  const uploads = await listAllUploads(s3);
  if (!uploads.length) {
    console.log(`No in-flight or abandoned multipart uploads under ${PREFIX ? `prefix "${PREFIX}"` : 'the whole bucket'}.`);
    console.log('THIS IS NOT A ZERO-LOSS RESULT. It means either the prefix is wrong, or a');
    console.log('lifecycle rule already expires abandoned parts — in which case the artifact');
    console.log('this sweep depends on is being deleted before it can be measured, and the');
    console.log('silent 62% needs a different instrument. Confirm which before reporting.');
    // EXIT 2, NOT 0. An empty list is UNKNOWN until proven to mean zero — the same
    // rigour the missing-bucket path already applied. A 0 here gets marked complete.
    process.exit(2);
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
  report(rows);
})().catch((e) => { console.error('SWEEP FAILED (not a zero):', e && e.message); process.exit(2); });

// Shared by the live sweep and by --from-snapshot, so a replay of the
// pre-lifecycle inventory produces byte-identical analysis to the live run.
function report(rows) {
  // AGE SPLIT — an in-flight upload is not an abandoned one. 6h is generous
  // against a resumable uploader; anything older is not coming back.
  const ABANDONED_H = 6;
  const dead = rows.filter((r) => r.age_h >= ABANDONED_H);
  const live = rows.filter((r) => r.age_h < ABANDONED_H);

  if (AS_JSON) { console.log(JSON.stringify({ rows, dead: dead.length, live: live.length }, null, 1)); return; }

  console.log(`\n=== UPLOAD ABANDONMENT SWEEP — bucket ${REPLAY_BUCKET || BUCKET}${PREFIX ? `, prefix ${PREFIX}` : ' (ALL prefixes)'}`);
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

  // RULE 7 — cut by USER, never by upload. A user who abandons five uploads is
  // ONE lost user, not five failures. Convention confirmed 2026-08-22:
  // sources/${userId}/${timestamp}-${fileName}
  const byUser = new Map();
  for (const r of dead) {
    const p = String(r.key).split('/');
    if (p[0] !== 'sources' || p.length < 3) continue;
    byUser.set(p[1], (byUser.get(p[1]) || 0) + 1);
  }
  if (byUser.size) {
    const per = [...byUser.values()].sort((a, b) => a - b);
    console.log(`\nBY USER (Rule 7): ${byUser.size} DISTINCT USERS lost, not ${dead.length} failures.`);
    console.log(`  abandoned uploads per affected user: p50=${per[Math.floor(per.length / 2)]}  max=${per[per.length - 1]}`);
    console.log('  Join these user ids to analytics_events on upload_failed to split REPORTED');
    console.log('  from SILENT on the SAME population — see DELIVERY_RATE.md. Measured 2026-08-22:');
    console.log('  10.7% reported / 89.3% SILENT, and the two bytes_uploaded profiles MATCH');
    console.log('  (56.0% vs 64.2% zero-byte) — one mode, not two defects.');
  }
}

'use strict';
// GATE: account deletion is ordered, resumable, and leaves a receipt.
//
// THE HANDLER THIS REPLACES HAD THE ORDER INVERTED — rows and the auth user
// first, S3 best-effort last. The keys live in video_jobs, so a failed S3 pass
// lost the only record of which objects existed and the videos stayed in the
// bucket permanently, attached to nobody.

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'account-deletion.js'), 'utf8');
const mod = require('./account-deletion');

const fail = [];
const check = (l, c, d) => { if (!c) fail.push(l + (d ? `  :: ${d}` : '')); };

// ── ORDER, forced by the foreign keys ─────────────────────────────────────
// video_jobs.user_id and chats.user_id are ON DELETE SET NULL: deleting the
// auth user first does not remove them, it ORPHANS them by nulling the only
// column that says whose they were.
const S = mod.STAGES;
check('S3 runs before rows', S.indexOf('s3') < S.indexOf('rows'),
  'rows hold the keys; deleting them first loses the objects forever');
check('rows run before the auth user', S.indexOf('rows') < S.indexOf('auth'),
  'ON DELETE SET NULL orphans rather than deletes');
check('the auth user is last', S.indexOf('auth') === S.length - 2);

// ── KEYS CAPTURED BEFORE ANY DELETION ─────────────────────────────────────
check('keys are persisted at enqueue time',
  /enqueueAccountDeletion[\s\S]*?s3_keys: s3Keys/.test(src),
  'after video_jobs is gone the keys are unrecoverable');
check('the run reads keys from the receipt, not from video_jobs',
  /row\.s3_keys/.test(src));

// ── EVERY URL COLUMN, not just the obvious three ──────────────────────────
for (const col of ['video_url', 'proxy_video_url', 'rendered_video_url',
                   'thumbnail_url', 'hls_manifest_url', 'result_url']) {
  check(`collects ${col}`, src.includes(col));
}

// ── A FAILED OBJECT STOPS THE RUN ─────────────────────────────────────────
check('S3 failure halts before rows are deleted',
  /s3Failed > 0[\s\S]{0,400}?stage: 'failed'/.test(src),
  'proceeding would delete the keys for objects that survived');

// ── GRANTS SCRUBBED, NOT DELETED ──────────────────────────────────────────
// device_id is the anti-abuse record: delete it and the device gets a fresh 30
// credits on the next signup.
check('free_credit_grants is UPDATEd, never deleted',
  /free_credit_grants'\)\s*\.update\(\{ user_id: null \}\)/.test(src));
check('no delete on free_credit_grants',
  !/from\('free_credit_grants'\)[\s\S]{0,60}\.delete\(/.test(src),
  'deleting the grant hands the device a fresh 30 credits');

// ── RESUMABLE, not restartable ────────────────────────────────────────────
check('it resumes from the recorded stage', /const from = Math\.max\(at\(row\.stage\)/.test(src));
check('an already-done deletion is a no-op', /alreadyDone: true/.test(src));
check('already-deleted auth user counts as success', /not found/.test(src));
check('there is a sweep for interrupted runs', typeof mod.sweepAccountDeletions === 'function');

// ── THE RECEIPT — the property the whole approach was chosen for ──────────
check('the receipt records object and row counts',
  /s3_deleted/.test(src) && /rows_deleted/.test(src));
check('completion is logged with the counts',
  /\[account-deletion\] DONE user=/.test(src),
  'without it you cannot prove a given user\'s content is gone');

// ── NO COSTED STUB ────────────────────────────────────────────────────────
check('video_jobs rows are deleted entirely',
  /del\('video_jobs', 'user_id', userId\)/.test(src));
check('spend is documented as living in daily_spend', src.includes('daily_spend'));

if (fail.length) {
  console.error(`❌ account deletion job (${fail.length}):`);
  fail.forEach((f) => console.error('   - ' + f));
  process.exit(1);
}
console.log('✅ account deletion job: ordered, resumable, receipted');

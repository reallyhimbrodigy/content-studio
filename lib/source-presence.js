'use strict';

// ── Source presence: never spawn a render for a video that isn't there ───────
//
// THE DEFECT (2026-08-02): a job row was created and a Modal worker SPAWNED
// before anyone checked that the source object existed. The worker then HEAD-
// polled S3 for up to 600s and failed UPLOAD_STALLED. In the 7 days to
// 2026-08-02 that was 94 jobs — 60% of ALL failures — each holding a
// cpu=16/64GiB container for the full budget (~$0.62/job, ~$250/mo) to discover
// something one HEAD request answers in 50ms.
//
// Worse for the user: the copy said "your upload was interrupted, check your
// connection", which sends them straight back to the SAME dead key. Our first
// paying subscriber created three separate jobs against one key that never
// existed, over 6.5 hours, and was refunded three times. A fresh pick mints a
// fresh key; that is the only action that actually works, so it is now the only
// action we suggest.
//
// WHAT THIS MODULE DOES NOT DO: it does not make a failing upload succeed. That
// half is client-side. This makes the failure instant, free, honest, and
// non-repeating.

const s3 = require('../services/s3');

// The worker's own poll budget. Kept at 600s deliberately (Zac 2026-08-02): the
// only argument for shortening was cost, and moving the wait off Modal removes
// it. Killing a slow-but-working upload on a poor mobile connection is strictly
// worse than a long wait, and the traffic is India-heavy.
const SOURCE_WAIT_MS = Number(process.env.SOURCE_WAIT_MS || 600_000);

// Upload-family terminal codes. A job that ended in one of these proves its
// source key never materialised.
const DEAD_SOURCE_CODES = ['UPLOAD_NEVER_STARTED', 'UPLOAD_STALLED', 'UPLOAD_TIMEOUT'];

/**
 * S3 object key from any of the URL shapes we store (CloudFront, s3://,
 * virtual-host, or a bare key). Returns null when it cannot be determined —
 * callers must treat null as "cannot check", never as "missing".
 */
function sourceKeyFromUrl(videoUrl) {
  const u = String(videoUrl || '').trim();
  if (!u) return null;
  if (!/^(https?:|s3:)/i.test(u)) return u.replace(/^\/+/, '') || null;
  try {
    if (/^s3:/i.test(u)) return u.replace(/^s3:\/\/[^/]+\//i, '') || null;
    const { pathname } = new URL(u);
    const key = decodeURIComponent(pathname.replace(/^\/+/, ''));
    return key || null;
  } catch {
    return null;
  }
}

/**
 * Has this exact source URL already died an upload death for this user?
 *
 * Derived from video_jobs rather than a new table, so it is durable across
 * restarts and needs no migration. This is what breaks the retry loop: a key
 * that has already failed HEAD can never be worth another 600s.
 */
async function findDeadSourceJob(supabaseAdmin, userId, videoUrl) {
  if (!supabaseAdmin || !userId || !videoUrl) return null;
  try {
    const { data } = await supabaseAdmin
      .from('video_jobs')
      .select('id, created_at, result')
      .eq('user_id', userId)
      .eq('video_url', videoUrl)
      .eq('status', 'failed')
      .order('created_at', { ascending: false })
      .limit(5);
    for (const row of data || []) {
      const code = (row.result && (row.result.error_code || row.result.code)) || '';
      if (DEAD_SOURCE_CODES.includes(String(code))) return row;
    }
    return null;
  } catch {
    return null;   // never block a job because the lookup failed
  }
}

/**
 * Wait for the source to appear, SERVER-SIDE — no Modal container running.
 *
 * Backoff is front-loaded: a healthy upload that is already finished answers on
 * the first HEAD, and the common "still uploading" case resolves in the first
 * few seconds. Returns {present:true} | {present:false, reason} — and
 * {present:true, unknown:true} whenever S3 could not answer, because an
 * unmeasurable check must fail OPEN and let the render proceed rather than
 * reject every upload during an S3 blip.
 */
async function waitForSource(key, { budgetMs = SOURCE_WAIT_MS, log = () => {} } = {}) {
  if (!key) return { present: true, unknown: true, reason: 'no_key' };
  const deadline = Date.now() + budgetMs;
  let delay = 500;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const exists = await s3.objectExists(key);
    if (exists === null) return { present: true, unknown: true, reason: 'unmeasurable', attempts };
    if (exists) return { present: true, attempts, waitedMs: budgetMs - (deadline - Date.now()) };
    if (Date.now() >= deadline) {
      return { present: false, attempts, reason: 'deadline', waitedMs: budgetMs };
    }
    if (attempts === 1 || attempts % 20 === 0) {
      log(`source not yet on S3 (attempt ${attempts}, ${Math.round((deadline - Date.now()) / 1000)}s left)`);
    }
    await new Promise((r) => setTimeout(r, Math.min(delay, Math.max(0, deadline - Date.now()))));
    delay = Math.min(delay * 1.5, 5_000);
  }
}

module.exports = {
  SOURCE_WAIT_MS,
  DEAD_SOURCE_CODES,
  sourceKeyFromUrl,
  findDeadSourceJob,
  waitForSource,
};

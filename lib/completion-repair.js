'use strict';
// EVIDENCE-BASED TERMINALISATION — never call a delivered render "failed".
//
// THE DEFECT, named end to end 2026-08-11 [MEASURED]:
//   1. the worker finishes and writes renders/<jobId>/<ts>-edited.mp4 to S3
//   2. its completion POST reaches /api/modal-progress carrying status
//      'completed' but NO deliverable URL
//   3. the DB CHECK constraint refuses it — correctly:
//        23514 "refusing status=completed with no deliverable URL in columns
//               or result"
//   4. that error was DISCARDED, so the update read as a 0-row match and the
//      row stayed 'processing'
//   5. ~900s later the dispatch fallback wrote status='failed' +
//      "We had trouble reaching the render service" + a refund
//
// Clean cohort (jobs created >= 2026-08-11 18:29Z, both DELIVERY halves live,
// v526 hang fix live): 34 terminal jobs / 32 users. 9 jobs / 9 USERS hit this —
// 28% of users. And S3 says every one of those renders EXISTS: 10/10 probed,
// 7.5-42 MB, all -edited.mp4. Nine people were told their finished video failed
// while it sat in the bucket.
//
// THE RULE. The DB row is not the arbiter of whether a render happened — S3 is
// (recover-hls-orphans.js's law, learned the same way). So before any fallback
// writes 'failed', ask S3. A deliverable found means the render succeeded and
// the ROW lost its URL, which is a repair, not a failure.
//
// Deliberately NOT a retry and NOT a net over an unknown fault: the fault is
// named above, this is the evidence check that keeps its blast radius off the
// user while the write-loss root is fixed at the source.

const { pickPlayableOutput } = require('./playable-output');

// A worker that claims completion. NOT proof of a deliverable on its own — that
// is exactly the mistake the DB constraint exists to prevent — but it is the
// signal that says "look in S3 before you call this a failure".
function hasCompletionClaim(job) {
  if (!job) return false;
  const step = String(job.current_step || '').toLowerCase();
  return Number(job.progress || 0) >= 100 && (step === 'complete' || step === 'completed');
}

/** A deliverable already recorded on the row, if any. */
function deliverableOnRow(job) {
  const res = (job && typeof job.result === 'object' && job.result) || {};
  return job?.rendered_video_url || res.video_url || res.public_url || res.rendered_video_url || null;
}

/**
 * Ask S3 whether this job produced a playable render.
 * Returns { key, size } or null. Never throws — an S3 outage must degrade to
 * "cannot tell", which is NOT the same as "no render" and must not be recorded
 * as one.
 */
async function findRenderInS3({ jobId, s3, s3Client, ListObjectsV2Command }) {
  try {
    if (!s3 || !s3.isConfigured || !s3.isConfigured()) return null;
    const out = await s3Client.send(new ListObjectsV2Command({
      Bucket: s3.S3_BUCKET, Prefix: `renders/${jobId}/`, MaxKeys: 100,
    }));
    return pickPlayableOutput(out.Contents || []);
  } catch (_) {
    return null;
  }
}

/**
 * Repair a job whose render exists but whose row never got the URL.
 *
 * Returns { repaired: true, url, key } when it wrote a completion, or
 * { repaired: false, reason } otherwise. NEVER throws: a repair that fails must
 * fall through to the caller's normal failure path, never swallow the terminal.
 *
 * Safety properties, each asserted by __smoke_completion_repair.js:
 *  - only ever writes when a playable render is FOUND. No render, no repair.
 *  - the write is guarded `.not('status','in',TERMINAL)` — it can never clobber
 *    a row that already settled (single-writer law), so racing the real
 *    completion tail is a no-op rather than a double-write.
 *  - it writes the URL and the terminal TOGETHER, which is what satisfies the
 *    23514 constraint instead of fighting it.
 *  - completion_delivery='repair' so the delivery-mix instrument can count this
 *    path. A repair that cannot be counted would hide the very class it fixes.
 */
async function repairCompletedRender({
  jobId, supabaseAdmin, s3, s3Client, ListObjectsV2Command,
  urlTtlSeconds = 60 * 60 * 24 * 7, log = console,
}) {
  const picked = await findRenderInS3({ jobId, s3, s3Client, ListObjectsV2Command });
  if (!picked) return { repaired: false, reason: 'no_render_in_s3' };

  let url;
  try {
    url = await s3.createPresignedGetUrl(picked.key, urlTtlSeconds);
  } catch (e) {
    return { repaired: false, reason: `presign_failed: ${e && e.message}` };
  }
  if (!url) return { repaired: false, reason: 'presign_empty' };

  const { data: rows, error } = await supabaseAdmin
    .from('video_jobs')
    .update({
      rendered_video_url: url,
      status: 'completed',
      current_step: 'complete',
      step_message: 'Your video is ready!',
      progress: 100,
      completion_delivery: 'repair',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .not('status', 'in', '(completed,failed,canceled,needs_input)')
    .select('id');

  if (error) return { repaired: false, reason: `update_failed: ${error.message}`, code: error.code };
  if (!Array.isArray(rows) || rows.length === 0) {
    // Someone else settled it first. Correct outcome, not a defect.
    return { repaired: false, reason: 'already_terminal' };
  }
  log.error(`[repair] DELIVERED job=${jobId} — render existed in S3 (${picked.key}, `
    + `${(picked.size / 1e6).toFixed(2)} MB); the row had lost its URL and was about to be `
    + 'called a failure. Repaired to completed.');
  return { repaired: true, url, key: picked.key, size: picked.size };
}

module.exports = {
  hasCompletionClaim, deliverableOnRow, findRenderInS3, repairCompletedRender,
};

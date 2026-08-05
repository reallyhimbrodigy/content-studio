'use strict';
// A COMPLETED RENDER WITHOUT A CLEAN EXPORT KEY IS A FREE EXPORT.
//
// The export gate mints a short-TTL signed URL from result.clean_export_key. On
// NULL it 404s and the client falls back to saving the public watermarked URL —
// which is the correct behaviour for an OLD job (rendered before the key
// existed) and a silent paywall bypass for a NEW one.
//
// Security's pre-flight assertion for arming the gate is "zero completions with
// a NULL clean_export_key". That assertion has to keep running AFTERWARDS too:
// a pre-flight proves the rate is zero at one instant, and the rate is exactly
// the thing that can drift up later — a credential rotation, a bucket policy
// edit, a renamed prefix, or an agent deploying a branch that reverts the
// upload (which is how v512 dropped it two minutes after it shipped). Nothing
// would have reported any of those.
//
// WHY THIS IS A SEPARATE MONITOR FROM THE WORKER'S DEFECT LEDGER: the worker
// ledgers a defect when its OWN upload throws. It cannot ledger the case where
// the upload code never ran at all — a reverted image, a route that skips the
// block, a completion written by a recovery path. Only a read of the delivered
// rows sees those, so this monitor reads the rows.

const CUTOVER_ENV = 'PROMPTLY_CLEAN_EXPORT_CUTOVER';

// Rows are page-capped at 1000 by PostgREST; a window this size never approaches
// it (peak observed traffic is ~30 completions/hour).
const WINDOW_MIN_DEFAULT = 60;

// Alert thresholds. A single NULL is a real bypass but not yet a signal worth
// waking someone for; a sustained rate is. Both numbers are reported either way.
const MIN_SAMPLE = 5;      // never call a rate on fewer completions than this
const RATE_ALERT = 0.10;   // >10% of new completions missing the key

/**
 * One pass. Reads completions in the window, cuts them into the OLD-job cohort
 * (legitimately NULL, shrinking) and the NEW-render cohort (NULL = defect).
 *
 * Returns { window, completions, newRenders, missing, missingUsers, rate,
 *           armable, alerted, reason } — always with denominators.
 */
async function sweepExportIntegrity(db, {
  sendAlert = null,
  nowMs = null,
  windowMin = WINDOW_MIN_DEFAULT,
  cutoverIso = process.env[CUTOVER_ENV] || null,
} = {}) {
  const now = nowMs === null ? Date.now() : nowMs;
  const sinceIso = new Date(now - windowMin * 60 * 1000).toISOString();

  const { data, error } = await db
    .from('video_jobs')
    .select('id, user_id, updated_at, result, rendered_video_url')
    .eq('status', 'completed')
    .gte('updated_at', sinceIso)
    .order('updated_at', { ascending: false })
    .limit(1000);

  if (error) {
    return { error: error.message, window: sinceIso, completions: 0 };
  }

  const rows = Array.isArray(data) ? data : [];

  // PLAYBACK OUTRANKS THE LEAK (Zac 2026-08-04). 225 plays from the
  // rendered_video_url COLUMN. Today it is 100% populated (801/801) and 100%
  // unsigned-public — it is simultaneously the playback path and the leak the
  // no-public-render change targets, which is why it can never simply stop
  // being written. A NULL there means a user cannot watch their own video,
  // which is worse than any leak.
  //
  // This is measured on the SAME sweep because the export gate and the playback
  // URL are two halves of one change: arming the gate while playback breaks
  // trades a paywall bypass for an outage.
  const nullPlayback = rows.filter((r) => !r.rendered_video_url);
  // A completion with no video_url never delivered anything, so it cannot have
  // bypassed an export. Excluding it keeps the cohort clean (Rule 5).
  const delivered = rows.filter((r) => (r.result || {}).video_url);

  // Cohort cut. Without a stated cutover every old job counts as a defect and
  // the monitor screams on day one; with one, NULL after it is unambiguous.
  const cutoverMs = cutoverIso ? Date.parse(cutoverIso) : NaN;
  const haveCutover = Number.isFinite(cutoverMs);
  const isNew = (r) => !haveCutover || Date.parse(r.updated_at) >= cutoverMs;

  const newRenders = delivered.filter(isNew);
  const missing = newRenders.filter((r) => !(r.result || {}).clean_export_key);
  // RULE 7 — cut by USER before calling anything systemic. One user retrying
  // five times is one affected user, not five bypasses.
  const missingUsers = new Set(missing.map((r) => r.user_id).filter(Boolean));
  const rate = newRenders.length ? missing.length / newRenders.length : 0;

  const out = {
    window: `${sinceIso} .. now (${windowMin}m)`,
    cutover: haveCutover ? cutoverIso : null,
    completions: rows.length,
    delivered: delivered.length,
    newRenders: newRenders.length,
    missing: missing.length,
    missingUsers: missingUsers.size,
    rate: Number(rate.toFixed(4)),
    sampleTooSmall: newRenders.length < MIN_SAMPLE,
    // Security's gate condition, evaluated continuously rather than once.
    armable: newRenders.length >= MIN_SAMPLE && missing.length === 0,
    // NEVER NULL — the hard requirement the no-public-render change ships under.
    nullPlayback: nullPlayback.length,
    nullPlaybackUsers: new Set(nullPlayback.map((r) => r.user_id).filter(Boolean)).size,
    alerted: false,
    reason: null,
  };

  if (!haveCutover) {
    // Not a silent skip: an unset cutover means every number below is blended
    // across old and new jobs and cannot gate anything.
    out.reason = `no ${CUTOVER_ENV} set — cohort is UNCUT, rate is not gateable`;
  } else if (out.sampleTooSmall) {
    out.reason = `n=${newRenders.length} < ${MIN_SAMPLE} — no rate claimed`;
  } else if (missing.length > 0) {
    out.reason = `${missing.length}/${newRenders.length} new completions have NO clean_export_key`
      + ` (${missingUsers.size} user${missingUsers.size === 1 ? '' : 's'})`;
  }

  // A NULL playback URL pages IMMEDIATELY and unconditionally — no cutover, no
  // sample floor. One user unable to watch their own video is already the
  // failure; there is no rate at which it becomes acceptable.
  if (nullPlayback.length > 0 && typeof sendAlert === 'function') {
    try {
      await sendAlert({
        title: '🚫 Users cannot play their own videos',
        body: `${nullPlayback.length}/${rows.length} completions have a NULL `
          + `rendered_video_url (${out.nullPlaybackUsers} user`
          + `${out.nullPlaybackUsers === 1 ? '' : 's'}). 225 plays from that column — `
          + `these users see a completed job they cannot watch.`,
      });
      out.alerted = true;
    } catch (e) {
      out.alertError = String((e && e.message) || e).slice(0, 200);
    }
  }

  const shouldAlert = haveCutover && !out.sampleTooSmall
    && (rate >= RATE_ALERT || missing.length > 0);

  if (shouldAlert && typeof sendAlert === 'function') {
    const pct = (rate * 100).toFixed(1);
    try {
      await sendAlert({
        title: '🔓 Free exports: clean_export_key missing',
        body: `${missing.length}/${newRenders.length} new completions (${pct}%) across `
          + `${missingUsers.size} user${missingUsers.size === 1 ? '' : 's'} have no clean `
          + `export key — those export unwatermarked for free. Window ${windowMin}m.`,
      });
      out.alerted = true;
    } catch (e) {
      out.alertError = String((e && e.message) || e).slice(0, 200);
    }
  }

  const tag = (out.missing || out.nullPlayback) ? 'DEFECT' : 'ok';
  console.log(`[export-integrity] ${tag} missing=${out.missing}/${out.newRenders} new `
    + `(${out.missingUsers} users) of ${out.delivered} delivered in ${windowMin}m; `
    + `armable=${out.armable} nullPlayback=${out.nullPlayback}${out.reason ? ` — ${out.reason}` : ''}`);

  return out;
}

module.exports = {
  sweepExportIntegrity, CUTOVER_ENV, MIN_SAMPLE, RATE_ALERT, WINDOW_MIN_DEFAULT,
};

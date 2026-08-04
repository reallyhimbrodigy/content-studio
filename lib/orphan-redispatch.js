'use strict';

// ORPHAN RE-DISPATCH CRON (Zac 2026-08-04) — RECOVER never-dispatched jobs.
//
// A "never-dispatched" job is a row flipped to `processing` (or left `queued`)
// whose Modal spawn never landed a modal_call_id — the worker never ran and
// nothing said so ("43-minute Getting started…"). Two causes measured tonight:
//   (1) a server RESTART inside dispatch's window — dispatchJobToModal flips the
//       row BEFORE it spawns, then waits on the source (up to 600s) and the
//       0/12/34/75s spawn ladder; a deploy/crash in that ~11-min window drops the
//       in-flight dispatch. Clusters at deploys (14 of 48 within 5min of a push).
//   (2) a PER-JOB cause — spawn 2xx yet NULL call_id, interleaved with successes,
//       no restart (2 of 10 at 07:43/45). Unexplained; the cron recovers it anyway.
//
// This cron RE-CALLS dispatchJobToModal (idempotent on job_id) so the user gets
// their video instead of an 8-minute failure. Keyed on modal_call_id IS NULL —
// which recovers TODAY's `processing` orphans immediately, before any ordering
// change ships (the ordering change makes the row accurate; THIS makes it
// recoverable, and recovery is what the user feels).
//
// It is the primary handler for the never-dispatch class now; the reaper's
// queued_stall stays only as a >30-min backstop for when this cron is down.

const { refundJobCharge } = require('./refund-leg');
const { sendLifecyclePush } = require('./lifecycle-push');
const { sourceKeyFromUrl } = require('./source-presence');
const s3 = require('../services/s3');

// > the max LEGITIMATE dispatch duration: waitForSource ≤600s + the 75s spawn
// ladder + slack. Under this floor a NULL-call_id row may still be legitimately
// mid-dispatch (a slow upload), so this floor + job_id idempotence together stop a
// double-fire of a job that is simply still waiting on its source.
const REDISPATCH_MIN_AGE_MS = 11 * 60 * 1000;
// Each re-dispatch gets this long to land a call_id (its own source-wait + spawn)
// before the next sweep reconsiders it — prevents rapid double-firing across sweeps.
const REDISPATCH_GRACE_MS = 11 * 60 * 1000;
// Cap (Zac): one recovery attempt, then terminalize honestly. A source that never
// arrives would otherwise re-dispatch → wait 600s → orphan → loop forever, burning
// compute on an upload that will never land.
const REDISPATCH_MAX_ATTEMPTS = 1;
// Safety valve: a bug must never become a spend storm. Never re-fire more than this
// per sweep; the surplus waits for the next sweep (logged when it clamps).
const REDISPATCH_MAX_PER_SWEEP = 10;

const GIVE_UP_COPY = "This render couldn't get started — you weren't charged. Tap to try again.";
// Upload never completed: a fresh PICK (new key) is the only thing that works — a
// retry of THIS key can only HEAD-fail again. Copy + envelope route to the picker.
const UPLOAD_FAILED_COPY = "Your upload didn't finish — you weren't charged. Pick your video again.";

function orphanAgeMs(job, nowMs) {
  const t = new Date(job.created_at).getTime();
  return Number.isFinite(t) ? nowMs - t : 0;
}

/**
 * Pure selector — is this row a recoverable orphan right now? (non-terminal, NULL
 * modal_call_id, older than the max legit dispatch window.) Exposed for unit tests.
 */
function isRedispatchable(job, nowMs = Date.now()) {
  if (!['queued', 'processing'].includes(job.status)) return false;
  if (job.modal_call_id) return false;
  return orphanAgeMs(job, nowMs) > REDISPATCH_MIN_AGE_MS;
}

/**
 * One sweep: recover every never-dispatched orphan (re-call dispatchJobToModal),
 * or — once its single attempt is spent — terminalize it honestly + refund.
 * dispatchJobToModal is INJECTED (server passes it) to avoid a heavy circular
 * require and to make the sweep unit-testable.
 */
async function sweepOrphanRedispatch(supabaseAdmin, { pushProgressToSSE, dispatchJobToModal, sourceExists } = {}) {
  if (typeof dispatchJobToModal !== 'function') {
    console.error('[redispatch] no dispatchJobToModal injected — skipping sweep');
    return { scanned: 0, redispatched: 0, gaveUp: 0, uploadFailed: 0 };
  }
  // Injectable for tests; the default is the real S3 HEAD (true|false|null).
  const _sourceExists = typeof sourceExists === 'function'
    ? sourceExists
    : async (videoUrl) => {
      const k = sourceKeyFromUrl(videoUrl);
      return k ? s3.objectExists(k) : null;
    };
  const nowMs = Date.now();
  const cutoff = new Date(nowMs - REDISPATCH_MIN_AGE_MS).toISOString();
  const { data: rows, error } = await supabaseAdmin
    .from('video_jobs')
    .select('id, user_id, status, video_url, vibe_input, edit_recipe, reedit_mode, '
      + 'change_request, parent_job_id, transcript, analysis_data, resolved_broll, '
      + 'trend_snapshot, created_at, modal_call_id, result')
    .in('status', ['queued', 'processing'])
    .is('modal_call_id', null)
    .lt('created_at', cutoff);
  if (error) {
    console.error('[redispatch] sweep read failed:', error.message);
    return { scanned: 0, redispatched: 0, gaveUp: 0 };
  }
  const orphans = Array.isArray(rows) ? rows : [];
  let redispatched = 0;
  let gaveUp = 0;
  let uploadFailed = 0;
  let fired = 0;

  for (let i = 0; i < orphans.length; i += 1) {
    const job = orphans[i];
    const rd = (job.result && job.result._redispatch) || { attempts: 0, last_at: null };

    // PREDICATE (Zac/Errors 2026-08-04): 76% of orphans (37 of 49, a 12× enrichment
    // over successful jobs) NEVER completed their upload. Re-dispatching those sends
    // the job back for a 600s wait on bytes that will never arrive — wasted time and a
    // re-orphan risk. So check the SOURCE first: only the ~24% with a present object
    // are recoverable. A confirmed-ABSENT source gets ONE honest upload terminal, never
    // a re-dispatch. objectExists → null when S3 can't answer: FAIL OPEN (let recovery
    // try), exactly as the dispatch source-gate does — an S3 blip must not mass-fail.
    const _exists = await _sourceExists(job.video_url);
    if (_exists === false) {
      const { data: wonU } = await supabaseAdmin
        .from('video_jobs')
        .update({
          status: 'failed',
          error_message: UPLOAD_FAILED_COPY,
          result: {
            ...(job.result || {}),
            error_code: 'UPLOAD_NEVER_STARTED', error_class: 'upload',
            reaped: true, reason: 'redispatch_upload_absent',
            retryable: false, requires_new_video: true, refunded: true,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id)
        .is('modal_call_id', null)
        .in('status', ['queued', 'processing'])
        .select('id');
      if (!Array.isArray(wonU) || !wonU.length) continue; // came alive / lost race
      uploadFailed += 1;
      console.error(`[ALERT] never-dispatch UPLOAD ABSENT job=${job.id} — source never landed on S3; honest terminal + refund (no re-dispatch)`);
      await refundJobCharge(supabaseAdmin, job)
        .catch((e) => console.error(`[redispatch] refund failed job=${job.id}:`, e?.message));
      try {
        await sendLifecyclePush(supabaseAdmin, {
          jobId: job.id, userId: job.user_id, kind: 'failed',
          errorMessage: UPLOAD_FAILED_COPY, refunded: true,
        });
      } catch (e) { console.error(`[redispatch] upload-terminal push failed job=${job.id}:`, e?.message); }
      if (typeof pushProgressToSSE === 'function') {
        pushProgressToSSE(job.id, {
          status: 'failed', progress: 0, step: 'error', message: '',
          videoUrl: null, thumbnailUrl: null, final: true, error: UPLOAD_FAILED_COPY,
          error_code: 'UPLOAD_NEVER_STARTED', retryable: false, requires_new_video: true,
        });
      }
      continue;
    }

    // Grace: an in-flight re-dispatch gets its full window to land a call_id.
    if (rd.last_at && nowMs - new Date(rd.last_at).getTime() < REDISPATCH_GRACE_MS) continue;

    // GIVE UP honestly once the single attempt is spent (recovery exhausted —
    // usually a source that never arrived). Atomic + guarded on still-orphaned.
    if (rd.attempts >= REDISPATCH_MAX_ATTEMPTS) {
      const { data: won } = await supabaseAdmin
        .from('video_jobs')
        .update({
          status: 'failed',
          error_message: GIVE_UP_COPY,
          result: {
            ...(job.result || {}),
            error_code: 'NEVER_DISPATCHED',
            reaped: true,
            reason: 'redispatch_exhausted',
            redispatch_attempts: rd.attempts,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id)
        .is('modal_call_id', null)
        .in('status', ['queued', 'processing'])
        .select('id');
      if (!Array.isArray(won) || !won.length) continue; // came alive / lost race
      gaveUp += 1;
      console.error(`[ALERT] never-dispatch GAVE UP job=${job.id} after ${rd.attempts} re-dispatch(es) — terminalized + refunded`);
      await refundJobCharge(supabaseAdmin, job)
        .catch((e) => console.error(`[redispatch] refund failed job=${job.id}:`, e?.message));
      try {
        await sendLifecyclePush(supabaseAdmin, {
          jobId: job.id, userId: job.user_id, kind: 'failed',
          errorMessage: GIVE_UP_COPY, refunded: true,
        });
      } catch (e) { console.error(`[redispatch] give-up push failed job=${job.id}:`, e?.message); }
      if (typeof pushProgressToSSE === 'function') {
        pushProgressToSSE(job.id, {
          status: 'failed', progress: 0, step: 'error', message: '',
          videoUrl: null, thumbnailUrl: null, final: true, error: GIVE_UP_COPY,
        });
      }
      continue;
    }

    if (fired >= REDISPATCH_MAX_PER_SWEEP) {
      console.warn(`[redispatch] per-sweep cap ${REDISPATCH_MAX_PER_SWEEP} hit — ${orphans.length - i} orphan(s) deferred to next sweep`);
      break;
    }

    // CLAIM atomically: bump attempts + stamp last_at, guarded on still-orphaned so a
    // concurrent pass (or a job that just came alive) is never double-fired.
    const claimResult = {
      ...(job.result || {}),
      _redispatch: { attempts: rd.attempts + 1, last_at: new Date().toISOString() },
    };
    const { data: claimed } = await supabaseAdmin
      .from('video_jobs')
      .update({ result: claimResult, updated_at: new Date().toISOString() })
      .eq('id', job.id)
      .is('modal_call_id', null)
      .in('status', ['queued', 'processing'])
      .select('id');
    if (!Array.isArray(claimed) || !claimed.length) continue;
    fired += 1;

    // Re-dispatch (idempotent on job_id). premiumPipeline=false is NO downgrade —
    // premium output ≡ standard today; supportsProgressive=false only drops a preview.
    try {
      await dispatchJobToModal({
        pushProgressToSSE,
        jobId: job.id,
        videoUrl: job.video_url,
        vibe: job.vibe_input,
        userId: job.user_id,
        mode: job.reedit_mode || undefined,
        editPlan: job.edit_recipe || undefined,
        changeRequest: job.change_request || undefined,
        parentJobId: job.parent_job_id || undefined,
        transcript: job.transcript || undefined,
        analysisData: job.analysis_data || undefined,
        resolvedBroll: job.resolved_broll || undefined,
        trendSnapshot: job.trend_snapshot || undefined,
        premiumPipeline: false,
        supportsProgressive: false,
      });
      redispatched += 1;
      console.log(`[redispatch] re-dispatched orphan job=${job.id} attempt=${rd.attempts + 1}/${REDISPATCH_MAX_ATTEMPTS} age=${Math.round(orphanAgeMs(job, nowMs) / 60000)}m`);
    } catch (e) {
      // The attempt is already counted; next sweep hits the cap → clean terminal.
      console.error(`[redispatch] re-dispatch threw job=${job.id}:`, e?.message);
    }
  }

  if (redispatched || gaveUp || uploadFailed) {
    console.log(`[redispatch] sweep: ${redispatched} re-dispatched (source present), ${uploadFailed} upload-absent terminals, ${gaveUp} gave up, of ${orphans.length} orphan(s)`);
  }
  return { scanned: orphans.length, redispatched, gaveUp, uploadFailed };
}

module.exports = {
  sweepOrphanRedispatch,
  isRedispatchable,
  REDISPATCH_MIN_AGE_MS,
  REDISPATCH_GRACE_MS,
  REDISPATCH_MAX_ATTEMPTS,
  GIVE_UP_COPY,
};

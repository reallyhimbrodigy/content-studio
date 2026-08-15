'use strict';

// Render-lifecycle user pushes — THE single chokepoint (2026-07-24 directive).
//
// WHY: 1,173 users, 92% never return. Renders take minutes, users background
// the app, and the "you're done" moment was scattered across ad-hoc push call
// sites (the 1.2.0 rider) plus a dead pushNotifier path. This module is the
// one place a terminal-state push is composed, claimed, and sent.
//
// CONTRACT — exactly ONE push per terminal state per job, EVER:
//   1. Callers invoke sendLifecyclePush ONLY after WINNING the job's
//      first-terminal-wins status transition (their UPDATE … .not/.eq status
//      guard returned rows). That is the structural settle-once.
//   2. Belt: a per-job, per-kind claim marker in result jsonb
//      (result.lifecycle_push_v1[kind] = ISO ts), claimed atomically via
//      UPDATE … WHERE result->lifecycle_push_v1->kind IS NULL — the
//      refund-leg claim pattern (refunded_at NULL→now). Double-settles,
//      restarted sweeps, and future unguarded callers can never double-push
//      or storm: the claim loses and the send is skipped. Claim-then-send
//      (at-most-once): a send failure after a won claim is NOT retried.
//
// FLAG: USER_LIFECYCLE_PUSHES ('1' = on; default OFF/absent = no user pushes).
// The OWNER's own jobs bypass the flag so delivery can be proven on the
// founder's device before the flip (proof discipline: logs are not proof).
//
// COPY (server copy source of truth — clients render verbatim):
//   completed → "🎬 Your video is ready — tap to watch"
//   failed    → the job's existing honest error_message copy, with the
//               credit-returned note appended only when a refund fired for
//               the job AND the copy doesn't already say it (the 1.2.0 rider
//               pattern; "you weren't charged" reaper copy counts as said).
//
// DEEP-LINK payload convention (established by the live 1.2.0 rider, handled
// by the shipped iOS type-handlers): { jobId, type: 'render-complete' } /
// { jobId, type: 'render-failed' }.

const push = require('../services/push');

// Founder user id — same constant the reaper/dispatch use; env-overridable.
const OWNER_USER_ID = process.env.OWNER_USER_ID || 'ec702499-ca10-49e6-8850-df8f99840904';

const CLAIM_KEY = 'lifecycle_push_v1';

function userLifecyclePushesEnabled() {
  return String(process.env.USER_LIFECYCLE_PUSHES || '').trim() === '1';
}

/// Completed-state alert copy. Body carries the vibe when we have one so the
/// banner reads personal; empty body is valid APNs.
function buildCompletedAlert({ vibe } = {}) {
  return {
    title: '🎬 Your video is ready — tap to watch',
    body: vibe ? `“${String(vibe).slice(0, 80)}” is done.` : '',
  };
}

/// Failed-state alert copy: the job's honest error_message verbatim, credit
/// note appended only when a refund fired and the copy doesn't already say so.
/// 178-char body cap (APNs banner truncation point the rider calibrated).
function buildFailedAlert({ errorMessage, refunded = true } = {}) {
  const base = String(errorMessage || '').trim()
    || (refunded
      ? 'Something went wrong — your credit was returned. Tap to try again.'
      : 'Something went wrong. Tap to try again.');
  const alreadySaid = /credit|refund|returned|charged/i.test(base);
  const body = refunded && !alreadySaid ? `${base} Your credit was returned.` : base;
  return {
    title: refunded ? 'Render failed — your credit was returned' : 'Render failed',
    body: body.slice(0, 178),
  };
}

/// Atomic per-(job, kind) claim — the belt under first-terminal-wins.
///
/// LOST UPDATE, FIXED 2026-08-14 [Law 2]. This is a read-merge-write on the
/// `result` jsonb, and the ORIGINAL comment carried the false premise that made
/// it dangerous: *"called only AFTER the terminal write, when result is settled,
/// so the merge preserves the worker's write-once result fields."* The terminal
/// STATUS write and the worker's RESULT write are separate statements, so
/// `result` is emphatically not settled when this fires. The interleaving:
///
///   T1  claim SELECTs result           -> {} (worker's result not landed yet)
///   T2  worker UPDATEs result          -> the full envelope
///   T3  claim UPDATEs result = {...{}} -> {lifecycle_push_v1} — T2 ERASED
///
/// The `.is(result->CLAIM_KEY->kind, null)` guard does not help: it is a CLAIM
/// guard (one winner per job+kind), not an optimistic-concurrency guard. Both
/// racers here are writing DIFFERENT things, and the loser is the worker.
///
/// MEASURED, clean cohort (466 completions carrying completion_delivery):
///   466/466  carry lifecycle_push_v1        — this claim runs on every job
///   286      carry it AND the worker fields — the claim read after the worker
///   180      carry EXACTLY {lifecycle_push_v1} and nothing else, 161 users
///            = 38.6% of completions, stable 34-46% every day. Not an outage.
///
/// And the erasure is not merely cosmetic — it destroys the evidence every
/// recovery layer reads. resolveSpawnedCompletionFallback looks for a video_url
/// in `result` to decide a job COMPLETED; against a clobbered row it finds
/// nothing, cannot confirm, and the job rides the slow path instead of settling
/// instantly. Hence the latency signature: p50 304s for the clobbered class
/// against 84s when the envelope survives, with the repair cohort out at 904s.
/// One lost update is simultaneously the telemetry hole and the tail latency.
///
/// THE FIX: compare-and-swap on `updated_at`, which every worker patch sets
/// unconditionally (handler.py builds `patch = {"updated_at": ...}` as the base
/// of EVERY write), so any concurrent result write invalidates our CAS and we
/// re-read instead of overwriting. On exhaustion we DECLINE rather than force
/// the write: a delayed push is cheap and the 15-minute missed-sweep re-attempts
/// it, whereas an erased envelope is unrecoverable.
const CLAIM_CAS_ATTEMPTS = 4;

async function claimLifecyclePush(supabaseAdmin, jobId, kind) {
  for (let attempt = 1; attempt <= CLAIM_CAS_ATTEMPTS; attempt += 1) {
    const { data: row, error } = await supabaseAdmin
      .from('video_jobs')
      .select('result, updated_at')
      .eq('id', jobId)
      .maybeSingle();
    if (error) return { won: false, reason: `read_failed:${error.message}` };
    if (!row) return { won: false, reason: 'no_row' };
    const cur = (row.result && typeof row.result === 'object' && !Array.isArray(row.result)) ? row.result : {};
    const marks = (cur[CLAIM_KEY] && typeof cur[CLAIM_KEY] === 'object') ? cur[CLAIM_KEY] : {};
    if (marks[kind]) return { won: false, reason: 'already_pushed' };
    const merged = { ...cur, [CLAIM_KEY]: { ...marks, [kind]: new Date().toISOString() } };
    let q = supabaseAdmin
      .from('video_jobs')
      .update({ result: merged })
      .eq('id', jobId)
      .is(`result->${CLAIM_KEY}->${kind}`, null);
    // THE CAS. A null updated_at is matched as null rather than skipped — a
    // silently-dropped guard is how this class returns.
    q = (row.updated_at === null || row.updated_at === undefined)
      ? q.is('updated_at', null)
      : q.eq('updated_at', row.updated_at);
    const { data: updated, error: updErr } = await q.select('id');
    if (updErr) return { won: false, reason: `claim_failed:${updErr.message}` };
    if (Array.isArray(updated) && updated.length > 0) return { won: true, reason: 'claimed' };
    // 0 rows updated: the row moved under us (a worker write) or another racer
    // claimed it. The next iteration's re-read tells the two apart and returns
    // 'already_pushed' for the latter. Either way we never write a stale merge.
    console.log(`[lifecycle-push] job=${jobId} kind=${kind} CAS miss on attempt ${attempt} `
      + '— the row changed under the read; re-reading rather than overwriting');
  }
  // Declining is the safe end state: the missed-sweep retries this within 15
  // minutes, by which time the writer we kept losing to has finished.
  return { won: false, reason: 'cas_exhausted' };
}

/// Durable telemetry — same event/props shape as the rider's logPushEvent so
/// the existing push_sent analytics stream stays continuous.
function logPushEvent(supabaseAdmin, userId, type, jobId, r) {
  try {
    supabaseAdmin.from('analytics_events').insert({
      event: 'push_sent',
      anon_user_id: userId,
      user_id: userId,
      platform: 'server',
      app_version: 'lifecycle',
      // DELIVERY DETAIL (2026-07-31): `sent` = tokens APNs ACCEPTED (200) = DELIVERED
      // to ≥1 device. Also log `total` (tokens attempted), `rejected` (410/BadDeviceToken/
      // Unregistered — already pruned by services/push.js), and the per-token APNs
      // status/reason, so "delivered per completed job" (the real never-viewed denominator)
      // and the stale-token rate are measurable from analytics instead of only `sent/skipped`.
      props: {
        type, job_id: jobId,
        sent: (r && r.sent) || 0,
        total: (r && r.total) || 0,
        rejected: (r && Array.isArray(r.results)) ? r.results.filter((t) => t.status && t.status !== 200).length : 0,
        apns: (r && Array.isArray(r.results)) ? r.results.map((t) => ({ s: t.status, r: t.reason })) : [],
        skipped: (r && r.skipped) || null,
      },
    }).then(({ error }) => {
      if (error) console.warn(`[lifecycle-push] push_sent mirror failed: ${error.message}`);
    }).catch(() => {});
  } catch (_) { /* telemetry only */ }
}

/**
 * Send the one lifecycle push for a job's terminal state. Best-effort: never
 * throws (a push must never affect the render path).
 *
 *   kind: 'completed' | 'failed'
 *   userId: the job's owner (push target)
 *   vibe: (completed) vibe_input for the body line
 *   errorMessage: (failed) the row's honest error_message copy
 *   refunded: (failed) whether the refund leg fired for this job — every
 *             terminal failure on the wired paths refunds (2026-07-11 law)
 *   test: proof-path mode — targets the OWNER's device regardless of userId,
 *         bypasses the flag AND the claim (repeatable), never a real user.
 *
 * Returns { sent, skipped, results } for callers/proof endpoints.
 */
async function sendLifecyclePush(supabaseAdmin, {
  jobId, userId, kind, vibe, errorMessage, refunded = true, test = false,
} = {}) {
  try {
    if (kind !== 'completed' && kind !== 'failed') return { sent: 0, skipped: 'bad_kind' };

    const target = test ? OWNER_USER_ID : userId;
    if (!target) return { sent: 0, skipped: 'no_user' };

    if (!test) {
      // Flag gate — OWNER's own jobs bypass so proof precedes the flip.
      if (!userLifecyclePushesEnabled() && target !== OWNER_USER_ID) {
        return { sent: 0, skipped: 'flag_off' };
      }
      const claim = await claimLifecyclePush(supabaseAdmin, jobId, kind);
      if (!claim.won) {
        console.log(`[lifecycle-push] skip job=${jobId} kind=${kind} (${claim.reason})`);
        return { sent: 0, skipped: claim.reason };
      }
    }

    const alert = kind === 'completed'
      ? buildCompletedAlert({ vibe })
      : buildFailedAlert({ errorMessage, refunded });
    const type = kind === 'completed' ? 'render-complete' : 'render-failed';

    const r = await push.sendToUser(target, alert, { jobId, type });
    const detail = (r.results || [])
      .map((t) => `${t.token}…:${t.status}${t.reason ? `/${t.reason}` : ''}`)
      .join(' ');
    console.log(`[lifecycle-push] job=${jobId} kind=${kind}${test ? ' TEST→owner' : ''} `
      + `sent=${r.sent ?? 0}/${r.total ?? 0}${r.skipped ? ` skipped=${r.skipped}` : ''}${detail ? ` apns=[${detail}]` : ''}`);
    if (!test) logPushEvent(supabaseAdmin, target, type, jobId, r);
    return r;
  } catch (err) {
    console.warn(`[lifecycle-push] job=${jobId} kind=${kind} failed: ${err && err.message}`);
    return { sent: 0, skipped: 'error' };
  }
}


/**
 * W1-FIX (census job ba1a9f58): under SPAWN_MODE the WORKER writes failed
 * terminals directly to the DB — the server's push chokepoints (which fire on
 * SERVER terminal writes) never see those rows, so the user got no failure
 * push. This sweep completes the wiring at an existing cadence: recent
 * terminal rows with NO push claim get their push HERE. Exactly-once stays
 * structural (sendLifecyclePush's claim); the 15-minute recency window makes
 * backlog sends impossible by construction (pre-flip/old rows never qualify).
 * Not a retry of anything — the job's outcome is untouched; this delivers the
 * notification for an outcome already written.
 */
async function sweepMissedLifecyclePushes(supabaseAdmin) {
  if (!userLifecyclePushesEnabled()) return { swept: 0, sent: 0 };
  const sinceISO = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('video_jobs')
    .select('id, user_id, status, error_message, result, updated_at')
    .in('status', ['completed', 'failed'])
    .gte('updated_at', sinceISO)
    .is('result->lifecycle_push_v1', null)
    .limit(20);
  if (error) {
    console.error('[lifecycle-push] missed-sweep read failed:', error.message);
    return { swept: 0, sent: 0 };
  }
  let sent = 0;
  for (const row of (data || [])) {
    const kind = row.status === 'completed' ? 'completed' : 'failed';
    const res = await sendLifecyclePush(supabaseAdmin, {
      jobId: row.id, userId: row.user_id, kind,
      errorMessage: row.error_message,
      refunded: kind === 'failed'
        ? Boolean((row.result || {}).designed_rejection === true || row.result)
        : true,
    });
    if (res && res.sent) {
      sent += res.sent;
      console.log(`[lifecycle-push] missed-sweep delivered job=${row.id} kind=${kind} (worker-direct terminal)`);
    }
  }
  return { swept: (data || []).length, sent };
}

module.exports = {
  sweepMissedLifecyclePushes,
  sendLifecyclePush,
  claimLifecyclePush,
  buildCompletedAlert,
  buildFailedAlert,
  userLifecyclePushesEnabled,
  OWNER_USER_ID,
  CLAIM_KEY,
};

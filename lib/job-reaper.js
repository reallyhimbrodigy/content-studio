'use strict';

// Server-side job reaper (stuck-jobs directive, Fix 1.1) — the by-construction
// guarantee that no job can rest in a non-terminal state beyond its lease.
//
// The 2026-07-10 census found ZERO server-side zombies (the active bleed was
// client-side), so this is cheap permanent insurance: any future server-side
// stall class (dispatch crash between insert and Modal call, worker container
// lost without a terminal write, etc.) terminalizes within one lease window
// instead of accumulating.
//
// Lease windows per stage (from the directive):
//   queued      10 min — a queued row only exists between insert and dispatch
//                        (seconds normally); 10 min of silence = the dispatch
//                        died with it.
//   processing  20 min — Modal's 900 s hard timeout + margin; the worker
//                        heartbeats updated_at every few seconds while alive.
//
// Refund: reaped jobs refund through the SAME claim-gated path as the
// generalized refund leg (refundJobCharge: refunded_at NULL→now claim,
// ±1500 ms window, 400 ms delete cap, sibling attribution) — one shot per
// job, structurally idempotent, never a wrong charge.

const { refundJobCharge } = require('./refund-leg');
const { sendOwnerAlert } = require('../services/pushNotifier');
const { sendLifecyclePush } = require('./lifecycle-push');

// The worker's cancel_call endpoint (standalone Modal function). Overridable via
// env for a workspace rename; the default is the deployed URL.
const MODAL_CANCEL_URL = process.env.MODAL_CANCEL_URL
  || 'https://reallyhimbrodigy--promptly-gpu-worker-cancel-call.modal.run';

/**
 * Terminate a stranded Modal container to stop its bill. content-studio has no
 * Modal credentials — it reaches Modal only over HTTP — so it POSTs the worker's
 * cancel_call bridge with the FunctionCall id + the shared MODAL_CALLBACK_SECRET.
 *
 * Best-effort throughout: reads modal_call_id in a SEPARATE swallowed query so a
 * not-yet-migrated column can never break the reaper sweep, and never throws.
 * The endpoint is idempotent (cancelling a dead/settled call is not an error).
 */
async function cancelModalCall(supabaseAdmin, jobId) {
  const secret = process.env.MODAL_CALLBACK_SECRET;
  if (!secret) return;
  let callId = null;
  try {
    const { data, error } = await supabaseAdmin
      .from('video_jobs')
      .select('modal_call_id')
      .eq('id', jobId)
      .single();
    if (error) return; // column not migrated yet, or row gone — nothing to cancel
    callId = data && data.modal_call_id;
  } catch (_) {
    return;
  }
  if (!callId) return;
  try {
    const resp = await fetch(MODAL_CANCEL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ call_id: callId, secret }),
    });
    const j = await resp.json().catch(() => ({}));
    console.log(`[reaper] cancel_call job=${jobId} call=${callId} → ${j.cancelled ? 'CANCELLED (container terminated)' : (j.error || 'no-op/settled')}`);
  } catch (e) {
    console.warn(`[reaper] cancel_call POST failed job=${jobId}: ${e && e.message}`);
  }
}

// The founder's user id — target for operator alerts. A reaped job is a real
// server-side death the worker could not self-report (SIGKILL at the 900s
// execution wall, or a dispatch stall), so it never reaches the worker's own
// [ALERT] path — the reaper is the ONLY place these become visible.
const OWNER_USER_ID = process.env.OWNER_USER_ID || 'ec702499-ca10-49e6-8850-df8f99840904';

const LEASE_MS = {
  queued: 10 * 60 * 1000,
  // 5-minute-support lockstep (2026-07-24): 30 → 50 min. CLIP_TOO_LONG rises to
  // 300s, so a legitimate render runs longer; the heartbeat lease grows with the
  // worker's execution ceiling. Raised HERE FIRST, before the worker's ceiling
  // rises, so the reaper is never tighter than the worker at any moment.
  processing: 50 * 60 * 1000,
};

// Execution wall (W4 #1 — the 900s SIGKILL class). Anchored on started_at
// (the execution-start instant the dispatch now stamps), NOT on updated_at.
// Modal's @app.cls(timeout=900) SIGKILLs a run mid-execution — the finally +
// terminal failed-write never fire, so the row hangs in 'processing' forever
// (the ONLY silent death in the W4 inventory). The heartbeat lease eventually
// catches it, but only ~20min after the LAST heartbeat (≈35min after start),
// because heartbeats keep updated_at fresh right up to the kill. started_at
// never refreshes, so this wall fires ~ceiling+slack after DISPATCH, catching
// the SIGKILL ~5min after death. SAFE: the worker CANNOT run past its 900s
// ceiling, so no legitimate job is still 'processing' this far past start —
// Was 2100s (35-min) for the 3-min-clip world. 5-minute-support lockstep
// (2026-07-24): raised to 3300s (55 min) to stay ahead of the worker's coming
// higher ceiling for 5-min renders — 3300s = worker ceiling + Modal cold-start +
// reaper-interval slack. LOAD-BEARING ORDER: this wall rises FIRST (this deploy);
// the backend raises the worker's ceiling + CLIP_TOO_LONG (180s → 300s) AFTER it
// is live, so reaper_wall >= worker_ceiling holds at every instant — no 5-min
// render is ever false-reaped.
const EXEC_WALL_MS = 55 * 60 * 1000;

// QUEUED-STALL notify (Zac 2026-08-03, "tell users the truth tonight"). A job at
// current_step='queued' was never picked up by a worker — queued transitions in
// SECONDS (dispatch is 0.2s; the only legit delay is Modal cold-start). Measured
// 2026-08-03 (containers <15/100, no Modal queuing): max healthy queued dwell = 96s,
// fastest full job = 8s end-to-end, and a CLEAN EMPTY GAP at 2-5min (healthy ≤96s,
// dead ≥334s). 300s = 3.1× the max-healthy dwell across that gap. This fires ~50min
// before the 55-min execution wall would, so a user stuck on "Getting started…" is
// told at 5min instead of 50. QUEUED STAGE ONLY — download/plan/transcribe can run
// minutes on a slow source (Zac: false-terminalising a live job is worse than the
// stall), so they stay OUT until their own dwell is measured.
// 480s (8min) default (Zac 2026-08-03, re-enable at 8-10min): proven safe on its
// full population (4/4 reaps had NULL modal_call_id = genuinely never-dispatched,
// 0 completed after), so raised from 5min to 8min for extra surge margin — 5.0×
// the measured max-healthy queued dwell (96s) vs 3.1× at 5min. Env-overridable
// (QUEUED_STALL_MS_OVERRIDE, in ms) so the threshold is one config value, no redeploy.
const QUEUED_STALL_MS = Number(process.env.QUEUED_STALL_MS_OVERRIDE) || 8 * 60 * 1000;
// If ONE sweep finds more than this many jobs stuck at queued, it is not N individual
// deaths — it is SYSTEMIC (a dispatch outage, or Modal container-queuing under a
// 100/100 surge holding healthy jobs at queued). Reaping them would false-terminalise
// live-but-waiting jobs. So above this count we ALERT loudly and DON'T queued-reap this
// sweep (the ordinary stall/timeout leases still handle any that are truly dead).
const QUEUED_STALL_MASS_GUARD = 8;

// BATCHED ALERTING (Zac 2026-08-04): never-dispatch is a REAL but ~15/hr class —
// one page per job trains the owner to ignore the channel, which is how the next
// genuinely novel alert gets missed. So the queued_stall owner-push is batched to
// ONE page per rolling window with a COUNT ("N jobs never dispatched in the last
// ~Xm"), NEVER one-per-job. The first occurrence after a quiet window still pages
// promptly (lastPageMs starts at 0), so the class becoming active is never silent —
// only the repeats are coalesced. timeout/stall stay per-job (they are ~1/6h and
// each is a distinct finish-line death worth its own page).
const QS_ALERT_WINDOW_MS = 60 * 60 * 1000;
const _qsAlert = { count: 0, sinceMs: 0, lastPageMs: 0 };

// User-facing copy for the reaped row's error_message (cold-load safe:
// no technical vocabulary, passes the iOS display filters).
const STALLED_COPY = {
  queued: "This render didn't get started — you weren't charged. Tap to try again.",
  processing: 'This render stalled on our side — you weren’t charged. Tap to try again.',
  timeout: 'This render hit our time limit — you weren’t charged. Tap to try again.',
};

/**
 * Pure selector — which of these rows are past their heartbeat lease right now?
 * Exposed for unit tests.
 */
function isPastLease(row, nowMs = Date.now()) {
  const lease = LEASE_MS[row.status];
  if (!lease) return false;
  const updated = new Date(row.updated_at).getTime();
  if (!Number.isFinite(updated)) return false;
  return nowMs - updated > lease;
}

/**
 * Pure selector — is this a job that never left the 'queued' STAGE? (current_step
 * still 'queued' AND stale past QUEUED_STALL_MS.) True for a dispatched job whose
 * worker never picked it up. Deliberately keyed on current_step (the STAGE), not
 * row.status — the real-world case is status='processing' with current_step still
 * 'queued' (dispatch flipped status but the worker never wrote a first step), which
 * the 50-min processing lease sits on for the full 50min. Exposed for unit tests.
 */
function isQueuedStall(row, nowMs = Date.now()) {
  if (row.current_step !== 'queued') return false;
  const updated = new Date(row.updated_at).getTime();
  if (!Number.isFinite(updated)) return false;
  return nowMs - updated > QUEUED_STALL_MS;
}

/**
 * Pure selector — is this a 'processing' job past the execution wall (started_at)?
 * A confirmed timeout death, independent of heartbeat freshness. Exposed for tests.
 *
 * DEPENDS ON THE started_at INVARIANT: every transition INTO 'processing' stamps
 * started_at atomically (dispatch initialUpdate + the ask-back resume flip in
 * server.js). If a transition left started_at stale, this would false-reap a
 * healthy job — so that invariant is load-bearing, not cosmetic.
 */
function isPastExecutionWall(row, nowMs = Date.now()) {
  if (row.status !== 'processing' || !row.started_at) return false;
  const started = new Date(row.started_at).getTime();
  if (!Number.isFinite(started)) return false;
  return nowMs - started > EXEC_WALL_MS;
}

/**
 * Reap reason for a row, or null. 'timeout' (execution wall) takes priority over
 * 'stall' (heartbeat lease) — a SIGKILLed job is past BOTH once its lease elapses,
 * and 'timeout' is the truer cause + honest copy.
 */
function reapReason(row, nowMs = Date.now()) {
  // queued_stall is checked FIRST: a never-picked-up job is the truest cause and
  // the earliest signal (5min vs the 50/55-min leases). A queued-stuck job reaped
  // here is told "didn't start — tap to try again" ~50min sooner than the wall.
  if (isQueuedStall(row, nowMs)) return 'queued_stall';
  if (isPastExecutionWall(row, nowMs)) return 'timeout';
  if (isPastLease(row, nowMs)) return 'stall';
  return null;
}

/**
 * One reaper pass: terminalize every non-terminal job past its lease
 * (first-terminal-wins guarded — the worker's own terminal always beats us),
 * refund its charge via the claim-gated leg, and emit an SSE failed event so
 * a live client's spinner dies immediately.
 */
async function sweepJobReaper(supabaseAdmin, { pushProgressToSSE, sendAlert = sendOwnerAlert } = {}) {
  // NO scan horizon (review finding): bounding on created_at permanently hid
  // late-resumed ask-back jobs (a needs_input row answered hours later flips
  // back to processing with its ORIGINAL created_at) and post-outage zombies.
  // The non-terminal set is inherently tiny (the reaper keeps it that way),
  // so a full scan of queued/processing is cheap.
  const { data: rows, error } = await supabaseAdmin
    .from('video_jobs')
    .select('id, user_id, status, progress, created_at, updated_at, started_at, current_step')
    .in('status', ['queued', 'processing']);
  if (error) {
    console.error('[reaper] sweep read failed:', error.message);
    return { scanned: 0, reaped: 0 };
  }

  let due = (Array.isArray(rows) ? rows : [])
    .map((r) => ({ job: r, reason: reapReason(r) }))
    .filter((x) => x.reason);

  // MASS-EVENT GUARD (Zac 2026-08-03): a queued-stall burst is systemic, not N
  // deaths. If more than QUEUED_STALL_MASS_GUARD jobs are stuck at queued in ONE
  // sweep, a dispatch outage or a 100/100 container-queue is holding healthy jobs
  // at 'queued' — reaping them would false-terminalise live-but-waiting work. Alert
  // loudly and DROP the queued-reaps this sweep; the ordinary stall/timeout leases
  // still catch any that are genuinely dead once they age out.
  // KILL-SWITCH (Zac 2026-08-03): queued_stall is ON by default — proven safe on
  // its full population (4/4 reaps NULL-modal_call_id = genuinely never-dispatched,
  // 0 completed after) and it is the ONLY instrument that makes silent dispatch
  // failures visible (a job flipped to processing whose worker never ran). Set
  // QUEUED_STALL_DISABLED=1 to kill it instantly (one env value, no logic redeploy).
  if (process.env.QUEUED_STALL_DISABLED === '1') {
    due = due.filter((x) => x.reason !== 'queued_stall');
  }
  const queuedStalls = due.filter((x) => x.reason === 'queued_stall');
  if (queuedStalls.length > QUEUED_STALL_MASS_GUARD) {
    console.error(`[ALERT] reaper: ${queuedStalls.length} jobs stuck at current_step=queued in one sweep — SYSTEMIC (dispatch outage or Modal container-queue under surge), NOT individual deaths. SKIPPING queued-reap this sweep; investigate dispatch. Ordinary stall/timeout leases still apply.`);
    try {
      await sendAlert({
        ownerUserId: OWNER_USER_ID,
        title: '🚨 [Promptly] dispatch/queue systemic',
        body: `${queuedStalls.length} jobs stuck at queued in one sweep — dispatch or container-queue, not individual deaths`,
        threadId: 'render-alert',
        supabaseAdmin,
      });
    } catch (e) {
      console.error('[reaper] systemic-queue alert failed:', e?.message);
    }
    due = due.filter((x) => x.reason !== 'queued_stall');
  }
  let reaped = 0;
  for (const { job, reason } of due) {
    const stage = job.status;
    // Copy: a 'timeout' (execution-wall) reap gets the honest time-limit line;
    // otherwise the stage's stall copy.
    // queued_stall ALWAYS gets the "didn't get started" copy even though the row's
    // status is usually 'processing' — the honest cause is never-picked-up, not stalled.
    const copy = reason === 'timeout'
      ? STALLED_COPY.timeout
      : reason === 'queued_stall'
        ? STALLED_COPY.queued
        : (STALLED_COPY[stage] || STALLED_COPY.processing);

    // Atomic terminalize, first-terminal-wins (.eq status → a worker terminal or
    // user cancel that landed between our read and this write wins; we no-op):
    //   - 'stall'   re-verifies updated_at staleness (a heartbeat landing between
    //               SELECT and UPDATE refreshes updated_at without changing status;
    //               the .lte re-checks so a job that just came alive is never killed).
    //   - 'timeout' re-verifies started_at is still past the wall (stable — started_at
    //               never refreshes; the .lte is belt, the .eq status is the real guard).
    //               Deliberately NOT gated on updated_at: a SIGKILLed row's heartbeat
    //               stopped at the kill, and gating on freshness is what made the plain
    //               lease slow — the wall's whole point is to fire without waiting it out.
    // Name the class in `result` so consumers can branch on a code, not copy.
    // A 'timeout' reap is the platform execution-wall kill (preemption/900s
    // SIGKILL) — the canonical PLATFORM_TIMEOUT class the worker also uses; a
    // 'stall' is a server-side dispatch/heartbeat stall.
    const reapCode = reason === 'timeout'
      ? 'PLATFORM_TIMEOUT'
      : reason === 'queued_stall'
        ? 'JOB_NEVER_STARTED'
        : 'JOB_STALLED';
    let query = supabaseAdmin
      .from('video_jobs')
      .update({
        status: 'failed',
        error_message: copy,
        result: { error_code: reapCode, reaped: true, reason: `${reason}_${stage}` },
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('status', stage);
    if (reason === 'timeout') {
      query = query.lte('started_at', new Date(Date.now() - EXEC_WALL_MS).toISOString());
    } else if (reason === 'queued_stall') {
      // Re-verify the job is STILL at current_step=queued and STILL stale at UPDATE
      // time. If the worker wrote its first real step (current_step moved off 'queued')
      // between SELECT and UPDATE, .eq('current_step','queued') fails → no-op, so a job
      // that just came alive is never killed. This is the queued analogue of the stall
      // path's updated_at re-check.
      query = query
        .eq('current_step', 'queued')
        .lte('updated_at', new Date(Date.now() - QUEUED_STALL_MS).toISOString());
    } else {
      query = query.lte('updated_at', new Date(Date.now() - LEASE_MS[stage]).toISOString());
    }
    const { data: updated, error: updErr } = await query.select('id');
    if (updErr) {
      console.error(`[reaper] terminalize failed job=${job.id}:`, updErr.message);
      continue;
    }
    if (!Array.isArray(updated) || updated.length === 0) continue; // lost the race — fine

    reaped++;
    const anchor = reason === 'timeout' && job.started_at ? job.started_at : job.updated_at;
    const ageMin = Math.round((Date.now() - new Date(anchor).getTime()) / 60000);
    console.log(`[reaper] terminalized job=${job.id} reason=${reason}_${stage} age=${ageMin}m user=${job.user_id}`);

    // CANCEL the stranded Modal container so it stops billing (the worker's
    // cancel_call does terminate_containers=True). Best-effort, AFTER the terminal
    // row is won — cost-recovery never gates the reap. At the current 50-55min
    // lease the container is usually already dead at the worker's own 1200s
    // timeout, so this mostly no-ops (idempotent) TODAY — but it is the exact
    // plumbing a progress-aware WATCHDOG will reuse to cancel a stall in MINUTES,
    // and it makes "the reaper never cancels" no longer true. (Zac 2026-08-04)
    await cancelModalCall(supabaseAdmin, job.id).catch(() => {});

    // Operator [ALERT] — a reaped job is a real finish-line death (a 900s
    // SIGKILL at the execution wall, or a dispatch stall) that the worker was
    // killed before it could self-report. This is the ONLY place the length /
    // timeout deaths become visible. Grep-stable log + owner push, best-effort.
    console.error(`[ALERT] reaped render job=${job.id} reason=${reason}_${stage} age=${ageMin}m`);
    if (reason === 'queued_stall') {
      // Known ~15/hr class — accumulate, don't page per-job. Flushed as ONE
      // batched page per QS_ALERT_WINDOW_MS below (the log line above still
      // records every occurrence for forensics).
      _qsAlert.count += 1;
      if (!_qsAlert.sinceMs) _qsAlert.sinceMs = Date.now();
    } else {
      try {
        await sendAlert({
          ownerUserId: OWNER_USER_ID,
          // "[Promptly] render …", never "Render …" — the bare word collides with
          // Render-the-host in the owner's inbox/notifications (real confusion).
          title: reason === 'timeout' ? '⚠️ [Promptly] render hit time limit' : '⚠️ [Promptly] render stalled',
          body: `job ${String(job.id).slice(0, 8)} · ${reason}_${stage} · ${ageMin}m`,
          threadId: 'render-alert',
          supabaseAdmin,
        });
      } catch (e) {
        console.error(`[reaper] owner alert failed job=${job.id}:`, e?.message);
      }
    }

    // Refund through the claim-gated leg (one-shot per job, attribution-safe).
    try {
      const outcome = await refundJobCharge(supabaseAdmin, job);
      console.log(`[reaper] refund job=${job.id} -> ${outcome.action}${outcome.charge ? ` charge=${outcome.charge}` : ''}`);
    } catch (e) {
      console.error(`[reaper] refund failed job=${job.id}:`, e?.message);
    }

    // USER lifecycle push — a reaped render is a terminal failure the user was
    // never told about (they backgrounded the app minutes ago). Body is the
    // same honest stalled/timeout copy the row carries; the chokepoint's flag
    // + per-job claim gating means a restarted sweep can never re-push
    // (first-terminal-wins already stops re-reaping; the claim is the belt).
    try {
      await sendLifecyclePush(supabaseAdmin, {
        jobId: job.id, userId: job.user_id, kind: 'failed',
        errorMessage: copy, refunded: true,
      });
    } catch (e) {
      console.error(`[reaper] user push failed job=${job.id}:`, e?.message);
    }

    // Kill any live spinner immediately.
    if (typeof pushProgressToSSE === 'function') {
      pushProgressToSSE(job.id, {
        status: 'failed',
        progress: 0,
        step: 'error',
        message: '',
        videoUrl: null,
        thumbnailUrl: null,
        final: true,
        error: copy,
      });
    }
  }
  // Flush the batched never-dispatch page (Zac 2026-08-04): ONE page per rolling
  // window with a COUNT, plus a prompt first page when the class re-activates
  // (lastPageMs starts at 0 → the first accumulated occurrence pages immediately,
  // then the window throttles the repeats). Runs every sweep so a window that
  // elapsed with no fresh reap still flushes within one interval.
  if (_qsAlert.count > 0 && Date.now() - _qsAlert.lastPageMs >= QS_ALERT_WINDOW_MS) {
    const _cnt = _qsAlert.count;
    const _mins = _qsAlert.sinceMs ? Math.max(0, Math.round((Date.now() - _qsAlert.sinceMs) / 60000)) : 0;
    console.error(`[ALERT] never-dispatch batch: ${_cnt} job(s) flipped to processing but no worker ran in the last ~${_mins}m (queued_stall)`);
    try {
      await sendAlert({
        ownerUserId: OWNER_USER_ID,
        title: '⚠️ [Promptly] jobs never dispatched',
        body: `${_cnt} job(s) never dispatched (flipped to processing, no worker ran) in the last ~${_mins}m`,
        threadId: 'never-dispatch',
        supabaseAdmin,
      });
    } catch (e) {
      console.error('[reaper] never-dispatch batch alert failed:', e?.message);
    }
    _qsAlert.count = 0;
    _qsAlert.sinceMs = 0;
    _qsAlert.lastPageMs = Date.now();
  }

  return { scanned: Array.isArray(rows) ? rows.length : 0, reaped };
}

module.exports = {
  sweepJobReaper, isPastLease, isPastExecutionWall, isQueuedStall, reapReason,
  LEASE_MS, EXEC_WALL_MS, STALLED_COPY, _qsAlert,
};

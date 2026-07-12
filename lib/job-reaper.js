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

const LEASE_MS = {
  queued: 10 * 60 * 1000,
  processing: 20 * 60 * 1000,
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
// 1200s = 900s ceiling + 300s (Modal cold-start + reaper-interval) slack.
const EXEC_WALL_MS = 20 * 60 * 1000;

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
async function sweepJobReaper(supabaseAdmin, { pushProgressToSSE } = {}) {
  // NO scan horizon (review finding): bounding on created_at permanently hid
  // late-resumed ask-back jobs (a needs_input row answered hours later flips
  // back to processing with its ORIGINAL created_at) and post-outage zombies.
  // The non-terminal set is inherently tiny (the reaper keeps it that way),
  // so a full scan of queued/processing is cheap.
  const { data: rows, error } = await supabaseAdmin
    .from('video_jobs')
    .select('id, user_id, status, progress, created_at, updated_at, started_at')
    .in('status', ['queued', 'processing']);
  if (error) {
    console.error('[reaper] sweep read failed:', error.message);
    return { scanned: 0, reaped: 0 };
  }

  const due = (Array.isArray(rows) ? rows : [])
    .map((r) => ({ job: r, reason: reapReason(r) }))
    .filter((x) => x.reason);
  let reaped = 0;
  for (const { job, reason } of due) {
    const stage = job.status;
    // Copy: a 'timeout' (execution-wall) reap gets the honest time-limit line;
    // otherwise the stage's stall copy.
    const copy = reason === 'timeout'
      ? STALLED_COPY.timeout
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
    let query = supabaseAdmin
      .from('video_jobs')
      .update({ status: 'failed', error_message: copy, updated_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', stage);
    if (reason === 'timeout') {
      query = query.lte('started_at', new Date(Date.now() - EXEC_WALL_MS).toISOString());
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

    // Refund through the claim-gated leg (one-shot per job, attribution-safe).
    try {
      const outcome = await refundJobCharge(supabaseAdmin, job);
      console.log(`[reaper] refund job=${job.id} -> ${outcome.action}${outcome.charge ? ` charge=${outcome.charge}` : ''}`);
    } catch (e) {
      console.error(`[reaper] refund failed job=${job.id}:`, e?.message);
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
  return { scanned: Array.isArray(rows) ? rows.length : 0, reaped };
}

module.exports = {
  sweepJobReaper, isPastLease, isPastExecutionWall, reapReason,
  LEASE_MS, EXEC_WALL_MS, STALLED_COPY,
};

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

// User-facing copy for the reaped row's error_message (cold-load safe:
// no technical vocabulary, passes the iOS display filters).
const STALLED_COPY = {
  queued: "This render didn't get started — you weren't charged. Tap to try again.",
  processing: 'This render stalled on our side — you weren’t charged. Tap to try again.',
};

/**
 * Pure selector — which of these rows are past their lease right now?
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
    .select('id, user_id, status, progress, created_at, updated_at')
    .in('status', ['queued', 'processing']);
  if (error) {
    console.error('[reaper] sweep read failed:', error.message);
    return { scanned: 0, reaped: 0 };
  }

  const due = (Array.isArray(rows) ? rows : []).filter((r) => isPastLease(r));
  let reaped = 0;
  for (const job of due) {
    const stage = job.status;
    // Atomic terminalize: only if the row is STILL in the stalled non-terminal
    // state (first-terminal-wins: a worker terminal or a user cancel that
    // landed between our read and this write wins, and we no-op) AND still
    // STALE at write time (review finding: a heartbeat landing between the
    // sweep's SELECT and this UPDATE refreshes updated_at without changing
    // status — the .lte re-verifies staleness atomically so a job that just
    // came alive is never killed while healthy).
    const staleCutoff = new Date(Date.now() - LEASE_MS[stage]).toISOString();
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('video_jobs')
      .update({
        status: 'failed',
        error_message: STALLED_COPY[stage] || STALLED_COPY.processing,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('status', stage)
      .lte('updated_at', staleCutoff)
      .select('id');
    if (updErr) {
      console.error(`[reaper] terminalize failed job=${job.id}:`, updErr.message);
      continue;
    }
    if (!Array.isArray(updated) || updated.length === 0) continue; // lost the race — fine

    reaped++;
    const ageMin = Math.round((Date.now() - new Date(job.updated_at).getTime()) / 60000);
    console.log(`[reaper] terminalized job=${job.id} stage=stalled_${stage} age=${ageMin}m user=${job.user_id}`);

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
        error: STALLED_COPY[stage] || STALLED_COPY.processing,
      });
    }
  }
  return { scanned: Array.isArray(rows) ? rows.length : 0, reaped };
}

module.exports = { sweepJobReaper, isPastLease, LEASE_MS, STALLED_COPY };

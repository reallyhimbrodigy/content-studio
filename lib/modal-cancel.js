'use strict';
// CANCEL THE CONTAINER BEFORE RECORDING ITS DEATH.
//
// MEASURED (2026-08-03): stalled rows have a median lifetime of 3050s and a max
// of 3093s from started_at to terminalize, against a Modal run_pipeline_bg
// function timeout of exactly 3000s. The container burns its entire 50-minute
// budget and the reaper writes the row a few seconds after Modal gives up. At
// ~$1.40/hr for the orchestrator that is ~$1.17 per stall, ~4/day — about $140
// a month, roughly twelve completed videos' worth of compute, for nothing.
//
// The handle existed the whole time. dispatch retains the spawn's call_id; it
// simply lived in a closure, so the reaper (a separate sweep over DB rows) could
// never see it — and the stalls worth cancelling are precisely the ones that
// OUTLIVE the dispatcher, where the in-process map is already gone. Dispatch now
// persists it to progress_step as `modal_call:<id>`.
//
// WHY AN ENDPOINT RATHER THAN A DIRECT API CALL: content-studio holds NO Modal
// credentials — it reaches Modal only through MODAL_ENDPOINT_URL. The worker is
// already inside Modal and can resolve a FunctionCall directly, so it exposes
// cancel_call, authenticated with the MODAL_CALLBACK_SECRET both sides already
// share (the deploy-time auth ping proves they agree on it).
//
// THIS MUST NEVER BLOCK A REAP. A cancel that fails, times out, or is not
// configured leaves the job exactly as it is today — stalled and terminalized.
// The row write is the contract; the cancel is the money.

const CANCEL_TIMEOUT_MS = 8000;

// WHERE THE HANDLE LIVES, and why not the obvious places:
//   progress_step — looked ideal (constant 'queued' on all 914 recent jobs, no
//     server code updates it) but /api/video-jobs returns rows with select('*'),
//     so a field literally named progress_step reaches the client. Putting
//     `modal_call:fc-…` there risks showing a user an internal Modal handle.
//   partial_state — null on all 914, but the worker owns it for the ask-back
//     resume flow (Phase D), so writing it could collide with a live feature.
//   result.modal_call_id — chosen. `result` already carries internal detail the
//     client receives and ignores (error_where, stage_timings), so this adds no
//     new exposure class, and the worker's completion write replacing it is
//     harmless: a job that completed needs no cancel.
function callIdFromRow(row) {
  const res = row && row.result;
  if (!res || typeof res !== 'object') return null;
  const raw = res.modal_call_id;
  const id = typeof raw === 'string' ? raw.trim() : '';
  return id || null;
}

// Derived from the worker's own endpoint base so there is nothing new to
// configure. MODAL_ENDPOINT_URL points at run_job; the cancel endpoint is a
// sibling on the same deployment.
function cancelUrl() {
  const base = String(process.env.MODAL_CANCEL_URL || '').trim();
  if (base) return base;
  const run = String(process.env.MODAL_ENDPOINT_URL || '').trim();
  if (!run) return null;
  // ...promptlyworker-run-job.modal.run -> ...cancel-call.modal.run
  const m = /^(https:\/\/[^/]*?)promptlyworker-run-job(\.modal\.run.*)$/i.exec(run);
  return m ? `${m[1]}cancel-call${m[2]}` : null;
}

/**
 * Best-effort cancel of a stranded Modal call. Never throws.
 * Returns {attempted, cancelled, reason} so the caller can log truthfully —
 * "attempted but failed" and "never attempted" are different facts, and
 * collapsing them is how a silent no-op reads as a working fix.
 */
async function cancelModalCall(row, { fetchImpl = global.fetch, log = console } = {}) {
  const callId = callIdFromRow(row);
  if (!callId) return { attempted: false, cancelled: false, reason: 'no_call_id' };

  const url = cancelUrl();
  const secret = String(process.env.MODAL_CALLBACK_SECRET || '').trim();
  if (!url) return { attempted: false, cancelled: false, reason: 'no_cancel_url' };
  if (!secret) return { attempted: false, cancelled: false, reason: 'no_secret' };
  if (typeof fetchImpl !== 'function') {
    return { attempted: false, cancelled: false, reason: 'no_fetch' };
  }

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), CANCEL_TIMEOUT_MS) : null;
  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ call_id: callId, secret }),
      signal: ctrl ? ctrl.signal : undefined,
    });
    let body = null;
    try { body = await resp.json(); } catch (_) { /* non-JSON is still a result */ }
    const cancelled = !!(body && body.cancelled);
    log.log(`[reaper-cancel] call=${callId} http=${resp.status} cancelled=${cancelled}`
      + (body && body.error ? ` (${String(body.error).slice(0, 120)})` : ''));
    return {
      attempted: true,
      cancelled,
      reason: cancelled ? 'cancelled' : `not_cancelled_http_${resp.status}`,
      callId,
    };
  } catch (err) {
    log.warn(`[reaper-cancel] call=${callId} FAILED: ${err && err.message}`);
    return { attempted: true, cancelled: false, reason: `error:${err && err.message}`, callId };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { cancelModalCall, callIdFromRow, cancelUrl, CANCEL_TIMEOUT_MS };

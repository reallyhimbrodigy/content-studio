const pendingModalJobs = new Map();

// completion_delivery marker (lane/delivery 2026-08-10). Every settle path stamps
// HOW the completion reached the dispatcher, so a fallback settlement can never
// masquerade as a normal completion again (the 41-jobs-at-the-900s-wall class was
// invisible for weeks because nothing recorded the delivery mechanism). Values:
//   'callback'      — the worker's /api/modal-complete POST (primary, instant)
//   'webhook'       — the Modal platform webhook
//   'durable_poll'  — the dispatcher's early poll of the worker's durable row
//   'fallback_timer'— the 15-min registerPendingModalJob timeout fired
//   'reconciler'    — the re-spawn evaluation's Supabase re-check projected it
// Stamped ONLY onto plain-object COMPLETED outputs, first-stamp-wins (the first
// mechanism to settle is the one that delivered — settle-once dedups the rest).
function stampDelivery(output, via) {
  if (via && output && typeof output === 'object' && !Array.isArray(output)
      && !output.completion_delivery) {
    output.completion_delivery = via;
  }
  return output;
}

// TWO SHAPES REACH THE DISPATCHER, AND CONFLATING THEM COST THE WHOLE INSTRUMENT
// (lane/delivery-2, 2026-08-14) [Law 1 + Law 2].
//
//   OUTPUT shape    what registerPendingModalJob RESOLVES with. settlePendingModalJob
//                   does `pending.resolve(stampDelivery(output, via))` and the timeout
//                   does `resolveAndCleanup(stampDelivery(fallback?.output, ...))`.
//                   So `result` is the worker's OUTPUT: `status:'success'` (lowercase,
//                   the worker's own word) with video_url at the TOP level.
//   ENVELOPE shape  what resolveSpawnedCompletionFallback RETURNS:
//                   `{status:'COMPLETED', output:{video_url}}`.
//
// dispatch-to-modal's `_delivered` tested ONLY the envelope — `status==='COMPLETED'`
// or `result.output.video_url`. Against an OUTPUT-shaped result BOTH disjuncts are
// false, so callback, durable_poll and fallback_timer each delivered a video and then
// read as undelivered. Two consequences, one cause:
//
//   1. THE INSTRUMENT. Every job fell into the re-spawn evaluation, which re-reads
//      Supabase, decides 'project', and stamps 'reconciler'. The reconciler took the
//      credit for work the primary paths did — which is precisely the measured
//      465 completions = 442 reconciler / 23 repair / 0 callback / 0 durable_poll /
//      0 fallback_timer. The zeros were never real. Three of the five values were
//      unreachable by construction, so we have been holding a 120-second law on a
//      delivery path we could not see.
//   2. THE DOUBLE RENDER. A delivered job entering the re-spawn evaluation is one
//      failed DB read away from being re-spawned: respawnDecision only returns
//      'project' if the RE-CHECK sees COMPLETED, and returns 'respawn' on
//      dbNonTerminal. Correct shape handling means a delivered job never enters that
//      evaluation at all — the guard stops being load-bearing. This ships BEFORE any
//      Lumen render exists, because a double render of a Lumen job is double the
//      most expensive render we have.
//
// Accepts BOTH shapes deliberately. A predicate that knows only the shape its author
// had in mind is exactly what failed here.
function isDeliveredResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const status = String(result.status || '').toLowerCase();
  // ENVELOPE: explicit terminal success, or a nested output carrying a URL.
  if (status === 'completed') return true;
  const out = result.output;
  if (out && typeof out === 'object'
      && (out.video_url || out.public_url || out.rendered_video_url)) return true;
  // OUTPUT: the worker's own success word, or a URL at the top level. All three
  // URL field names are accepted for the same reason the fallback accepts them —
  // a worker that wrote public_url instead of video_url has still delivered.
  if (status === 'success') return true;
  if (result.video_url || result.public_url || result.rendered_video_url) return true;
  return false;
}

function getPendingModalJobs() {
  return pendingModalJobs;
}

function registerPendingModalJob(modalJobId, { timeoutMs = 120_000, onTimeoutCheck } = {}) {
  if (!modalJobId) {
    return Promise.reject(new Error('modalJobId is required'));
  }

  return new Promise((resolve, reject) => {
    const rejectAndCleanup = (err) => {
      const pending = pendingModalJobs.get(modalJobId);
      if (pending?.timeout) clearTimeout(pending.timeout);
      pendingModalJobs.delete(modalJobId);
      reject(err);
    };

    const resolveAndCleanup = (output) => {
      const pending = pendingModalJobs.get(modalJobId);
      if (pending?.timeout) clearTimeout(pending.timeout);
      pendingModalJobs.delete(modalJobId);
      resolve(output);
    };

    const timeout = setTimeout(async () => {
      try {
        if (typeof onTimeoutCheck !== 'function') {
          rejectAndCleanup(new Error(`Modal webhook timeout for job ${modalJobId}`));
          return;
        }
        const fallback = await onTimeoutCheck();
        const status = String(fallback?.status || '').toUpperCase();
        if (status === 'COMPLETED') {
          resolveAndCleanup(stampDelivery(fallback?.output, 'fallback_timer'));
          return;
        }
        const errMsg = fallback?.error || `Modal webhook timeout and fallback status=${status || 'UNKNOWN'}`;
        rejectAndCleanup(new Error(errMsg));
      } catch (err) {
        rejectAndCleanup(err instanceof Error ? err : new Error(String(err)));
      }
    }, timeoutMs);

    pendingModalJobs.set(modalJobId, {
      resolve: resolveAndCleanup,
      reject: rejectAndCleanup,
      timeout,
    });
  });
}

function settlePendingModalJob({ id, status, output, error, via }) {
  const modalJobId = String(id || '').trim();
  if (!modalJobId) return false;
  const pending = pendingModalJobs.get(modalJobId);
  if (!pending) return false;

  const normalizedStatus = String(status || '').toUpperCase();
  if (normalizedStatus === 'COMPLETED') {
    pending.resolve(stampDelivery(output, via));
    return true;
  }
  pending.reject(new Error(error || `Modal job failed with status ${normalizedStatus || 'UNKNOWN'}`));
  return true;
}

module.exports = {
  getPendingModalJobs,
  pendingModalJobs,
  registerPendingModalJob,
  settlePendingModalJob,
  stampDelivery,
  isDeliveredResult,
};

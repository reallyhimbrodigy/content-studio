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
};

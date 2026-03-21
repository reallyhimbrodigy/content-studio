const pendingModalJobs = new Map();

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
          resolveAndCleanup(fallback?.output);
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

function settlePendingModalJob({ id, status, output, error }) {
  const modalJobId = String(id || '').trim();
  if (!modalJobId) return false;
  const pending = pendingModalJobs.get(modalJobId);
  if (!pending) return false;

  const normalizedStatus = String(status || '').toUpperCase();
  if (normalizedStatus === 'COMPLETED') {
    pending.resolve(output);
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
};

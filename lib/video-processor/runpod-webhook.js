const pendingRunpodJobs = new Map();

function getPendingRunpodJobs() {
  return pendingRunpodJobs;
}

function registerPendingRunpodJob(runpodJobId, { timeoutMs = 120_000, onTimeoutCheck } = {}) {
  if (!runpodJobId) {
    return Promise.reject(new Error('runpodJobId is required'));
  }

  return new Promise((resolve, reject) => {
    const rejectAndCleanup = (err) => {
      const pending = pendingRunpodJobs.get(runpodJobId);
      if (pending?.timeout) clearTimeout(pending.timeout);
      pendingRunpodJobs.delete(runpodJobId);
      reject(err);
    };

    const resolveAndCleanup = (output) => {
      const pending = pendingRunpodJobs.get(runpodJobId);
      if (pending?.timeout) clearTimeout(pending.timeout);
      pendingRunpodJobs.delete(runpodJobId);
      resolve(output);
    };

    const timeout = setTimeout(async () => {
      try {
        if (typeof onTimeoutCheck !== 'function') {
          rejectAndCleanup(new Error(`RunPod webhook timeout for job ${runpodJobId}`));
          return;
        }
        const fallback = await onTimeoutCheck();
        const status = String(fallback?.status || '').toUpperCase();
        if (status === 'COMPLETED') {
          resolveAndCleanup(fallback?.output);
          return;
        }
        const errMsg = fallback?.error || `RunPod webhook timeout and fallback status=${status || 'UNKNOWN'}`;
        rejectAndCleanup(new Error(errMsg));
      } catch (err) {
        rejectAndCleanup(err instanceof Error ? err : new Error(String(err)));
      }
    }, timeoutMs);

    pendingRunpodJobs.set(runpodJobId, {
      resolve: resolveAndCleanup,
      reject: rejectAndCleanup,
      timeout,
    });
  });
}

function settlePendingRunpodJob({ id, status, output, error }) {
  const runpodJobId = String(id || '').trim();
  if (!runpodJobId) return false;
  const pending = pendingRunpodJobs.get(runpodJobId);
  if (!pending) return false;

  const normalizedStatus = String(status || '').toUpperCase();
  if (normalizedStatus === 'COMPLETED') {
    pending.resolve(output);
    return true;
  }
  pending.reject(new Error(error || `RunPod job failed with status ${normalizedStatus || 'UNKNOWN'}`));
  return true;
}

module.exports = {
  getPendingRunpodJobs,
  pendingRunpodJobs,
  registerPendingRunpodJob,
  settlePendingRunpodJob,
};

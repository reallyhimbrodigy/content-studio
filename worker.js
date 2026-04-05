const { supabaseAdmin } = require('./services/supabase-admin');

const CLEANUP_INTERVAL_MS = Number(process.env.VIDEO_WORKER_POLL_MS || 30000);
const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
let workerRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupStaleJobs() {
  if (!supabaseAdmin) return;
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

  const { data: stale, error } = await supabaseAdmin
    .from('video_jobs')
    .update({
      status: 'failed',
      error_message: 'Job timed out (processing exceeded 15 minutes)',
      current_step: 'Failed',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'processing')
    .lt('updated_at', cutoff)
    .select('id');

  if (error) {
    console.error(`[VideoWorker] Stale cleanup error: ${error.message}`);
    return;
  }

  if (stale?.length > 0) {
    console.log(`[VideoWorker] Cleaned up ${stale.length} stale jobs:`, stale.map((j) => j.id));
  }
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  console.log(`[VideoWorker] Started (stale-job cleanup only). Interval ${CLEANUP_INTERVAL_MS}ms`);

  while (workerRunning) {
    try {
      await cleanupStaleJobs();
    } catch (error) {
      console.error('[VideoWorker] Cleanup error:', error?.message || error);
    }
    await sleep(CLEANUP_INTERVAL_MS);
  }
}

function stopWorker() {
  workerRunning = false;
}

process.on('SIGINT', () => {
  console.log('[VideoWorker] SIGINT received, stopping...');
  stopWorker();
});

process.on('SIGTERM', () => {
  console.log('[VideoWorker] SIGTERM received, stopping...');
  stopWorker();
});
process.on('uncaughtException', (err) => {
  console.error('[VideoWorker][FATAL] Uncaught exception:', err?.message || err);
  if (err?.stack) console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[VideoWorker][FATAL] Unhandled rejection:', reason);
  if (reason?.stack) console.error(reason.stack);
});

module.exports = { runWorker, stopWorker };

if (require.main === module) {
  runWorker().catch((error) => {
    console.error('[VideoWorker] Fatal startup error:', error);
    process.exit(1);
  });
}

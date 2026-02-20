const { supabaseAdmin } = require('./services/supabase-admin');
const { processEditJob } = require('./lib/video-processor/process-job');

const POLL_INTERVAL_MS = Number(process.env.VIDEO_WORKER_POLL_MS || 5000);
let workerRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function claimNextQueuedJob() {
  if (!supabaseAdmin) throw new Error('supabase_not_configured');

  const { data: jobs, error } = await supabaseAdmin
    .from('edit_jobs')
    .select('*')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) throw new Error(`Failed to fetch queued jobs: ${error.message}`);
  const job = jobs?.[0];
  if (!job) return null;

  const { data: claimed, error: claimError } = await supabaseAdmin
    .from('edit_jobs')
    .update({
      status: 'processing',
      progress: Number(job.progress || 0),
      started_at: job.started_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id)
    .eq('status', 'queued')
    .select('*')
    .single();

  if (claimError || !claimed) return null;
  return claimed;
}

async function processOneJob(job) {
  console.log(`[VideoWorker] Processing job ${job.id}`);
  try {
    await processEditJob(job);
    console.log(`[VideoWorker] Completed job ${job.id}`);
  } catch (error) {
    console.error(`[VideoWorker] Failed job ${job.id}:`, error?.message || error);
  }
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  console.log(`[VideoWorker] Started. Poll interval ${POLL_INTERVAL_MS}ms`);

  while (workerRunning) {
    try {
      const job = await claimNextQueuedJob();
      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      await processOneJob(job);
    } catch (error) {
      console.error('[VideoWorker] Loop error:', error?.message || error);
      await sleep(POLL_INTERVAL_MS);
    }
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

module.exports = { runWorker, stopWorker };

if (require.main === module) {
  runWorker().catch((error) => {
    console.error('[VideoWorker] Fatal startup error:', error);
    process.exit(1);
  });
}


const { supabaseAdmin } = require('./services/supabase-admin');
const { processVideoJob } = require('./lib/video-processor/process-job');

const POLL_INTERVAL_MS = Number(process.env.VIDEO_WORKER_POLL_MS || 5000);
let workerRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function claimNextQueuedJob() {
  if (!supabaseAdmin) throw new Error('supabase_not_configured');

  const { data: jobs, error } = await supabaseAdmin
    .from('video_jobs')
    .select('*')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) throw new Error(`Failed to fetch queued jobs: ${error.message}`);
  const job = jobs?.[0];
  if (!job) return null;

  const { data: claimed, error: claimError } = await supabaseAdmin
    .from('video_jobs')
    .update({
      status: 'processing',
      progress: Number(job.progress || 0),
      current_step: 'Queued',
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
    const onProgress = async (progress, step) => {
      await supabaseAdmin
        .from('video_jobs')
        .update({
          status: 'processing',
          progress: Number(progress || 0),
          current_step: String(step || 'Processing'),
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id);
    };

    const result = await processVideoJob({
      videoUrl: job.video_url,
      vibeInput: job.vibe_input,
      jobId: job.id,
      onProgress,
    });

    await supabaseAdmin
      .from('video_jobs')
      .update({
        status: 'completed',
        progress: 100,
        current_step: 'Completed',
        result_url: result.rendered_video_url || null,
        content_type: result.contentType || null,
        vibe_params: result.vibeParams || null,
        edit_recipe: result.editRecipe || null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    console.log(`[VideoWorker] Completed job ${job.id}`);
  } catch (error) {
    console.error(`[VideoWorker] Failed job ${job.id}:`, error?.message || error);
    await supabaseAdmin
      .from('video_jobs')
      .update({
        status: 'failed',
        error_message: String(error?.message || 'Unknown processing error'),
        current_step: 'Failed',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);
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

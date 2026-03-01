const { supabaseAdmin } = require('./services/supabase-admin');
const { processVideoJob } = require('./lib/video-processor/process-job');

const POLL_INTERVAL_MS = Number(process.env.VIDEO_WORKER_POLL_MS || 1000);
let workerRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function markJobCompleted(jobId, resultData, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from('video_jobs')
      .update({
        status: 'completed',
        progress: 100,
        current_step: 'Completed',
        result_url: resultData.rendered_video_url || null,
        edit_recipe: resultData.edit_recipe || null,
        completed_at: now,
        updated_at: now,
      })
      .eq('id', jobId)
      .eq('status', 'processing');

    if (error) {
      console.error(`[VideoWorker] Update attempt ${attempt + 1} error: ${error.message}`);
      await sleep(500);
      continue;
    }

    const { data: check, error: checkError } = await supabaseAdmin
      .from('video_jobs')
      .select('status, result_url')
      .eq('id', jobId)
      .maybeSingle();

    if (checkError) {
      console.error(`[VideoWorker] Verify attempt ${attempt + 1} error: ${checkError.message}`);
      await sleep(500);
      continue;
    }

    if (check?.status === 'completed') {
      console.log(`[VideoWorker] Job ${jobId} marked completed on attempt ${attempt + 1}`);
      return true;
    }

    await sleep(500);
  }

  console.error(`[VideoWorker] CRITICAL: Failed to mark job ${jobId} as completed after ${maxRetries} attempts`);
  return false;
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

async function cleanupStaleJobs() {
  if (!supabaseAdmin) throw new Error('supabase_not_configured');
  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const { data: stale, error } = await supabaseAdmin
    .from('video_jobs')
    .update({
      status: 'failed',
      error_message: 'Job timed out (worker may have crashed)',
      current_step: 'Failed',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'processing')
    .lt('updated_at', fifteenMinAgo)
    .select('id');

  if (error) {
    throw new Error(`Failed to cleanup stale jobs: ${error.message}`);
  }

  if (stale?.length > 0) {
    console.log(`[VideoWorker] Cleaned up ${stale.length} stale jobs:`, stale.map((j) => j.id));
  }
}

async function processOneJob(job) {
  console.log(`[VideoWorker] Processing job ${job.id}`);
  try {
    const onProgress = async (progress, step) => {
      const updateData = {
        status: 'processing',
        current_step: String(step || 'Processing'),
        updated_at: new Date().toISOString(),
      };
      if (progress != null) {
        updateData.progress = Number(progress);
      }

      await supabaseAdmin
        .from('video_jobs')
        .update(updateData)
        .eq('id', job.id)
        .eq('status', 'processing');
    };

    const result = await processVideoJob({
      videoUrl: job.video_url,
      vibeInput: job.vibe_input,
      jobId: job.id,
      userId: job.user_id,
      onProgress,
    });

    console.log(`[VideoWorker] Uploading complete, saving result for job ${job.id}...`);
    console.log(`[VideoWorker] Result keys: ${Object.keys(result || {}).join(', ')}`);
    console.log(`[VideoWorker] result_url: ${result.rendered_video_url ? 'present' : 'missing'}`);
    console.log(`[VideoWorker] edit_recipe: ${result.edit_recipe ? `${JSON.stringify(result.edit_recipe).length} chars` : 'missing'}`);

    const completed = await markJobCompleted(job.id, result, 3);
    if (!completed) {
      throw new Error(`Failed to mark job ${job.id} as completed`);
    }
    console.log(`[VideoWorker] Completed job ${job.id}`);
  } catch (error) {
    console.error(`[VideoWorker] Failed job ${job.id}:`, error?.message || error);
    const { data: failResult, error: failError } = await supabaseAdmin
      .from('video_jobs')
      .update({
        status: 'failed',
        error_message: String(error?.message || 'Unknown processing error').substring(0, 1000),
        current_step: 'Failed',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .select();

    console.log(`[VideoWorker] Fail update result:`, JSON.stringify(failResult));

    if (failError) {
      console.error(`[VideoWorker] Could not update failed status:`, failError);
    }
  }
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  console.log(`[VideoWorker] Started. Poll interval ${POLL_INTERVAL_MS}ms`);

  while (workerRunning) {
    try {
      await cleanupStaleJobs();
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

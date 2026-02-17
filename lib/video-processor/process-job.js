const { supabaseAdmin: supabase } = require('../../services/supabase-admin');
const { analyzeClip } = require('./analyze-clip');
const { interpretVibe } = require('./interpret-vibe');
const { generateEditRecipe } = require('./generate-edit-recipe');
const { generateMultipleSFX } = require('./generate-sfx');
const { buildShotstackTimeline, submitToShotstack, pollShotstackRender } = require('./render-video');

/**
 * Generic database updater for edit_jobs.
 * @param {string} jobId
 * @param {Record<string, any>} updates
 * @returns {Promise<void>}
 */
async function updateJobInDatabase(jobId, updates) {
  if (!supabase) throw new Error('updateJobInDatabase: supabaseAdmin is not configured');
  if (!jobId) throw new Error('updateJobInDatabase: jobId is required');
  if (!updates || typeof updates !== 'object') throw new Error('updateJobInDatabase: updates must be an object');

  const payload = { ...updates, updated_at: new Date().toISOString() };
  const { error } = await supabase.from('edit_jobs').update(payload).eq('id', jobId);
  if (error) {
    throw new Error(`updateJobInDatabase: failed for job ${jobId} - ${error.message}`);
  }
}

/**
 * Update pipeline status/progress and optional fields in edit_jobs.
 * @param {string} jobId
 * @param {string} status
 * @param {number} progress
 * @param {object} [data]
 * @returns {Promise<void>}
 */
async function updateJobStatus(jobId, status, progress, data = {}) {
  if (!supabase) throw new Error('updateJobStatus: supabaseAdmin is not configured');
  if (!jobId) throw new Error('updateJobStatus: jobId is required');

  const updates = {
    status,
    progress,
    updated_at: new Date().toISOString(),
  };

  if (data.clipAnalysis) updates.clip_analysis = data.clipAnalysis;
  if (data.vibeParams) updates.vibe_params = data.vibeParams;
  if (data.editRecipe) updates.edit_recipe = data.editRecipe;
  if (data.renderedVideoUrl) {
    updates.rendered_video_url = data.renderedVideoUrl;
    updates.completed_at = new Date().toISOString();
  }
  if (data.error) updates.error = String(data.error);

  const { error } = await supabase.from('edit_jobs').update(updates).eq('id', jobId);
  if (error) {
    throw new Error(`updateJobStatus: failed for job ${jobId} - ${error.message}`);
  }

  console.log('[processEditJob] Job status updated', {
    jobId,
    status,
    progress,
    updatedFields: Object.keys(updates),
  });
}

/**
 * Run full AI video editing pipeline for one job.
 * @param {{ id: string, video_url: string, vibe_input: string, user_id: string }} job
 * @returns {Promise<string>}
 */
async function processEditJob(job) {
  if (!job || typeof job !== 'object') throw new Error('processEditJob: job is required');
  if (!job.id) throw new Error('processEditJob: job.id is required');
  if (!job.video_url) throw new Error('processEditJob: job.video_url is required');
  if (!job.vibe_input) throw new Error('processEditJob: job.vibe_input is required');

  console.log('[processEditJob] Starting job', {
    jobId: job.id,
    userId: job.user_id,
    videoUrl: job.video_url,
  });

  try {
    // STEP 1: Update status to analyzing (10)
    await updateJobStatus(job.id, 'analyzing', 10);

    // STEP 2: Analyze clip
    const clipAnalysis = await analyzeClip(job.video_url);
    await updateJobStatus(job.id, 'analyzing', 30, { clipAnalysis });

    // STEP 3: Interpret vibe
    const vibeParams = await interpretVibe(job.vibe_input, clipAnalysis);
    await updateJobStatus(job.id, 'editing', 50, { vibeParams });

    // STEP 4: Generate edit recipe
    const editRecipe = generateEditRecipe(clipAnalysis, vibeParams);
    await updateJobStatus(job.id, 'editing', 65, { editRecipe });

    // STEP 5: Generate SFX assets
    let sfxAssets = [];
    if (Array.isArray(editRecipe?.sfxPlacements) && editRecipe.sfxPlacements.length > 0) {
      sfxAssets = await generateMultipleSFX(editRecipe.sfxPlacements);
    }
    await updateJobStatus(job.id, 'rendering', 75);

    // STEP 6: Build Shotstack timeline
    const timeline = buildShotstackTimeline(clipAnalysis, editRecipe, job.video_url, sfxAssets);
    await updateJobStatus(job.id, 'rendering', 80);

    // STEP 7: Submit to Shotstack
    const { renderId } = await submitToShotstack(timeline);
    await updateJobInDatabase(job.id, { shotstack_render_id: renderId });
    await updateJobStatus(job.id, 'rendering', 85);

    // STEP 8: Poll for completion
    const finalVideoUrl = await pollShotstackRender(renderId);
    await updateJobStatus(job.id, 'complete', 100, { renderedVideoUrl: finalVideoUrl });

    // STEP 9: Return final URL
    console.log('[processEditJob] Job completed', { jobId: job.id, finalVideoUrl });
    return finalVideoUrl;
  } catch (error) {
    console.error('[processEditJob] Job failed', {
      jobId: job.id,
      message: error?.message || error,
      stack: error?.stack || null,
    });

    try {
      await updateJobStatus(job.id, 'error', 0, { error: error?.message || 'Unknown error' });
    } catch (updateError) {
      console.error('[processEditJob] Failed to persist error status', {
        jobId: job.id,
        message: updateError?.message || updateError,
      });
    }

    throw error;
  }
}

module.exports = {
  updateJobInDatabase,
  updateJobStatus,
  processEditJob,
};

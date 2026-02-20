const { supabaseAdmin: supabase } = require('../../services/supabase-admin');
const { analyzeClip } = require('./analyze-clip');
const { detectContentType } = require('./detect-content-type');
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
  if (data.contentType) updates.content_type = data.contentType;
  if (data.vibeParams) updates.vibe_params = data.vibeParams;
  if (data.editRecipe) updates.edit_recipe = data.editRecipe;
  if (data.renderedVideoUrl) {
    updates.rendered_video_url = data.renderedVideoUrl;
    updates.completed_at = new Date().toISOString();
  }
  if (data.error) updates.error = String(data.error);

  let { error } = await supabase.from('edit_jobs').update(updates).eq('id', jobId);
  if (error && updates.content_type) {
    const message = String(error.message || '').toLowerCase();
    if (message.includes('content_type')) {
      // Backward compatibility: database may not have content_type column yet.
      delete updates.content_type;
      ({ error } = await supabase.from('edit_jobs').update(updates).eq('id', jobId));
    }
  }
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

    // STEP 3: Detect content type
    console.log('[processEditJob] Detecting content type...');
    const contentType = await detectContentType(clipAnalysis);
    console.log('[processEditJob] Content type detected', {
      primaryType: contentType?.primaryType,
      confidencePct: Math.round((Number(contentType?.confidence) || 0) * 100),
    });
    await updateJobStatus(job.id, 'analyzing', 40, { clipAnalysis, contentType });

    // STEP 4: Interpret vibe with content context
    const vibeParams = await interpretVibe(job.vibe_input, clipAnalysis, contentType);
    await updateJobStatus(job.id, 'editing', 50, { vibeParams, contentType });

    // STEP 5: Generate edit recipe
    const editRecipe = generateEditRecipe(clipAnalysis, vibeParams);
    await updateJobStatus(job.id, 'editing', 65, { editRecipe });

    // STEP 6: Generate SFX assets
    let sfxAssets = [];
    if (Array.isArray(editRecipe?.sfxPlacements) && editRecipe.sfxPlacements.length > 0) {
      sfxAssets = await generateMultipleSFX(editRecipe.sfxPlacements);
    }
    await updateJobStatus(job.id, 'rendering', 75);

    // STEP 7: Build Shotstack timeline
    const timeline = buildShotstackTimeline(clipAnalysis, editRecipe, job.video_url, sfxAssets);
    await updateJobStatus(job.id, 'rendering', 80);

    // STEP 8: Submit to Shotstack
    const { renderId } = await submitToShotstack(timeline);
    await updateJobInDatabase(job.id, { shotstack_render_id: renderId });
    await updateJobStatus(job.id, 'rendering', 85);

    // STEP 9: Poll for completion
    const finalVideoUrl = await pollShotstackRender(renderId);
    await updateJobStatus(job.id, 'complete', 100, { renderedVideoUrl: finalVideoUrl });

    // STEP 10: Return final URL
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
  processVideoJob,
};

/**
 * Run full AI video editing pipeline for external queue workers without DB writes.
 * Use `onProgress` to persist progress/status in the caller's table.
 * @param {{ videoUrl: string, vibeInput: string, jobId?: string, onProgress?: (progress:number, step:string)=>Promise<void>|void }} input
 * @returns {Promise<{ rendered_video_url: string, contentType: any, vibeParams: any, editRecipe: any }>}
 */
async function processVideoJob(input) {
  if (!input || typeof input !== 'object') throw new Error('processVideoJob: input is required');
  const videoUrl = String(input.videoUrl || '').trim();
  const vibeInput = String(input.vibeInput || '').trim();
  const onProgress = typeof input.onProgress === 'function' ? input.onProgress : null;
  if (!videoUrl) throw new Error('processVideoJob: videoUrl is required');
  if (!vibeInput) throw new Error('processVideoJob: vibeInput is required');

  console.log(`\n${'='.repeat(70)}`);
  console.log('PROCESSING VIDEO JOB');
  console.log('='.repeat(70));
  console.log('Video URL:', videoUrl);
  console.log('Vibe:', vibeInput);
  console.log('Job ID:', input.jobId || '(not provided)');
  console.log('='.repeat(70));

  const report = async (progress, step) => {
    if (!onProgress) return;
    try {
      await onProgress(progress, step);
    } catch (err) {
      console.warn('[processVideoJob] progress callback failed', err?.message || err);
    }
  };

  await report(10, 'Analyzing clip');
  const clipAnalysis = await analyzeClip(videoUrl);
  console.log('✓ Clip analyzed:', {
    duration: clipAnalysis?.duration,
    fps: clipAnalysis?.fps,
    dimensions: clipAnalysis?.dimensions || null,
    beatCount: Array.isArray(clipAnalysis?.audio?.beats) ? clipAnalysis.audio.beats.length : 0,
    transcriptSegments: Array.isArray(clipAnalysis?.audio?.transcript) ? clipAnalysis.audio.transcript.length : 0,
  });

  await report(30, 'Detecting content type');
  const contentType = await detectContentType(clipAnalysis);
  console.log('✓ Content type detected:', contentType);

  await report(45, 'Interpreting vibe');
  const vibeParams = await interpretVibe(vibeInput, clipAnalysis, contentType);
  console.log('✓ Vibe interpreted:', JSON.stringify(vibeParams, null, 2));

  await report(60, 'Generating edit recipe');
  const editRecipe = generateEditRecipe(clipAnalysis, vibeParams);
  console.log('✓ Edit recipe generated:');
  console.log('  - Number of cuts:', editRecipe?.cuts?.length || 0);
  console.log('  - Number of transitions:', editRecipe?.transitions?.length || 0);
  console.log('  - Number of captions:', editRecipe?.captions?.length || 0);
  console.log('  - Number of animations:', editRecipe?.animations?.length || 0);
  console.log('  - Number of sfx placements:', editRecipe?.sfxPlacements?.length || 0);
  console.log('  - Duration:', editRecipe?.metadata?.duration || clipAnalysis?.duration || 'unknown');
  console.log('  - Full recipe:', JSON.stringify(editRecipe, null, 2));

  await report(75, 'Generating SFX');
  let sfxAssets = [];
  if (Array.isArray(editRecipe?.sfxPlacements) && editRecipe.sfxPlacements.length > 0) {
    sfxAssets = await generateMultipleSFX(editRecipe.sfxPlacements);
  }
  console.log('✓ SFX assets generated:', {
    requested: editRecipe?.sfxPlacements?.length || 0,
    generated: sfxAssets.length,
  });

  await report(82, 'Building timeline');
  const timeline = buildShotstackTimeline(clipAnalysis, editRecipe, videoUrl, sfxAssets);
  console.log('✓ Timeline built:');
  console.log('  - Number of tracks:', timeline?.timeline?.tracks?.length || 0);
  console.log('  - Track clip counts:', (timeline?.timeline?.tracks || []).map((t) => t?.clips?.length || 0));
  const firstTrack = timeline?.timeline?.tracks?.[0]?.clips || [];
  console.log('  - Video clips with trim/start/length:', firstTrack.map((clip, index) => ({
    index,
    trim: clip?.asset?.trim,
    start: clip?.start,
    length: clip?.length,
    fit: clip?.fit,
    scale: clip?.scale,
  })));
  console.log('  - Full timeline:', JSON.stringify(timeline, null, 2));

  await report(88, 'Submitting render');
  const { renderId } = await submitToShotstack(timeline);
  console.log('✓ Shotstack render submitted:', { renderId });

  await report(92, 'Rendering video');
  const renderedVideoUrl = await pollShotstackRender(renderId);
  console.log('✓ Video rendered:', renderedVideoUrl);

  await report(100, 'Completed');
  console.log('='.repeat(70) + '\n');
  return {
    rendered_video_url: renderedVideoUrl,
    contentType,
    vibeParams,
    editRecipe,
    renderId,
  };
}

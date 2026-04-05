const { supabaseAdmin } = require('../../services/supabase-admin');

function normalizeSignedUploadUrl(signedUrl) {
  if (!signedUrl) return signedUrl;
  if (signedUrl.startsWith('http://') || signedUrl.startsWith('https://')) return signedUrl;
  const base = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error('Missing SUPABASE_URL for signed upload URL normalization');
  return `${base}${signedUrl}`;
}

async function dispatchJobToModal({ jobId, videoUrl, vibe, userId, pushProgressToSSE }) {
  if (!supabaseAdmin) throw new Error('supabase_not_configured');

  const modalEndpointUrl = process.env.MODAL_ENDPOINT_URL;
  if (!modalEndpointUrl) throw new Error('MODAL_ENDPOINT_URL is required');

  const { data: existingJob } = await supabaseAdmin
    .from('video_jobs')
    .select('id, status')
    .eq('id', jobId)
    .single();

  if (existingJob?.status === 'processing') {
    console.log(`[dispatch] Job ${jobId} already processing — skipping duplicate`);
    return { jobId: existingJob.id || jobId, publicUrl: null };
  }

  // 1. Check Gemini analysis cache
  let cachedAnalysis = null;
  try {
    const { data } = await supabaseAdmin
      .from('video_analysis_cache')
      .select('analysis')
      .eq('video_url', videoUrl)
      .maybeSingle();
    if (data?.analysis) {
      cachedAnalysis = data.analysis;
      console.log(`[dispatch] Gemini cache HIT for job ${jobId}`);
      console.log(`[dispatch] cached_analysis: ${JSON.stringify(cachedAnalysis).length} chars`);
    } else {
      console.log(`[dispatch] Gemini cache MISS for job ${jobId} — cached_analysis: not available`);
    }
  } catch (e) {
    console.log(`[dispatch] Cache lookup failed: ${e.message}`);
  }

  // 2. Create signed upload URLs (video + thumbnail)
  const timestamp = Date.now();
  const outputPath = `${jobId}/${timestamp}-edited.mp4`;
  const thumbPath = `thumbnails/${jobId}.jpg`;

  const [videoSignedResult, thumbSignedResult] = await Promise.all([
    supabaseAdmin.storage.from('videos').createSignedUploadUrl(outputPath, { upsert: true }),
    supabaseAdmin.storage.from('videos').createSignedUploadUrl(thumbPath, { upsert: true }),
  ]);

  const { data: signedData, error: signedError } = videoSignedResult;
  if (signedError || !signedData?.signedUrl) {
    throw new Error(`Failed to create signed upload URL: ${signedError?.message || 'missing signed URL'}`);
  }

  const uploadUrl = normalizeSignedUploadUrl(signedData.signedUrl);
  const { data: publicData } = supabaseAdmin.storage.from('videos').getPublicUrl(outputPath);
  const publicUrl = publicData?.publicUrl;

  // Thumbnail upload URL (non-fatal if it fails)
  let uploadUrlThumb = null;
  let thumbnailPublicUrl = null;
  if (!thumbSignedResult.error && thumbSignedResult.data?.signedUrl) {
    uploadUrlThumb = normalizeSignedUploadUrl(thumbSignedResult.data.signedUrl);
    const { data: thumbPublicData } = supabaseAdmin.storage.from('videos').getPublicUrl(thumbPath);
    thumbnailPublicUrl = thumbPublicData?.publicUrl || null;
  } else {
    console.warn(`[dispatch] Failed to create thumbnail upload URL: ${thumbSignedResult.error?.message || 'unknown'}`);
  }

  // 3. Build payload
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  if (!appUrl) throw new Error('APP_URL is required');

  const payload = {
    job_id: jobId,
    video_url: videoUrl,
    vibe,
    user_id: userId,
    upload_url: uploadUrl,
    public_url: publicUrl,
    app_url: appUrl,
    ...(uploadUrlThumb ? { upload_url_thumb: uploadUrlThumb } : {}),
    ...(cachedAnalysis ? { cached_analysis: cachedAnalysis } : {}),
  };

  // 4. Update job to processing immediately so SSE fires
  await supabaseAdmin
    .from('video_jobs')
    .update({
      status: 'processing',
      current_step: 'queued',
      step_message: 'Getting started...',
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  // 5. Fire Modal request in background — Modal is synchronous so we await the response
  // Progress updates arrive via /api/modal-progress during execution
  // The final video URL comes back in the Modal HTTP response body
  console.log(`[dispatch] Firing Modal job for ${jobId}`);

  (async () => {
    try {
      const res = await fetch(modalEndpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[dispatch] Modal returned ${res.status}: ${text}`);
        await supabaseAdmin
          .from('video_jobs')
          .update({
            status: 'failed',
            error_message: `Modal error: ${res.status}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId);
        return { jobId, publicUrl };
      }

      // Modal returns the pipeline result — extract video URL
      const result = await res.json().catch(() => ({}));
      console.log(`[dispatch] Modal job complete for ${jobId}:`, JSON.stringify(result));

      const videoUrl =
        result?.public_url ||
        result?.rendered_video_url ||
        result?.video_url ||
        publicUrl ||
        null;

      if (result?.error) {
        console.error(`[dispatch] Pipeline error for ${jobId}: ${result.error}`);
        await supabaseAdmin
          .from('video_jobs')
          .update({
            status: 'failed',
            error_message: result.error,
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId);
        return { jobId, publicUrl };
      }

      // Write completion to DB
      const completionUpdate = {
        status: 'completed',
        progress: 100,
        current_step: 'complete',
        step_message: 'Your video is ready!',
        rendered_video_url: videoUrl,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (thumbnailPublicUrl) {
        completionUpdate.thumbnail_url = thumbnailPublicUrl;
      }
      if (result?.edit_recipe) {
        completionUpdate.edit_recipe = result.edit_recipe;
      }
      await supabaseAdmin
        .from('video_jobs')
        .update(completionUpdate)
        .eq('id', jobId);

      // Push to SSE so browser receives video URL immediately
      if (typeof pushProgressToSSE === 'function') {
        pushProgressToSSE(jobId, {
          status: 'completed',
          progress: 100,
          step: 'complete',
          message: 'Your video is ready!',
          videoUrl,
          thumbnailUrl: thumbnailPublicUrl || null,
          error: null,
        });
      }

      console.log(`[dispatch] Job ${jobId} completed with videoUrl: ${videoUrl}`);
    } catch (err) {
      console.error(`[dispatch] Modal fetch error for ${jobId}: ${err.message}`);
      await supabaseAdmin
        .from('video_jobs')
        .update({
          status: 'failed',
          error_message: err.message,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);
    }
  })();

  return { jobId, publicUrl };
}

module.exports = { dispatchJobToModal };

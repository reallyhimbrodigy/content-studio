const { supabaseAdmin } = require('../../services/supabase-admin');

function normalizeSignedUploadUrl(signedUrl) {
  if (!signedUrl) return signedUrl;
  if (signedUrl.startsWith('http://') || signedUrl.startsWith('https://')) return signedUrl;
  const base = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error('Missing SUPABASE_URL for signed upload URL normalization');
  return `${base}${signedUrl}`;
}

async function dispatchJobToModal({ jobId, videoUrl, vibe, userId }) {
  if (!supabaseAdmin) throw new Error('supabase_not_configured');

  const modalEndpointUrl = process.env.MODAL_ENDPOINT_URL;
  if (!modalEndpointUrl) throw new Error('MODAL_ENDPOINT_URL is required');

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
    } else {
      console.log(`[dispatch] Gemini cache MISS for job ${jobId}`);
    }
  } catch (e) {
    console.log(`[dispatch] Cache lookup failed: ${e.message}`);
  }

  // 2. Create signed upload URL
  const timestamp = Date.now();
  const outputPath = `${jobId}/${timestamp}-edited.mp4`;
  const { data: signedData, error: signedError } = await supabaseAdmin
    .storage
    .from('videos')
    .createSignedUploadUrl(outputPath, { upsert: true });

  if (signedError || !signedData?.signedUrl) {
    throw new Error(`Failed to create signed upload URL: ${signedError?.message || 'missing signed URL'}`);
  }

  const uploadUrl = normalizeSignedUploadUrl(signedData.signedUrl);
  const { data: publicData } = supabaseAdmin.storage.from('videos').getPublicUrl(outputPath);
  const publicUrl = publicData?.publicUrl;

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

  // 5. Fire Modal request — does not wait for completion
  // Modal calls /api/runpod-progress for each step and /api/runpod-webhook on completion
  console.log(`[dispatch] Firing Modal job for ${jobId}`);
  fetch(modalEndpointUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[dispatch] Modal returned ${res.status}: ${text}`);
        await supabaseAdmin
          .from('video_jobs')
          .update({
            status: 'failed',
            error_message: `Modal dispatch failed: ${res.status}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId);
      }
    })
    .catch(async (err) => {
      console.error(`[dispatch] Modal fetch error: ${err.message}`);
      await supabaseAdmin
        .from('video_jobs')
        .update({
          status: 'failed',
          error_message: err.message,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);
    });

  return { jobId, publicUrl };
}

module.exports = { dispatchJobToModal };

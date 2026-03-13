const { supabaseAdmin } = require('../../services/supabase-admin');
const { getPendingRunpodJobs } = require('./runpod-webhook');
const RUNPOD_BASE_URL = 'https://api.runpod.ai/v2';

async function checkRunPodHealth(endpointId, apiKey) {
  try {
    const res = await fetch(`${RUNPOD_BASE_URL}/${endpointId}/health`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return { available: 0, throttled: 0, healthy: false };
    const data = await res.json();
    const workers = data?.workers || {};
    const idle = workers.idle || 0;
    const running = workers.running || 0;
    const throttled = workers.throttled || 0;
    const available = idle + running;
    console.log(`[runpod-health] idle=${idle} running=${running} throttled=${throttled}`);
    return { available, throttled, healthy: available > 0 };
  } catch (e) {
    console.warn(`[runpod-health] check failed: ${e.message}`);
    return { available: 0, throttled: 0, healthy: false };
  }
}

function normalizeSignedUploadUrl(signedUrl) {
  if (!signedUrl) return signedUrl;
  if (signedUrl.startsWith('http://') || signedUrl.startsWith('https://')) return signedUrl;
  const base = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error('Missing SUPABASE_URL for signed upload URL normalization');
  return `${base}${signedUrl}`;
}

async function dispatchJobToRunPod({ jobId, videoUrl, vibe, userId }) {
  if (!supabaseAdmin) throw new Error('supabase_not_configured');

  // 1. Check Gemini analysis cache.
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

  // 2. Create signed upload URL for final output.
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

  // 2.5 — Check worker health and update job status for frontend
  const endpointId = process.env.RUNPOD_ENDPOINT_ID || '';
  const runpodApiKey = process.env.RUNPOD_API_KEY || '';
  if (endpointId && runpodApiKey) {
    const health = await checkRunPodHealth(endpointId, runpodApiKey);
    if (!health.healthy && health.throttled > 0) {
      console.log('[runpod-health] all workers throttled — updating job status');
      await supabaseAdmin
        .from('video_jobs')
        .update({
          step_message: 'Our servers are busy — you\'re next in line...',
          current_step: 'queued',
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);
    }
  }

  // 3. Build RunPod payload.
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  if (!appUrl) {
    throw new Error('APP_URL is required for RunPod webhook dispatch');
  }
  const webhookUrl = appUrl.startsWith('http')
    ? `${appUrl}/api/runpod-webhook`
    : `https://${appUrl}/api/runpod-webhook`;
  const payload = {
    webhook: webhookUrl,
    input: {
      job_id: jobId,
      video_url: videoUrl,
      vibe,
      user_id: userId,
      upload_url: uploadUrl,
      cached_analysis: cachedAnalysis,
    },
  };
  console.log('[dispatch] RunPod full-pipeline payload:', JSON.stringify(payload, null, 2));

  // 4. Submit to RunPod.
  const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;
  const response = await fetch(
    `${RUNPOD_BASE_URL}/${RUNPOD_ENDPOINT_ID}/run`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`,
      },
      body: JSON.stringify(payload),
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`RunPod submission failed: ${response.status} ${text}`);
  }
  const data = await response.json();
  const runpodJobId = data.id;
  if (!runpodJobId) {
    throw new Error(`RunPod submission missing job id: ${JSON.stringify(data)}`);
  }
  console.log(`[dispatch] RunPod job submitted: ${runpodJobId}`);

  // 5. Wait for webhook completion.
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      getPendingRunpodJobs().delete(runpodJobId);
      reject(new Error('RunPod job timed out after 300s'));
    }, 300000);

    getPendingRunpodJobs().set(runpodJobId, { resolve, reject, timeout });
    console.log(`[dispatch] Webhook registered for ${runpodJobId}`);
  });

  return { result, publicUrl, runpodJobId };
}

module.exports = { dispatchJobToRunPod };

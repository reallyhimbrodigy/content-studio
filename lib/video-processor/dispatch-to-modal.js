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

  // 2. Create signed upload URL for the rendered MP4
  const timestamp = Date.now();
  const outputPath = `${jobId}/${timestamp}-edited.mp4`;
  const thumbPath = `thumbnails/${jobId}.jpg`;

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
  // Note: thumbnail is uploaded by Node from cover_frame_b64 in the Modal response,
  // not by the worker. No upload_url_thumb is sent.
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

      // Upload the cover frame from base64 — this is the authoritative source.
      // We do this from Node (not the worker) so we know for certain whether
      // the upload succeeded before writing thumbnail_url to the DB.
      let thumbnailUrl = null;
      const coverB64 = result?.cover_frame_b64;
      const coverMime = result?.cover_frame_mime || 'image/jpeg';
      if (coverB64 && typeof coverB64 === 'string') {
        try {
          const buffer = Buffer.from(coverB64, 'base64');
          const { error: uploadErr } = await supabaseAdmin
            .storage
            .from('videos')
            .upload(thumbPath, buffer, { upsert: true, contentType: coverMime });
          if (uploadErr) {
            console.warn(`[dispatch] Thumbnail upload failed for ${jobId}: ${uploadErr.message}`);
          } else {
            const { data: signedThumb, error: signedThumbErr } = await supabaseAdmin
              .storage
              .from('videos')
              .createSignedUrl(thumbPath, 60 * 60 * 24 * 365);
            if (signedThumbErr || !signedThumb?.signedUrl) {
              console.warn(`[dispatch] Thumbnail signed URL failed for ${jobId}: ${signedThumbErr?.message || 'missing'}`);
            } else {
              const base = normalizeSignedUploadUrl(signedThumb.signedUrl);
              const sep = base.includes('?') ? '&' : '?';
              thumbnailUrl = `${base}${sep}v=${Date.now()}`;
              console.log(`[dispatch] Thumbnail uploaded and signed for ${jobId}`);
            }
          }
        } catch (e) {
          console.warn(`[dispatch] Thumbnail handling error for ${jobId}: ${e.message}`);
        }
      } else {
        console.warn(`[dispatch] No cover_frame_b64 in Modal response for ${jobId}`);
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
      if (thumbnailUrl) {
        completionUpdate.thumbnail_url = thumbnailUrl;
      }
      if (result?.edit_recipe) {
        completionUpdate.edit_recipe = result.edit_recipe;
      }
      await supabaseAdmin
        .from('video_jobs')
        .update(completionUpdate)
        .eq('id', jobId);

      // Push final SSE event — this is the one that carries the authoritative
      // thumbnailUrl. The frontend treats final:true as the signal to close
      // the SSE connection.
      if (typeof pushProgressToSSE === 'function') {
        pushProgressToSSE(jobId, {
          status: 'completed',
          progress: 100,
          step: 'complete',
          message: 'Your video is ready!',
          videoUrl,
          thumbnailUrl: thumbnailUrl || null,
          final: true,
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
      if (typeof pushProgressToSSE === 'function') {
        pushProgressToSSE(jobId, {
          status: 'failed',
          progress: 0,
          step: 'error',
          message: '',
          videoUrl: null,
          thumbnailUrl: null,
          final: true,
          error: err.message,
        });
      }
    }
  })();

  return { jobId, publicUrl };
}

module.exports = { dispatchJobToModal };

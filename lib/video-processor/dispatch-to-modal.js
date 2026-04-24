const { supabaseAdmin } = require('../../services/supabase-admin');
const s3 = require('../../services/s3');

function normalizeSignedUploadUrl(signedUrl) {
  if (!signedUrl) return signedUrl;
  if (signedUrl.startsWith('http://') || signedUrl.startsWith('https://')) return signedUrl;
  const base = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error('Missing SUPABASE_URL for signed upload URL normalization');
  return `${base}${signedUrl}`;
}

// ── Prewarm registry ─────────────────────────────────────────────────────
// Tracks in-flight /api/prewarm fire-and-forget calls so that when the real
// /api/video-jobs dispatch arrives for the same video URL, we can await the
// prewarm result briefly and include it as a hint in the Modal payload. The
// Modal handler uses the hint to detect the Volume eventual-consistency
// race (commit landed on container A but not yet visible to container B).
//
// Map shape: videoUrl → Promise<{cached: bool, source_cached: bool,
// transcript_cached: bool, cache_key: string, error?: string}>
// Entries auto-expire after 5 min to prevent unbounded growth.
const prewarmRegistry = new Map();

function registerPrewarm(videoUrl, promise) {
  prewarmRegistry.set(videoUrl, promise);
  setTimeout(() => {
    if (prewarmRegistry.get(videoUrl) === promise) {
      prewarmRegistry.delete(videoUrl);
    }
  }, 5 * 60 * 1000);
}

async function awaitPrewarmHint(videoUrl, timeoutMs = 1000) {
  const promise = prewarmRegistry.get(videoUrl);
  if (!promise) return null;
  try {
    const result = await Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return result;
  } catch {
    return null;
  }
}

/**
 * Dispatch a render job to the Modal GPU worker.
 *
 * Standard parameters (original edit): jobId, videoUrl, vibe, userId, pushProgressToSSE.
 *
 * Re-edit parameters (optional — all null on a fresh edit):
 *   mode          "full" (default) | "render_only" | "tweak" | "reinterpret"
 *   editPlan      the sanitized edit_recipe from the parent job
 *   transcript    the Deepgram transcript from the parent job (cached so we don't
 *                  re-run ASR)
 *   analysisData  the cached Gemini visual analysis
 *   resolvedBroll array of { pexels_video_id, pexels_file_url, ... } — B-roll we
 *                  must use verbatim (zero re-search, zero Gemini re-pick)
 *   trendSnapshot the trend_profiles row the parent render used — tweak mode
 *                  replays with this snapshot for byte-level fidelity
 *   changeRequest natural-language description of what the user wants changed
 *   oldVibe       the parent's vibe_input — Gemini uses it to ground plan-diff
 *   parentJobId   the parent video_jobs row — persisted on the new row for
 *                  lineage tracking
 *
 * Once the worker responds, any re-edit persistence fields it returns
 * (transcript, analysis_data, resolved_broll, trend_snapshot, render_version,
 * change_summary) are written to the new video_jobs row so THIS render can
 * itself be re-edited later.
 */
async function dispatchJobToModal({
  jobId,
  videoUrl,
  vibe,
  userId,
  pushProgressToSSE,
  // Re-edit extensions
  mode,
  editPlan,
  transcript: priorTranscript,
  analysisData,
  resolvedBroll,
  trendSnapshot,
  changeRequest,
  oldVibe,
  parentJobId,
}) {
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

  // Prefer the re-edit analysis data over the generic cache — the parent job's
  // analysis was captured at render time and is the one we want replayed.
  if (!cachedAnalysis && analysisData && typeof analysisData === 'object') {
    cachedAnalysis = analysisData;
    console.log(`[dispatch] Using parent-job analysis_data (re-edit path)`);
  }

  // 2. Create presigned upload URLs for the rendered MP4
  const timestamp = Date.now();
  const useS3 = s3.isConfigured();

  let uploadUrl = null;
  let publicUrl = null;
  let s3OutputKey = null;
  let s3ThumbKey = null;

  if (useS3) {
    s3OutputKey = `renders/${jobId}/${timestamp}-edited.mp4`;
    s3ThumbKey = `thumbnails/${jobId}.jpg`;
    uploadUrl = await s3.createPresignedPutUrl(s3OutputKey, 3600);
    publicUrl = s3.getPublicUrl(s3OutputKey);
    console.log(`[dispatch] S3 presigned PUT URL created for ${jobId}`);
  } else {
    // Fallback to Supabase Storage
    const outputPath = `${jobId}/${timestamp}-edited.mp4`;
    const { data: signedData, error: signedError } = await supabaseAdmin
      .storage
      .from('videos')
      .createSignedUploadUrl(outputPath, { upsert: true });

    if (signedError || !signedData?.signedUrl) {
      throw new Error(`Failed to create signed upload URL: ${signedError?.message || 'missing signed URL'}`);
    }

    uploadUrl = normalizeSignedUploadUrl(signedData.signedUrl);
    const { data: publicData } = supabaseAdmin.storage.from('videos').getPublicUrl(outputPath);
    publicUrl = publicData?.publicUrl;
  }

  // 3. Build payload
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  if (!appUrl) throw new Error('APP_URL is required');

  const resolvedMode = typeof mode === 'string' && mode ? mode : 'full';

  // Await the in-flight prewarm (if any) up to 1s so we can pass a
  // confirmation hint to the worker. On race-loss the worker logs a
  // cache_race_lost metric — with the hint, races become observable.
  // For re-edits we skip this (worker has cached transcripts anyway).
  let prewarmHint = null;
  if (resolvedMode === 'full') {
    const hintResult = await awaitPrewarmHint(videoUrl, 1000);
    if (hintResult && !hintResult.error) {
      prewarmHint = {
        cache_key: hintResult.cache_key || null,
        source_cached: Boolean(hintResult.cached || hintResult.status === 'success' || hintResult.status === 'cached'),
        transcript_cached: Boolean(hintResult.transcript_cached),
      };
      console.log(`[dispatch] prewarm hint for ${jobId}: ${JSON.stringify(prewarmHint)}`);
    } else if (hintResult === null) {
      console.log(`[dispatch] prewarm timeout/not-fired for ${jobId} — worker falls back to volume check`);
    }
  }

  const payload = {
    job_id: jobId,
    video_url: videoUrl,
    vibe,
    user_id: userId,
    upload_url: uploadUrl,
    public_url: publicUrl,
    app_url: appUrl,
    ...(useS3 ? { s3_bucket: s3.S3_BUCKET, s3_key: s3OutputKey, s3_region: s3.AWS_REGION } : {}),
    ...(cachedAnalysis ? { cached_analysis: cachedAnalysis } : {}),
    ...(prewarmHint ? { prewarm_status: prewarmHint } : {}),
    // Re-edit fields — worker ignores them in "full" mode
    ...(resolvedMode !== 'full' ? { mode: resolvedMode } : {}),
    ...(editPlan && typeof editPlan === 'object' ? { edit_plan: editPlan } : {}),
    ...(priorTranscript && typeof priorTranscript === 'object' ? { transcript: priorTranscript } : {}),
    ...(analysisData && typeof analysisData === 'object' ? { analysis_data: analysisData } : {}),
    ...(Array.isArray(resolvedBroll) && resolvedBroll.length ? { resolved_broll: resolvedBroll } : {}),
    ...(trendSnapshot && typeof trendSnapshot === 'object' ? { trend_snapshot: trendSnapshot } : {}),
    ...(changeRequest ? { change_request: changeRequest } : {}),
    ...(oldVibe ? { old_vibe: oldVibe } : {}),
  };

  // 4. Update job to processing immediately so SSE fires.
  // For re-edits we also record the lineage up front so the row is queryable mid-render.
  const initialUpdate = {
    status: 'processing',
    current_step: 'queued',
    step_message: 'Getting started...',
    updated_at: new Date().toISOString(),
  };
  if (parentJobId) initialUpdate.parent_job_id = parentJobId;
  if (resolvedMode !== 'full') initialUpdate.reedit_mode = resolvedMode;
  if (changeRequest) initialUpdate.change_request = changeRequest;

  await supabaseAdmin
    .from('video_jobs')
    .update(initialUpdate)
    .eq('id', jobId);

  // 5. Fire Modal request in background — Modal is synchronous so we await the response
  // Progress updates arrive via /api/modal-progress during execution
  // The final video URL comes back in the Modal HTTP response body
  console.log(`[dispatch] Firing Modal job for ${jobId} mode=${resolvedMode} (storage: ${useS3 ? 'S3' : 'Supabase'})`);

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
        const errMessage = `Modal error: ${res.status}`;
        await supabaseAdmin
          .from('video_jobs')
          .update({
            status: 'failed',
            error_message: errMessage,
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
            error: errMessage,
          });
        }
        return { jobId, publicUrl };
      }

      // Modal returns the pipeline result — extract video URL
      const result = await res.json().catch(() => ({}));
      console.log(`[dispatch] Modal job complete for ${jobId}:`, JSON.stringify(result).slice(0, 500));

      // Re-edit needs_clarification path — no video was rendered. Surface the question
      // to the user via SSE, mark the job "failed" with a soft reason, and stop.
      if (result?.status === 'needs_clarification') {
        const question = result?.clarification_question || 'Can you describe the change in more detail?';
        await supabaseAdmin
          .from('video_jobs')
          .update({
            status: 'failed',
            error_message: `needs_clarification: ${question}`,
            change_summary: question,
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId);
        if (typeof pushProgressToSSE === 'function') {
          pushProgressToSSE(jobId, {
            status: 'needs_clarification',
            progress: 0,
            step: 'needs_clarification',
            message: question,
            videoUrl: null,
            thumbnailUrl: null,
            final: true,
            error: null,
          });
        }
        return { jobId, publicUrl };
      }

      let videoUrl =
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
        if (typeof pushProgressToSSE === 'function') {
          pushProgressToSSE(jobId, {
            status: 'failed',
            progress: 0,
            step: 'error',
            message: '',
            videoUrl: null,
            thumbnailUrl: null,
            final: true,
            error: String(result.error),
          });
        }
        return { jobId, publicUrl };
      }

      // If S3 is configured and the worker uploaded to the presigned URL,
      // generate a long-lived GET URL for the rendered video
      if (useS3 && s3OutputKey) {
        try {
          const signedGetUrl = await s3.createPresignedGetUrl(s3OutputKey, 60 * 60 * 24 * 30);
          videoUrl = `${signedGetUrl}${signedGetUrl.includes('?') ? '&' : '?'}v=${Date.now()}`;
          console.log(`[dispatch] S3 signed GET URL created for rendered video ${jobId}`);
        } catch (e) {
          console.warn(`[dispatch] Failed to create S3 GET URL for video: ${e.message}, using public URL`);
        }
      }

      // Upload the cover frame from base64 — this is the authoritative source.
      let thumbnailUrl = null;
      const coverB64 = result?.cover_frame_b64;
      const coverMime = result?.cover_frame_mime || 'image/jpeg';
      if (coverB64 && typeof coverB64 === 'string') {
        const buffer = Buffer.from(coverB64, 'base64');
        if (useS3 && s3ThumbKey) {
          try {
            await s3.upload(s3ThumbKey, buffer, coverMime);
            const signedThumbUrl = await s3.createPresignedGetUrl(s3ThumbKey, 60 * 60 * 24 * 365);
            thumbnailUrl = `${signedThumbUrl}${signedThumbUrl.includes('?') ? '&' : '?'}v=${Date.now()}`;
            console.log(`[dispatch] Thumbnail uploaded to S3 for ${jobId}`);
          } catch (e) {
            console.warn(`[dispatch] S3 thumbnail upload failed for ${jobId}: ${e.message}`);
          }
        }
        if (!thumbnailUrl) {
          try {
            const thumbPath = `thumbnails/${jobId}.jpg`;
            const { error: uploadErr } = await supabaseAdmin
              .storage
              .from('videos')
              .upload(thumbPath, buffer, { upsert: true, contentType: coverMime });
            if (uploadErr) {
              console.warn(`[dispatch] Supabase thumbnail upload failed for ${jobId}: ${uploadErr.message}`);
            } else {
              const { data: signedThumb, error: signedThumbErr } = await supabaseAdmin
                .storage
                .from('videos')
                .createSignedUrl(thumbPath, 60 * 60 * 24 * 365);
              if (signedThumbErr || !signedThumb?.signedUrl) {
                console.warn(`[dispatch] Supabase thumbnail signed URL failed for ${jobId}: ${signedThumbErr?.message || 'missing'}`);
              } else {
                const base = normalizeSignedUploadUrl(signedThumb.signedUrl);
                thumbnailUrl = `${base}${base.includes('?') ? '&' : '?'}v=${Date.now()}`;
                console.log(`[dispatch] Thumbnail uploaded to Supabase for ${jobId}`);
              }
            }
          } catch (e) {
            console.warn(`[dispatch] Supabase thumbnail handling error for ${jobId}: ${e.message}`);
          }
        }
      } else {
        console.warn(`[dispatch] No cover_frame_b64 in Modal response for ${jobId}`);
      }

      // Write completion to DB with all re-edit persistence fields
      const completionUpdate = {
        status: 'completed',
        progress: 100,
        current_step: 'complete',
        step_message: 'Your video is ready!',
        rendered_video_url: videoUrl,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (thumbnailUrl) completionUpdate.thumbnail_url = thumbnailUrl;
      if (result?.edit_recipe) completionUpdate.edit_recipe = result.edit_recipe;
      if (result?.transcript) completionUpdate.transcript = result.transcript;
      if (result?.analysis_data) completionUpdate.analysis_data = result.analysis_data;
      if (Array.isArray(result?.resolved_broll) && result.resolved_broll.length) {
        completionUpdate.resolved_broll = result.resolved_broll;
      }
      if (result?.trend_snapshot) completionUpdate.trend_snapshot = result.trend_snapshot;
      if (typeof result?.render_version === 'number') completionUpdate.render_version = result.render_version;
      if (result?.change_summary) completionUpdate.change_summary = result.change_summary;

      await supabaseAdmin
        .from('video_jobs')
        .update(completionUpdate)
        .eq('id', jobId);

      if (typeof pushProgressToSSE === 'function') {
        pushProgressToSSE(jobId, {
          status: 'completed',
          progress: 100,
          step: 'complete',
          message: 'Your video is ready!',
          videoUrl,
          thumbnailUrl: thumbnailUrl || null,
          changeSummary: result?.change_summary || null,
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

module.exports = { dispatchJobToModal, registerPrewarm };

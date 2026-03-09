const { analyzeVideo } = require('./analyze-video');
const { supabaseAdmin } = require('../../services/supabase-admin');
const inFlightAnalysis = new Map(); // videoUrl -> Promise<analysis>

async function triggerPreAnalysis(videoUrl) {
  if (!videoUrl || !supabaseAdmin) return;

  try {
    const { data, error: readError } = await supabaseAdmin
      .from('video_analysis_cache')
      .select('analysis')
      .eq('video_url', videoUrl)
      .maybeSingle();

    if (readError) {
      console.warn('[pre-analyze] Cache check failed:', readError.message);
    }

    if (data?.analysis) {
      console.log('[pre-analyze] Cache already exists, skipping:', videoUrl);
      return;
    }
  } catch (err) {
    console.warn('[pre-analyze] Cache check failed:', err.message);
  }

  // Already in flight — skip duplicate work
  if (inFlightAnalysis.has(videoUrl)) return;

  // Start analysis and register promise
  const promise = analyzeVideo(videoUrl)
    .then(async (analysis) => {
      const { error: upsertError } = await supabaseAdmin
        .from('video_analysis_cache')
        .upsert({ video_url: videoUrl, analysis }, { onConflict: 'video_url' });
      if (upsertError) {
        console.error('[pre-analyze] Cache upsert failed:', upsertError.message);
      } else {
        console.log('[pre-analyze] Analysis cached for:', videoUrl);
      }
      return analysis;
    })
    .catch((err) => {
      console.error('[pre-analyze] Analysis failed:', err.message);
      return null;
    })
    .finally(() => {
      inFlightAnalysis.delete(videoUrl);
    });

  inFlightAnalysis.set(videoUrl, promise);
}

module.exports = { triggerPreAnalysis, inFlightAnalysis };

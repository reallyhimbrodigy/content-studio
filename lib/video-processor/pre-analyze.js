const { analyzeVideo } = require('./analyze-video');
const { supabaseAdmin } = require('../../services/supabase-admin');
console.log('[pre-analyze] Module loaded successfully');
const inFlightAnalysis = new Map(); // videoUrl -> Promise<analysis>

async function triggerPreAnalysis(videoUrl) {
  console.log('[pre-analyze] triggerPreAnalysis called for:', videoUrl);
  if (!videoUrl) {
    console.warn('[pre-analyze] Missing videoUrl, skipping');
    return;
  }
  if (!supabaseAdmin) {
    console.warn('[pre-analyze] Missing supabaseAdmin, skipping');
    return;
  }

  // Check if already in flight
  if (inFlightAnalysis.has(videoUrl)) {
    console.log('[pre-analyze] Already in flight, skipping');
    return;
  }

  // Check DB cache
  try {
    console.log('[pre-analyze] Checking DB cache...');
    const { data, error: readError } = await supabaseAdmin
      .from('video_analysis_cache')
      .select('analysis')
      .eq('video_url', videoUrl)
      .maybeSingle();

    if (readError) {
      console.warn('[pre-analyze] Cache check failed:', readError.message);
    }

    if (data?.analysis) {
      console.log('[pre-analyze] Already cached in DB, skipping');
      return;
    }
    console.log('[pre-analyze] Cache miss — starting analysis');
  } catch (err) {
    console.warn('[pre-analyze] Cache check failed:', err.message);
  }

  // Start analysis and register promise
  const promise = analyzeVideo(videoUrl)
    .then(async (analysis) => {
      console.log('[pre-analyze] Analysis complete, writing to cache...');
      const { error: upsertError } = await supabaseAdmin
        .from('video_analysis_cache')
        .upsert({ video_url: videoUrl, analysis }, { onConflict: 'video_url' });
      if (upsertError) {
        console.error('[pre-analyze] Analysis or cache write failed:', upsertError.message);
      } else {
        console.log('[pre-analyze] Cache written successfully');
      }
      return analysis;
    })
    .catch((err) => {
      console.error('[pre-analyze] Analysis or cache write failed:', err.message);
      return null;
    })
    .finally(() => {
      inFlightAnalysis.delete(videoUrl);
      console.log('[pre-analyze] Removed from in-flight map');
    });

  inFlightAnalysis.set(videoUrl, promise);
  console.log('[pre-analyze] Analysis started, registered in-flight');
}

module.exports = { triggerPreAnalysis, inFlightAnalysis };

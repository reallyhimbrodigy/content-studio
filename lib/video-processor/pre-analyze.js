const { analyzeVideo } = require('./analyze-video');
const { supabaseAdmin } = require('../../services/supabase-admin');
console.log('[pre-analyze] Module loaded successfully');
const inFlightAnalysis = new Map(); // videoUrl -> Promise<analysis>

// Classify a Gemini failure so the pre-analyze catch can LEDGER (surface loud),
// not swallow. Crucial subtlety proven empirically: an INVALID/rotated key
// returns HTTP 400 with reason API_KEY_INVALID — NOT 401 — so a naive
// status===401 check misses the exact key-rotation incident we care about.
// Auth/config → CRITICAL (every pre-analysis is failing, page it); quota → HIGH;
// everything else → transient WARN.
function classifyGeminiFailure(err) {
  const status = err?.response?.status;
  const bodyStr = (() => { try { return JSON.stringify(err?.response?.data || ''); } catch { return ''; } })();
  const keyInvalid = status === 401 || status === 403
    || (status === 400 && /API_KEY_INVALID|INVALID_ARGUMENT/i.test(bodyStr));
  const quota = status === 429 || /RESOURCE_EXHAUSTED|\bquota\b/i.test(bodyStr);
  if (keyInvalid) return { status: status ?? null, cls: 'AUTH/CONFIG', sev: 'CRITICAL', keyInvalid: true };
  if (quota) return { status: status ?? null, cls: 'QUOTA', sev: 'HIGH', keyInvalid: false };
  return { status: status ?? null, cls: 'TRANSIENT', sev: 'WARN', keyInvalid: false };
}

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
      // LEDGER, don't swallow — vacuous-read class at the API boundary. A silent
      // fallback to empty/default analysis is invisible downstream; a key
      // rotation or quota trip must surface LOUD, not degrade quietly. Classify
      // (see classifyGeminiFailure) so an auth/config failure is unmissable — it
      // means EVERY pre-analysis is failing, not just this one — and state the
      // consequence explicitly.
      const { status, cls, sev, keyInvalid } = classifyGeminiFailure(err);
      console.error(
        `[pre-analyze][LEDGER][${sev}] class=${cls} status=${status ?? 'n/a'} `
        + `video_url=${videoUrl} — Gemini pre-analysis FAILED; this video falls back to `
        + `DEFAULT/EMPTY analysis (no cache row written). err=${err?.message}`
      );
      if (keyInvalid) {
        console.error(
          `[pre-analyze][LEDGER][CRITICAL] GEMINI_API_KEY appears INVALID (status=${status ?? 'n/a'}) — `
          + `ALL pre-analysis is silently degrading to empty analysis. Rotate/verify the key NOW.`
        );
      }
      return null;
    })
    .finally(() => {
      inFlightAnalysis.delete(videoUrl);
      console.log('[pre-analyze] Removed from in-flight map');
    });

  inFlightAnalysis.set(videoUrl, promise);
  console.log('[pre-analyze] Analysis started, registered in-flight');
}

module.exports = { triggerPreAnalysis, inFlightAnalysis, classifyGeminiFailure };

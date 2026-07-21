const { supabaseAdmin } = require('../../services/supabase-admin');
const s3 = require('../../services/s3');
const push = require('../../services/push');
const { dispatchErrorMessage, clarificationMessage, renderTooShortMessage } = require('../failure-copy');
const { registerPendingModalJob } = require('./modal-webhook');
const { sendOwnerAlert } = require('../../services/pushNotifier');

// Founder user id — target for the double-loss operator alert (2a). Same const
// the reaper uses; env-overridable.
const OWNER_USER_ID = process.env.OWNER_USER_ID || 'ec702499-ca10-49e6-8850-df8f99840904';

// Render-lifecycle push events (1.2.0 rider): mirror every user push into both
// analytics sinks so delivery is measurable (paired with PostHog's lifecycle
// autocapture on the open). Fire-and-forget — never touches the send path.
function logPushEvent(userId, type, jobId, r) {
  try {
    const props = { type, job_id: jobId, sent: (r && r.sent) || 0, skipped: (r && r.skipped) || null };
    supabaseAdmin.from('analytics_events').insert({
      event: 'push_sent', anon_user_id: userId, user_id: userId,
      platform: 'server', app_version: 'dispatch', props,
    }).then(({ error }) => { if (error) console.warn('[push] event mirror failed:', error.message); });
    require('../posthog-sink').phCapture(userId, 'push_sent', props);
  } catch (e) { console.warn('[push] logPushEvent failed:', e && e.message); }
}
const {
  detectBurnedText, mergeBandsIntoAnalysis, hasCurrentDetection,
} = require('./burned-text-detector');

// W3 burned-text detection enrich (fail-open). Runs the deterministic detector
// on the (proxy) source and merges NUMERIC caption bands + a REAL
// has_burned_captions measurement into the analysis that ships to the worker's
// belt via cached_analysis. Idempotent by detector version (a re-edit parent that
// already carries bands rides free). Bounded by a hard timeout; ANY failure
// returns the original analysis unchanged so a detector hiccup never blocks or
// breaks a render. Also upserts the enriched blob back to the analysis cache —
// deterministic output makes that safe and simultaneously un-stales the cache.
const DETECTION_TIMEOUT_MS = 15000;
// detectUrl = what we sample (the low-res proxy when present); cacheKeyUrl = the
// SOURCE video_url that the cache LOOKUP uses (video_analysis_cache is keyed by
// source), so the enriched blob is written to the same key it will later be read
// from. Passing the proxy as the cache key would split the cache into a
// never-read row.
// A REAL pre-analysis (Gemini), not a detection-only shell. Detection ENRICHES a
// real analysis; it must never mint a standalone blob, because such a blob is
// truthy + carries the current detector stamp and would be indistinguishable from
// a full analysis to every consumer — it would (a) make pre-analyze skip the real
// Gemini pass forever (one-shot per URL), (b) ship a transcript/shots-less analysis
// to the worker, and (c) never self-repair (hasCurrentDetection blocks it). So on a
// cache MISS we bail and let the worker run its own analysis; detection reaches the
// cache via pre-analysis (which enriches a real Gemini base).
function isRealAnalysis(a) {
  return !!a && typeof a === 'object'
    && (Array.isArray(a.shots) || typeof a.duration === 'number' || !!a.speech
        || typeof a?.frame_layout?.subject_position === 'string');
}
async function enrichAnalysisWithDetection(analysis, detectUrl, cacheKeyUrl, jobId) {
  try {
    if (!detectUrl) return analysis;
    if (!isRealAnalysis(analysis)) return analysis; // cache miss → never poison the source-keyed row
    if (hasCurrentDetection(analysis)) return analysis; // already measured this version
    const r = await Promise.race([
      detectBurnedText(detectUrl, { source: 'proxy', duration: Number(analysis.duration) || undefined }),
      new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), DETECTION_TIMEOUT_MS)),
    ]);
    if (!r || r.__timeout || !r.detection) {
      if (r && r.__timeout) console.warn(`[dispatch] burned-text detection timed out for ${jobId} — shipping analysis unchanged`);
      return analysis; // fail-open
    }
    const merged = mergeBandsIntoAnalysis(analysis, r.detection, r.meta);
    console.log(`[dispatch] burned-text: job=${jobId} has_burned_captions=${r.detection.has_burned_captions} bands=${r.detection.text_bands.length} coverage=${r.detection.caption_zone_coverage}`);
    // Persist the enriched (real) analysis OFF the critical path — the render must
    // never block on this cache write. Fire-and-forget; failures are logged only.
    if (cacheKeyUrl) {
      supabaseAdmin.from('video_analysis_cache')
        .upsert({ video_url: cacheKeyUrl, analysis: merged }, { onConflict: 'video_url' })
        .then(
          ({ error } = {}) => { if (error) console.warn(`[dispatch] analysis-cache upsert (detection) DB error for ${jobId}: ${error.message}`); },
          (e) => console.warn(`[dispatch] analysis-cache upsert (detection) failed for ${jobId}: ${e.message}`),
        );
    }
    return merged;
  } catch (e) {
    console.error(`[dispatch] burned-text enrich failed (fail-open) job=${jobId}: ${e.message}`);
    return analysis;
  }
}

// W3 / Item 3 — warm video_analysis_cache at RENDER COMPLETION. This is the one
// point where BOTH the source (fully uploaded — the render finished) AND a real
// Gemini analysis (the worker's result.analysis_data) are guaranteed present, so
// it needs no redundant Gemini call. The direct-to-S3 upload flow has no reliable
// pre-dispatch "source uploaded" server signal (uploads bypass the dead /api/upload
// hook, and /api/prewarm fires before the source lands — the 84-day cache-staleness
// root cause), so completion is the reliable server-only place to repopulate the
// cache. Enriches the worker's analysis with detection bands and upserts under the
// SOURCE key, so a later re-edit of this source reads a real cached analysis WITH
// bands instead of falling to empty/echo. Fully fire-and-forget — never blocks or
// affects the render completion; all errors swallowed to a warn.
async function warmAnalysisCacheWithDetection(sourceUrl, workerAnalysis, jobId) {
  try {
    if (!sourceUrl || !isRealAnalysis(workerAnalysis)) return;
    let merged = workerAnalysis;
    if (!hasCurrentDetection(workerAnalysis)) {
      const r = await detectBurnedText(sourceUrl, { source: 'source', duration: Number(workerAnalysis.duration) || undefined });
      if (r && r.detection) {
        merged = mergeBandsIntoAnalysis(workerAnalysis, r.detection, r.meta);
        console.log(`[dispatch] cache-warm job=${jobId} has_burned_captions=${r.detection.has_burned_captions} bands=${r.detection.text_bands.length}`);
      }
    }
    const { error } = await supabaseAdmin
      .from('video_analysis_cache')
      .upsert({ video_url: sourceUrl, analysis: merged }, { onConflict: 'video_url' });
    if (error) console.warn(`[dispatch] cache-warm upsert DB error job=${jobId}: ${error.message}`);
    else console.log(`[dispatch] cache-warm: video_analysis_cache row written for job=${jobId}`);
  } catch (e) {
    console.warn(`[dispatch] cache-warm failed (non-fatal) job=${jobId}: ${e.message}`);
  }
}

// FIRST-TERMINAL-WINS. Once video_jobs.status is one of these, the job is
// finished and NEITHER side overwrites it — the app must never respell/clobber a
// terminal status the worker set (that silently drops its write-once
// result/phase and breaks monitoring queries) and must never resurrect a cancel.
// Canonical vocab only (ratified): the worker (v193) writes 'completed', and the
// migration normalizes legacy 'complete'/'cancelled' away.
const TERMINAL_STATUSES = [
  'completed', 'failed', 'canceled', 'needs_input',
];
const TERMINAL_SQL_LIST = `(${TERMINAL_STATUSES.join(',')})`;
// A cancel or an already-failed row is "hard terminal": even the app's OWNED
// columns (URLs) must not land on it (don't resurrect a canceled render). A
// worker 'completed' is "soft" for owned columns — the URLs still need to be
// written — but hard for the status itself.
const HARD_TERMINAL_SQL_LIST = '(failed,canceled)';

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
// Map shape: videoUrl → { promise, firedAt } — firedAt lets us compute a
// dynamic await window (longer when prewarm just fired, shorter when it
// fired a while ago and is almost certainly done).
// Entries auto-expire after 5 min to prevent unbounded growth.
const prewarmRegistry = new Map();

function registerPrewarm(videoUrl, promise) {
  const entry = { promise, firedAt: Date.now() };
  prewarmRegistry.set(videoUrl, entry);
  setTimeout(() => {
    if (prewarmRegistry.get(videoUrl) === entry) {
      prewarmRegistry.delete(videoUrl);
    }
  }, 5 * 60 * 1000);
}

/**
 * Await the prewarm hint with a DYNAMIC timeout based on how recently prewarm
 * fired. Rationale: a user who just tapped attach-then-send (prewarm fired
 * ~200ms ago) needs a longer await to catch the Promise resolution; a user
 * who typed for 10s (prewarm fired 10s ago) needs almost no wait since
 * prewarm is surely done by now.
 *   - fired <1s ago     → wait up to 4s (covers the full-cold-start path)
 *   - fired 1-3s ago    → wait up to 2s
 *   - fired 3s+ ago     → wait up to 500ms (Promise is almost certainly settled)
 * If no entry in the registry, prewarm was never fired — return null immediately.
 */
async function awaitPrewarmHint(videoUrl) {
  const entry = prewarmRegistry.get(videoUrl);
  if (!entry) return null;
  const elapsedMs = Date.now() - entry.firedAt;
  let timeoutMs;
  if (elapsedMs < 1000) timeoutMs = 4000;
  else if (elapsedMs < 3000) timeoutMs = 2000;
  else timeoutMs = 500;
  try {
    const result = await Promise.race([
      entry.promise,
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

/**
 * Fallback for a MISSED completion delivery on the spawn path (Phase 2). Both
 * the worker's /api/modal-complete POST and the Modal platform webhook normally
 * settle the pending promise with the full result; this fires ONLY if BOTH were
 * lost (a rare window — worker died between its durable Supabase write and its
 * completion POST). It reads the worker's own durable write (write_job_status
 * persists result.status + video_url + hls_manifest_url + the re-edit fields +
 * the worker-uploaded thumbnail_url) and reconstructs the FULL completion — the
 * recovery is now complete (video + HLS + Re-edit + thumbnail), no residual
 * partial state. It fires a loud [ALERT] anyway (a double-loss is infrastructure
 * sickness worth knowing) but the user loses nothing. If the worker never
 * completed, it returns FAILED and the reaper terminalizes the genuinely-dead job.
 *
 * Returns the shape registerPendingModalJob's onTimeoutCheck expects:
 * { status: 'COMPLETED'|'FAILED', output?, error? }.
 */
async function resolveSpawnedCompletionFallback({ jobId, callId }) {
  try {
    const { data: row } = await supabaseAdmin
      .from('video_jobs')
      .select('status, result, error_message')
      .eq('id', jobId)
      .maybeSingle();
    const r = (row && row.result) || {};
    const workerStatus = String(r.status || row?.status || '').toLowerCase();
    const completed = workerStatus === 'success' || workerStatus === 'completed' || !!r.video_url;
    if (completed) {
      // (2a) A double-loss (worker POST AND Modal webhook both gone) is
      // infrastructure sickness, not a log line — the owner hears it every time.
      // Grep-stable [ALERT] + owner push + a durable analytics record. All
      // best-effort: recovery must proceed even if the alerting fails.
      console.error(
        `[ALERT] completion delivery DOUBLE-LOSS job=${jobId} call=${callId} — `
        + `recovered FULLY from the worker's Supabase write (video + HLS + re-edit + thumbnail)`
      );
      sendOwnerAlert({
        ownerUserId: OWNER_USER_ID,
        title: '⚠️ Completion delivery double-loss (recovered)',
        body: `job ${String(jobId).slice(0, 8)} — both deliveries lost, recovered fully from Supabase`,
        threadId: 'render-alert',
        supabaseAdmin,
      }).catch((e) => console.error(`[dispatch] double-loss owner alert failed: ${e && e.message}`));
      supabaseAdmin.from('analytics_events').insert({
        event: 'completion_delivery_double_loss',
        platform: 'server',
        props: { job_id: jobId, call_id: callId, recovery: 'full' },
      }).then(({ error }) => {
        if (error) console.error(`[dispatch] double-loss ledger insert failed: ${error.message}`);
      }).catch(() => {});
      return {
        status: 'COMPLETED',
        output: {
          status: 'success',
          job_id: jobId,
          video_url: r.video_url || null,
          hls_manifest_url: r.hls_manifest_url || null,
          // (2b) Re-edit hydration: the worker persists these tiny fields to
          // result.*, so double-loss recovery still restores the Re-edit button.
          // The tail writes them to the columns exactly as on the normal path.
          edit_recipe: r.edit_recipe || null,
          transcript: r.transcript || null,
          analysis_data: r.analysis_data || null,
          resolved_broll: r.resolved_broll || null,
          trend_snapshot: r.trend_snapshot || null,
          render_version: r.render_version,
          change_summary: r.change_summary || null,
          // The worker now uploads its own thumbnail to S3 and persists the
          // presigned URL here — so double-loss recovery is FULLY complete
          // (video + HLS + re-edit + thumbnail). No residual partial state.
          thumbnail_url: r.thumbnail_url || null,
        },
      };
    }
    return {
      status: 'FAILED',
      error: row?.error_message || 'spawned job did not complete; reaper will terminalize',
    };
  } catch (e) {
    return { status: 'FAILED', error: `spawn fallback poll failed: ${e.message}` };
  }
}

async function dispatchJobToModal({
  jobId,
  videoUrl,
  proxyVideoUrl,
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
  // Phase D ask-back resume. When resumeAsk is true the worker (mode=resume_ask)
  // loads partial_state for this jobId and folds in `answer` instead of running
  // a fresh pipeline.
  resumeAsk = false,
  askId,
  answer,
  // Premium pipeline routing (Lumen). Caller MUST pass the already-gated
  // value — true only for an entitled Pro user. The worker double-gates it
  // anyway (route_premium = is_premium AND flag).
  premiumPipeline = false,
}) {
  if (!supabaseAdmin) throw new Error('supabase_not_configured');

  const modalEndpointUrl = process.env.MODAL_ENDPOINT_URL;
  if (!modalEndpointUrl) throw new Error('MODAL_ENDPOINT_URL is required');

  const { data: existingJob } = await supabaseAdmin
    .from('video_jobs')
    .select('id, status')
    .eq('id', jobId)
    .single();

  // A resume (ask-back answer) intentionally re-dispatches a job the server
  // already flipped to 'processing' under an optimistic lock — don't treat that
  // as a duplicate.
  if (existingJob?.status === 'processing' && !resumeAsk) {
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

  // W3: kick off deterministic burned-text detection CONCURRENTLY with the
  // presign/prewarm work below (it overlaps ~1-2s of that latency). Detect on the
  // low-res proxy when present (the full source is still in flight per the payload
  // comment), else the source. Awaited just before the payload is built; fail-open.
  const detectionUrl = proxyVideoUrl || videoUrl;
  const enrichPromise = enrichAnalysisWithDetection(cachedAnalysis, detectionUrl, videoUrl, jobId);

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
    const hintResult = await awaitPrewarmHint(videoUrl);
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

  // Fold in the burned-text detection started above (overlapped the presign/prewarm
  // work). Returns cachedAnalysis unchanged on timeout/failure (fail-open).
  cachedAnalysis = await enrichPromise;

  const payload = {
    job_id: jobId,
    video_url: videoUrl,
    // Low-res proxy. Worker uses this for Gemini visual analysis (~3-6 MB
    // file, lands in seconds) while the full-resolution source is still
    // in flight via the client's background URLSession. Render quality
    // is unaffected — the source is what gets rendered.
    ...(proxyVideoUrl ? { proxy_video_url: proxyVideoUrl } : {}),
    vibe,
    user_id: userId,
    upload_url: uploadUrl,
    public_url: publicUrl,
    app_url: appUrl,
    // Premium pipeline routing flag (Lumen). Already gated by the caller to
    // an entitled Pro user; the worker still double-gates against
    // server-derived entitlement. `model` is informational (worker logging).
    premium_pipeline_enabled: !!premiumPipeline,
    model: premiumPipeline ? 'lumen' : 'flare',
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
    // Phase D ask-back resume — worker loads partial_state + folds `answer`.
    ...(resumeAsk ? { resume: true, ask_id: askId, answer } : {}),
  };

  // 4. Update job to processing immediately so SSE fires.
  // For re-edits we also record the lineage up front so the row is queryable mid-render.
  // started_at stamps the EXECUTION-start instant (was never written before — the
  // column sat null on every row). The reaper's execution-wall (job-reaper.js) uses
  // it to catch the Modal 900s SIGKILL class (W4 #1): a SIGKILLed worker never writes
  // a terminal, so its row hangs in 'processing'; a fresh started_at makes "elapsed >
  // worker ceiling ⇒ confirmed dead" measurable directly, instead of waiting out the
  // 20-min heartbeat lease (~35min after start → ~5min). Re-set on each processing
  // transition (incl. ask-back resume) so the wall tracks the CURRENT execution.
  const initialUpdate = {
    status: 'processing',
    current_step: 'queued',
    step_message: 'Getting started...',
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (parentJobId) initialUpdate.parent_job_id = parentJobId;
  if (resolvedMode !== 'full') initialUpdate.reedit_mode = resolvedMode;
  if (changeRequest) initialUpdate.change_request = changeRequest;

  // FIRST-TERMINAL-WINS on the way IN: only a 'queued' row (fresh dispatch) or a
  // 'processing' row (resume re-dispatch) may (re-)enter processing. If a
  // concurrent reaper or a user cancel terminalized this row during the dispatch
  // window, this .in guard makes the write a no-op instead of RESURRECTING a
  // dead/refunded job to processing — then we skip firing Modal, since a worker
  // must never run on a terminalized job.
  const { data: entered, error: enterErr } = await supabaseAdmin
    .from('video_jobs')
    .update(initialUpdate)
    .eq('id', jobId)
    .in('status', ['queued', 'processing'])
    .select('id');
  if (enterErr) {
    console.error(`[dispatch] initial processing write failed job=${jobId}:`, enterErr.message);
    // fall through — best-effort, matching prior behavior; the worker's own
    // writes are first-terminal-wins guarded too.
  } else if (!Array.isArray(entered) || entered.length === 0) {
    console.warn(`[dispatch] job ${jobId} was terminalized (reaped/cancelled) before dispatch — not firing Modal`);
    return { jobId, publicUrl: null, skipped: 'already-terminal' };
  }

  // 5. Fire Modal request in background — Modal is synchronous so we await the response
  // Progress updates arrive via /api/modal-progress during execution
  // The final video URL comes back in the Modal HTTP response body
  console.log(`[dispatch] Firing Modal job for ${jobId} mode=${resolvedMode} (storage: ${useS3 ? 'S3' : 'Supabase'})`);

  // Wrap the Modal fetch in a retry loop. Transient failures (network
  // blip, Modal cold-start race, 5xx) shouldn't fail the user-visible
  // job — they should retry transparently. 4xx responses (auth, bad
  // payload) are real errors and bubble immediately. The render
  // pipeline itself is idempotent on the same job id, so a duplicate
  // request after a half-completed first attempt is safe.
  const fetchModalWithRetry = async () => {
    const maxAttempts = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const r = await fetch(modalEndpointUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        // 4xx → don't retry, surface immediately
        if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
          return r;
        }
        // 2xx → success
        if (r.ok) {
          if (attempt > 1) {
            console.log(`[dispatch] Modal succeeded for ${jobId} on attempt ${attempt}/${maxAttempts}`);
          }
          return r;
        }
        // 5xx / 408 / 429 → retriable
        lastErr = new Error(`Modal HTTP ${r.status}`);
        const body = await r.text().catch(() => '');
        console.warn(`[dispatch] Modal ${r.status} for ${jobId} (attempt ${attempt}/${maxAttempts}): ${body.slice(0, 200)}`);
      } catch (e) {
        // network-level failure
        lastErr = e;
        console.warn(`[dispatch] Modal fetch threw for ${jobId} (attempt ${attempt}/${maxAttempts}): ${e.message}`);
      }
      if (attempt < maxAttempts) {
        const backoffMs = Math.min(2000 * Math.pow(2, attempt - 1), 16000);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    throw lastErr || new Error('Modal fetch failed after retries');
  };

  (async () => {
    try {
      const res = await fetchModalWithRetry();

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
          .eq('id', jobId)
          .not('status', 'in', TERMINAL_SQL_LIST);
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
      let result = await res.json().catch(() => ({}));

      // ── DUAL-MODE (spawn refactor, Phase 2) ──────────────────────────────
      // If the worker SPAWNED the pipeline as a background function it returns
      // {spawned:true, call_id} in milliseconds instead of the result. The real
      // result then arrives via a completion callback (the worker's
      // /api/modal-complete POST and/or the Modal platform webhook → both call
      // settlePendingModalJob), and — if BOTH are ever missed — the fallback
      // below reconstructs a playable completion from the worker's own durable
      // Supabase write. The ENTIRE completion tail after this block is
      // byte-identical; only the SOURCE of `result` differs.
      //
      // SETTLE-ONCE / RACE-PROOF (Condition 1b): registerPendingModalJob resolves
      // a single-settle promise — settlePendingModalJob deletes the pending map
      // entry on the FIRST settle and a JS promise's resolve is idempotent, so a
      // late webhook, a duplicate webhook, or the fallback firing after a webhook
      // are ALL structural no-ops. The tail runs EXACTLY ONCE per job across every
      // ordering. Backward-compatible: the current synchronous worker returns the
      // result inline (no `spawned`), so this block is INERT until Phase 3.
      if (result && result.spawned === true && result.call_id) {
        const callId = String(result.call_id);
        console.log(`[dispatch] ${jobId} spawned as ${callId} — awaiting completion (callback primary, fallback armed)`);
        result = await registerPendingModalJob(callId, {
          timeoutMs: 15 * 60 * 1000, // 900s pipeline + generous margin before the fallback
          onTimeoutCheck: () => resolveSpawnedCompletionFallback({ jobId, callId }),
        });
      }

      console.log(`[dispatch] Modal job complete for ${jobId}:`, JSON.stringify(result).slice(0, 500));

      // Re-edit needs_clarification path — no video was rendered. Surface the question
      // to the user via SSE, mark the job "failed" with a soft reason, and stop.
      // Copy hygiene (Wave 1): error_message stores the QUESTION itself — the
      // old `needs_clarification: ` prefix leaked verbatim into cold-load
      // bubbles and nothing ever parsed it back (SSE status drives the UI).
      if (result?.status === 'needs_clarification') {
        const question = clarificationMessage(result?.clarification_question);
        await supabaseAdmin
          .from('video_jobs')
          .update({
            status: 'failed',
            error_message: question,
            change_summary: question,
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId)
          .not('status', 'in', TERMINAL_SQL_LIST);
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
        // Propagate the worker's structured error envelope (when present)
        // through to the SSE event so the iOS app can branch on the
        // error_code. Defense-in-depth path: when the worker rejects
        // with `tier_concurrency_limit` (rare — our /api/video-jobs
        // concurrency gate normally catches this first), iOS sees the
        // user_message + error_code and pops the upgrade paywall.
        const errCode = String(result.error);
        // RENDER_TOO_SHORT: the server's canonical copy (failure-copy.js) wins
        // over the worker's inline string — one source of truth for the words a
        // user reads, refund confirmation included.
        const userMsg = errCode === 'RENDER_TOO_SHORT'
          ? renderTooShortMessage()
          : (typeof result.user_message === 'string' && result.user_message
            ? result.user_message
            : null);
        // Behavioral flags from the worker's classified envelope. These drive
        // the iOS failure screen: requires_new_video → "trim and resubmit" flow
        // (e.g. CLIP_TOO_LONG), requires_vibe_change, retryable. Pass them
        // through verbatim so the app never has to re-classify.
        const requiresNewVideo = result.requires_new_video === true;
        const requiresVibeChange = result.requires_vibe_change === true;
        const retryable = result.retryable === true;
        console.error(`[dispatch] Pipeline error for ${jobId}: ${errCode}${userMsg ? ' — ' + userMsg : ''}`);
        await supabaseAdmin
          .from('video_jobs')
          .update({
            status: 'failed',
            error_message: userMsg || errCode,
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId)
          .not('status', 'in', TERMINAL_SQL_LIST);
        if (typeof pushProgressToSSE === 'function') {
          pushProgressToSSE(jobId, {
            status: 'failed',
            progress: 0,
            step: 'error',
            message: '',
            videoUrl: null,
            thumbnailUrl: null,
            final: true,
            error: errCode,
            // snake_case to match the iOS SSEEvent CodingKeys (error_code /
            // user_message / requires_new_video / requires_vibe_change) — the
            // previous camelCase keys silently failed to decode, so the whole
            // envelope (and the "trim and resubmit" copy for CLIP_TOO_LONG) never
            // reached the failure screen.
            error_code: errCode,
            user_message: userMsg,
            requires_new_video: requiresNewVideo,
            requires_vibe_change: requiresVibeChange,
            retryable,
          });
        }

        // Failure push (1.2.0 rider — this branch previously sent NO push, so a
        // backgrounded user never learned their render died). Body is the
        // worker's classified honest copy; the credit line is appended only
        // when the copy doesn't already say it (RENDER_TOO_SHORT does). Every
        // failed row refunds (refund-leg law), so the claim is always true.
        if (userId) {
          const pushBody = userMsg
            ? (/credit|refund|returned/i.test(userMsg) ? userMsg : `${userMsg} Your credit was returned.`)
            : 'Something went wrong — your credit was returned. Tap to try again.';
          push.sendToUser(userId, {
            title: 'Render failed — your credit was returned',
            body: String(pushBody).slice(0, 178),
          }, {
            jobId,
            type: 'render-failed',
          }).then((r) => {
            console.log(`[dispatch] Failure push (classified) for ${jobId}: sent=${r.sent ?? 0} skipped=${r.skipped ?? 'none'}`);
            logPushEvent(userId, 'render-failed', jobId, r);
          }).catch((pushErr) => {
            console.warn(`[dispatch] Failure push failed for ${jobId}: ${pushErr.message}`);
          });
        }
        return { jobId, publicUrl };
      }

      // No fallback — the rendered video URL must be a presigned GET.
      // Public CloudFront URLs return 403 on this bucket (CloudFront OAC
      // doesn't grant access to renders/), so the only URL that actually
      // plays is the signed one. If signing fails, fail the job loudly
      // rather than silently shipping a broken URL to the client.
      //
      // CRITICAL: do NOT append a `&v=...` cache buster to the signed
      // URL. AWS SigV4 signs every query parameter; appending one
      // AFTER signing breaks the signature because S3 reconstructs the
      // canonical request with all query params present. Was producing
      // SignatureDoesNotMatch 403s for every render → "thumbnail blank,
      // video doesn't play." Each fresh signed URL already has a unique
      // X-Amz-Date / X-Amz-Signature so cache invalidation is built-in.
      if (useS3 && s3OutputKey) {
        videoUrl = await s3.createPresignedGetUrl(s3OutputKey, 60 * 60 * 24 * 7);
        console.log(`[dispatch] S3 signed GET URL created for rendered video ${jobId}`);
      }

      // Thumbnail: PREFER the worker's own S3 upload (Phase 3) — it wrote the
      // JPEG to thumbnails/<job>.jpg and returned a presigned thumbnail_url, so
      // even a double-loss recovery carries it. Only if the worker didn't upload
      // do we fall back to uploading from the base64 cover frame here (the
      // legacy path — still fails loudly if S3 isn't configured, no silent
      // re-routing).
      let thumbnailUrl = (typeof result?.thumbnail_url === 'string' && result.thumbnail_url)
        ? result.thumbnail_url
        : null;
      const coverB64 = result?.cover_frame_b64;
      const coverMime = result?.cover_frame_mime || 'image/jpeg';
      if (thumbnailUrl) {
        console.log(`[dispatch] Using worker-uploaded thumbnail for ${jobId}`);
      } else if (coverB64 && typeof coverB64 === 'string') {
        const buffer = Buffer.from(coverB64, 'base64');
        if (!useS3 || !s3ThumbKey) {
          throw new Error('S3 not configured — cannot persist thumbnail');
        }
        await s3.upload(s3ThumbKey, buffer, coverMime);
        // No cache buster — would invalidate the SigV4 signature.
        thumbnailUrl = await s3.createPresignedGetUrl(s3ThumbKey, 60 * 60 * 24 * 7);
        console.log(`[dispatch] Thumbnail uploaded to S3 for ${jobId}`);
      } else {
        console.warn(`[dispatch] No worker thumbnail and no cover_frame_b64 for ${jobId}`);
      }

      // HLS manifest URL is required. Worker generates a 4-variant
      // adaptive bitrate ladder alongside the progressive MP4 and
      // returns the master manifest URL. iOS playback path is HLS-only
      // for new jobs — if the worker didn't return a manifest, the
      // job is incomplete and we fail it loudly rather than persisting
      // a half-baked completion that the player can't use.
      const hlsManifestUrl = (typeof result?.hls_manifest_url === 'string' && result.hls_manifest_url)
        ? result.hls_manifest_url
        : null;
      if (!hlsManifestUrl) {
        throw new Error(
          'Worker completed without returning hls_manifest_url — '
          + 'HLS variant ladder is required for playback'
        );
      }
      console.log(`[dispatch] HLS manifest for ${jobId}: ${hlsManifestUrl}`);

      // Write completion to DB with all re-edit persistence fields
      // OWNED completion columns — the playback + re-edit fields the app
      // resolves. NEVER status / result / phase (the worker owns terminal state
      // and writes result/phase write-once).
      const ownedUpdate = {
        progress: 100,
        current_step: 'complete',
        step_message: 'Your video is ready!',
        rendered_video_url: videoUrl,
        hls_manifest_url: hlsManifestUrl,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (thumbnailUrl) ownedUpdate.thumbnail_url = thumbnailUrl;
      if (result?.edit_recipe) ownedUpdate.edit_recipe = result.edit_recipe;
      if (result?.transcript) ownedUpdate.transcript = result.transcript;
      if (result?.analysis_data) {
        ownedUpdate.analysis_data = result.analysis_data;
        // Warm the analysis cache with the worker's real analysis + detection bands
        // (fire-and-forget — must not gate completion). Restores the cache path that
        // went stale when uploads moved to direct-S3; re-edits of this source then
        // read real cached analysis WITH bands.
        warmAnalysisCacheWithDetection(videoUrl, result.analysis_data, jobId);
      }
      if (Array.isArray(result?.resolved_broll) && result.resolved_broll.length) {
        ownedUpdate.resolved_broll = result.resolved_broll;
      }
      if (result?.trend_snapshot) ownedUpdate.trend_snapshot = result.trend_snapshot;
      if (typeof result?.render_version === 'number') ownedUpdate.render_version = result.render_version;
      if (result?.change_summary) ownedUpdate.change_summary = result.change_summary;

      // 1) Owned columns — merge, but NOT onto a hard-terminal row (a cancelled
      //    or failed job must not be resurrected with a fresh video URL).
      await supabaseAdmin
        .from('video_jobs')
        .update(ownedUpdate)
        .eq('id', jobId)
        .not('status', 'in', HARD_TERMINAL_SQL_LIST);
      // 2) Terminal status — FIRST-TERMINAL-WINS. Only set 'completed' when the
      //    row is not already terminal, so the worker's authoritative 'complete'
      //    (+ its write-once result/phase) stands and monitoring keeps working.
      //    When the worker's durable status is present this no-ops; when it's
      //    absent this is the safety net that still lets the client see completion.
      await supabaseAdmin
        .from('video_jobs')
        .update({ status: 'completed' })
        .eq('id', jobId)
        .not('status', 'in', TERMINAL_SQL_LIST);

      if (typeof pushProgressToSSE === 'function') {
        pushProgressToSSE(jobId, {
          status: 'completed',
          progress: 100,
          step: 'complete',
          message: 'Your video is ready!',
          videoUrl,
          hlsManifestUrl,
          thumbnailUrl: thumbnailUrl || null,
          changeSummary: result?.change_summary || null,
          final: true,
          error: null,
        });
      }

      // APNs push for users who backgrounded the app while we rendered.
      // Fire-and-forget — push failure must never block render delivery.
      //
      // Two pushes:
      //   1) Silent (content-available) — wakes the iOS app for ~30s
      //      so it can download the rendered video into its local
      //      cache before the user even opens the app. By the time
      //      they tap the alert, the file is on disk and playback is
      //      Photos-app instant.
      //   2) Alert — the visible "Your edit is ready" banner.
      if (userId) {
        const silentData = {
          jobId,
          videoUrl,
          hlsManifestUrl,
          type: 'render-complete-prefetch',
        };
        push.sendToUser(userId, null, silentData, { silent: true })
          .then((r) => {
            console.log(`[dispatch] Silent push for ${jobId}: sent=${r.sent ?? 0} skipped=${r.skipped ?? 'none'}`);
          })
          .catch((err) => {
            console.warn(`[dispatch] Silent push failed for ${jobId}: ${err.message}`);
          });

        push.sendToUser(userId, {
          title: 'Your video is ready 🎬',
          body: vibe ? `“${String(vibe).slice(0, 80)}” is done.` : 'Tap to watch.',
        }, {
          jobId,
          type: 'render-complete',
        }).then((r) => {
          console.log(`[dispatch] Alert push for ${jobId}: sent=${r.sent ?? 0} skipped=${r.skipped ?? 'none'}`);
          logPushEvent(userId, 'render-complete', jobId, r);
        }).catch((err) => {
          console.warn(`[dispatch] Alert push failed for ${jobId}: ${err.message}`);
        });
      }

      // Log the EXACT URLs going into the SSE event. If the user reports
      // "thumbnail blank / video doesn't play" we can correlate against
      // these to know whether the issue is signing (we'd see CloudFront
      // URLs here) or playback (signed URLs here but client can't fetch).
      console.log(`[dispatch] Job ${jobId} videoUrl: ${videoUrl}`);
      console.log(`[dispatch] Job ${jobId} thumbnailUrl: ${thumbnailUrl ?? 'NULL'}`);
    } catch (err) {
      console.error(`[dispatch] Modal fetch error for ${jobId}: ${err.message}`);
      // Copy hygiene (Wave 1): the raw err.message is engineering text
      // ("Modal fetch failed after retries", ECONNREFUSED …) and previously
      // passed the iOS display filters verbatim. It stays in the log line
      // above; the row + SSE get clean transient-failure copy.
      const dispatchCopy = dispatchErrorMessage();
      await supabaseAdmin
        .from('video_jobs')
        .update({
          status: 'failed',
          error_message: dispatchCopy,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .not('status', 'in', TERMINAL_SQL_LIST);
      if (typeof pushProgressToSSE === 'function') {
        pushProgressToSSE(jobId, {
          status: 'failed',
          progress: 0,
          step: 'error',
          message: '',
          videoUrl: null,
          thumbnailUrl: null,
          final: true,
          error: dispatchCopy,
        });
      }
      if (userId) {
        // Build a body that gives the user something concrete. Don't
        // surface raw error.message — those are often Python tracebacks
        // or boto3 noise. Map common patterns to user-readable copy,
        // fall back to a generic line otherwise.
        const raw = String(err?.message || '').toLowerCase();
        // Honest copy: EVERY failed row refunds (the refund-leg law, 2026-07-11),
        // so "your credit was returned" is always true here.
        let reasonLine = 'Something went wrong.';
        if (raw.includes('timeout') || raw.includes('timed out')) {
          reasonLine = 'The render timed out.';
        } else if (raw.includes('hls') || raw.includes('manifest')) {
          reasonLine = 'We couldn\u2019t finish the stream files.';
        } else if (raw.includes('s3') || raw.includes('upload')) {
          reasonLine = 'The upload didn\u2019t make it through.';
        } else if (raw.includes('gemini') || raw.includes('quota') || raw.includes('rate limit')) {
          reasonLine = 'The AI hit a rate limit.';
        }

        push.sendToUser(userId, {
          title: 'Render failed \u2014 your credit was returned',
          body: `${reasonLine} Tap to try again.`,
        }, {
          jobId,
          type: 'render-failed',
        }).then((r) => {
          console.log(`[dispatch] Failure push for ${jobId}: sent=${r.sent ?? 0} skipped=${r.skipped ?? 'none'}`);
          logPushEvent(userId, 'render-failed', jobId, r);
        }).catch((pushErr) => {
          console.warn(`[dispatch] Failure push failed for ${jobId}: ${pushErr.message}`);
        });
      }
    }
  })();

  return { jobId, publicUrl };
}

module.exports = { dispatchJobToModal, registerPrewarm };

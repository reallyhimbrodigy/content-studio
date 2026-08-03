const { supabaseAdmin } = require('../../services/supabase-admin');
const { sourceKeyFromUrl, waitForSource } = require('../source-presence');
const s3 = require('../../services/s3');
const push = require('../../services/push');
const { dispatchErrorMessage, clarificationMessage, renderTooShortMessage, rejectionCopy, coreErrorMessage, sourceMissingMessage } = require('../failure-copy');
const { refundJobCharge } = require('../refund-leg');
const { registerPendingModalJob } = require('./modal-webhook');
const { sendOwnerAlert } = require('../../services/pushNotifier');
const { postAgentAlert } = require('../agent-alert');
const { isKnownOutageActive } = require('../known-outage');
const { sendCompletionEmail } = require('../email');
const { sendLifecyclePush } = require('../lifecycle-push');

// Founder user id — target for the double-loss operator alert (2a). Same const
// the reaper uses; env-overridable.
const OWNER_USER_ID = process.env.OWNER_USER_ID || 'ec702499-ca10-49e6-8850-df8f99840904';

// Server-side funnel/analytics event → BOTH sinks (analytics_events + PostHog),
// keyed by the Supabase userId (== the client's identified distinct_id, so the
// activation funnel joins client + server events for one person). Fire-and-
// forget — never touches the render path. This is where the render LIFECYCLE +
// content-rejection signals are authoritative (the worker classified them), so
// render_started / render_completed / *_rejected fire from here, not the client.
function funnelEvent(userId, event, props = {}) {
  if (!userId) return;
  try {
    supabaseAdmin.from('analytics_events').insert({
      event, anon_user_id: userId, user_id: userId,
      platform: 'server', app_version: 'dispatch', props,
    }).then(({ error }) => { if (error) console.warn(`[funnel] ${event} mirror failed:`, error.message); });
    require('../posthog-sink').phCapture(userId, event, props);
  } catch (e) { console.warn(`[funnel] ${event} failed:`, e && e.message); }
}

// Map a worker error_code to a content-rejection funnel event (the non-talking-
// head demand signal + upload-quality failures), or null for a non-rejection.
function rejectionEventFor(errCode) {
  const c = String(errCode || '').toUpperCase();
  if (c === 'NOT_TALKING_HEAD' || c === 'NO_SPEECH_FACE') return 'not_talking_head_rejected';
  if (c === 'NO_SPEECH' || c === 'NO_SPEECH_NONENGLISH') return 'no_speech_rejected';
  if (c === 'NO_AUDIO_TRACK') return 'no_audio_rejected';
  return null;
}

// (push_sent telemetry now rides lib/lifecycle-push.js — same event shape.)
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
  // Bumped 2026-07-23 to raise NO_SPEECH pre-dispatch gate coverage: we now wait
  // up to ~4s for the prewarm transcription (which yields word_count) before
  // dispatch. Net latency is ~neutral — the worker loads that SAME cached
  // transcript and skips its own transcribe, so the wait is repaid downstream.
  // The promise resolves the instant transcription finishes, so a done prewarm
  // still returns immediately; the cap only bites when transcription is slow.
  let timeoutMs;
  if (elapsedMs < 1000) timeoutMs = 4000;
  else if (elapsedMs < 3000) timeoutMs = 4000;
  else timeoutMs = 3000;
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

// Pre-dispatch NO_SPEECH gate copy (2026-07-23). The prewarm transcribes once at
// upload and caches it; its word_count lets us reject a speechless clip BEFORE
// GPU dispatch (0-word clips otherwise burn 20-40s of Modal then die downstream).
// Same honest words as the worker's post-render NO_SPEECH. The MIC variant is the
// worker's NO_SPEECH_FACE copy (face present, 0 words) — the pre-dispatch hint has
// no face signal, so the gate always uses the plain copy.
// Server-canonical copy (failure-copy.js) so the pre-dispatch gate and the
// post-render NO_SPEECH path speak the exact same words.
const NO_SPEECH_COPY = rejectionCopy('NO_SPEECH');
const NO_SPEECH_MIC_COPY = rejectionCopy('NO_SPEECH_FACE');

// Mark a job failed WITHOUT dispatching (pre-dispatch reject). Mirrors the
// worker-error failure path: status=failed + honest copy + a result envelope so
// the client's existing failure UI (error_code / user_message) renders it, and
// leaves refunded_at NULL so the refund-leg sweep returns the credit. Fires the
// same funnel events the post-render failure fires (render_failed + the content-
// rejection signal). SSE push is best-effort (a client may already be listening).
async function markJobFailed(jobId, { errorCode, userMessage, userId, pushProgressToSSE } = {}) {
  const msg = userMessage || errorCode || 'RENDER_FAILED';
  await supabaseAdmin
    .from('video_jobs')
    .update({
      status: 'failed',
      error_message: msg,
      result: { error_code: errorCode, user_message: msg, retryable: false },
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .not('status', 'in', TERMINAL_SQL_LIST);
  funnelEvent(userId, 'render_failed', { job_id: jobId, error_code: errorCode });
  const rej = rejectionEventFor(errorCode);
  if (rej) funnelEvent(userId, rej, { job_id: jobId, error_code: errorCode });
  if (typeof pushProgressToSSE === 'function') {
    try {
      pushProgressToSSE(jobId, {
        status: 'failed', progress: 0, step: 'error', message: '',
        videoUrl: null, thumbnailUrl: null, final: true,
        error: errorCode, error_code: errorCode, user_message: msg,
        requires_new_video: false, requires_vibe_change: false, retryable: false,
      });
    } catch (_) { /* SSE best-effort — never wedge the reject on a push error */ }
  }
}

// Inline daily-quota refund on a worker/dispatch failure. Same policy as the
// refund-leg sweep — every failed PRIMARY row refunds (2026-07-11 law), while
// re-edit/resume rows never minted a charge and stay excluded — this just
// returns the slot NOW instead of at the next ≤interval sweep, so a user whose
// render died isn't locked out of their (1/day) quota until the sweep runs.
// Idempotent + best-effort: refundJobCharge one-shot-claims refunded_at, so the
// sweep is a structural no-op afterward, and any throw here leaves refunded_at
// NULL for the sweep to catch. Never let a refund error mask the real failure.
async function refundJobInline(jobId, tag) {
  try {
    const { data: job, error } = await supabaseAdmin
      .from('video_jobs')
      .select('id, user_id, created_at, parent_job_id, reedit_mode')
      .eq('id', jobId)
      .single();
    if (error || !job) return;
    if (job.parent_job_id != null || job.reedit_mode != null) return; // re-edit/resume: no charge minted
    const outcome = await refundJobCharge(supabaseAdmin, job);
    if (outcome?.action === 'refunded') {
      console.log(`[dispatch] inline quota refund job=${jobId} (${tag}) charge=${outcome.charge} (Δ${outcome.deltaMs}ms)`);
    }
  } catch (e) {
    console.warn(`[dispatch] inline refund threw job=${jobId} (${tag}) — sweep backstop will catch it: ${e?.message || e}`);
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
// ── The DISPATCH-REACH failure class (2026-08-02) ───────────────────────────
// Both dispatch-layer terminal writes used to set `error_message` and NOTHING
// else — no `result`, so no error_code. That made this class invisible to every
// count that reads result->error_code, which is every count we have. It is not
// a small class: in the 7 days to 2026-08-02 it was 1,144 of 1,324 failed jobs
// (86%) across 562 distinct users — larger than every coded class combined, and
// it hid twice in one night's triage because nothing could see it.
//
// Two codes, because the two cases need different operator responses:
//   RENDER_UNAVAILABLE   — Modal answered 404. The render app is not deployed
//                          or has been stopped (the spend-cap signature). The
//                          fix is on our side and affects EVERY user at once.
//   DISPATCH_UNREACHABLE — any other non-2xx, or the fetch threw (network,
//                          ECONNREFUSED, retries exhausted). Transient-shaped.
// Both are infrastructure, never the user's fault: refunded (the callers
// already refund inline) and retryable. http_status rides in the envelope so
// 502 vs 503 vs throw stays answerable without inventing a code per status.
const DISPATCH_ERROR_CODES = ['RENDER_UNAVAILABLE', 'DISPATCH_UNREACHABLE'];

function dispatchFailureResult({ httpStatus = null, userMessage, detail }) {
  const code = httpStatus === 404 ? 'RENDER_UNAVAILABLE' : 'DISPATCH_UNREACHABLE';
  return {
    error: code,
    error_code: code,
    error_class: 'dispatch',
    error_where: 'content-studio/dispatch-to-modal',
    user_message: userMessage,
    // Infrastructure interruption — the user did nothing wrong and is refunded.
    retryable: true,
    requires_new_video: false,
    requires_vibe_change: false,
    refunded: true,
    http_status: httpStatus,
    error_detail: detail || null,
  };
}

// Dispatch TRANSPORT keys — these describe the spawn handshake, not the render.
// They are the only keys the recovery path may not echo back: `spawned:true` +
// `call_id` is the sentinel the dispatcher uses to decide "this is a spawn stub,
// go wait for the real result", so replaying them out of a recovered result
// risks re-entering the wait. Everything else the worker wrote is render truth
// and rides through untouched.
const DISPATCH_TRANSPORT_KEYS = ['spawned', 'call_id'];

/**
 * Carry the worker's ENTIRE result envelope forward, minus the transport keys.
 *
 * WHY THIS IS NOT AN ALLOWLIST (2026-08-01)
 * -----------------------------------------
 * This used to hand-list the 13 keys recovery echoed back, so the other 10 the
 * completion tail actually reads — public_url, rendered_video_url,
 * cover_frame_b64/_mime, clarification_question, user_message, error,
 * retryable, requires_new_video, requires_vibe_change — were dropped in
 * silence, along with every diagnostic the worker writes (error_code,
 * error_detail, stage_timings, stage_manifest, floor, enhancements_dropped).
 * Concretely: a job whose worker-side thumbnail upload failed lost its
 * cover_frame_b64 too and recovered with NO thumbnail; a job that wrote
 * public_url but not video_url recovered with NO video.
 *
 * The deeper failure was structural: the list could only ever describe what the
 * worker wrote on the day it was written. Every new top-level result key the
 * worker adds is dropped here by default, with no error and no log line —
 * the same shape as the `extra="forbid"` schema mirror that silently ate
 * motionTokens, and the analytics events that vanished for want of an
 * allowlist entry. Pass-through inverts the default: new keys ride for free,
 * and only the two transport keys are named.
 */
function carryWorkerResult(r) {
  const out = { ...(r || {}) };
  for (const k of DISPATCH_TRANSPORT_KEYS) delete out[k];
  return out;
}

// A spawned job whose WORKER NEVER STARTED: the completion fallback returned
// FAILED with an EMPTY worker envelope — none of the fields the worker itself
// writes (stage_timings, a coded error_code, or any delivery URL) are present.
// This is the re-spawnable dispatch-loss shape (drain/cold-start race, ~15-min
// await wall). A WEDGED render that actually RAN leaves worker output behind and
// must NOT re-spawn (re-firing would burn another ~900s — the compound wait).
function workerNeverStarted(result) {
  if (!result || result.status !== 'FAILED') return false;
  const o = result.output || {};
  return !(o.stage_timings || o.error_code
           || o.video_url || o.public_url || o.rendered_video_url);
}

// THREE-WAY re-spawn decision (Zac 2026-08-02). A job that RENDERED but whose
// completion write was lost/delayed presents as an EMPTY envelope too, identical
// to never-started (476fe663 lost both delivery paths, recovered from Supabase).
// So before re-spawning we re-read Supabase (a fresh resolveSpawnedCompletionFallback
// = the completion reconciler's find+project). This function turns the pair
// (initial await result, fresh re-check) into the safe action:
//   'as_is'   — initial is COMPLETED, or a WEDGED render that ran → use it, never re-spawn
//   'project' — re-check found a result: the worker DID render, write just landed → PROJECT, never pay twice
//   'respawn' — re-check is STILL an empty envelope → truly never started → safe to re-fire once
// The worker's own Modal function timeout (modal_app.py run_pipeline_bg
// timeout=3000). PAST THIS, a container provably cannot still be running, which
// is the only safe basis for re-spawning a job that started — under it, a slow
// render is indistinguishable from a stranded one and re-spawning would render
// and CHARGE twice.
const WORKER_FN_TIMEOUT_MS = 3000 * 1000;

/** Did a worker START but leave NO verdict — the drained-container shape? */
function workerStrandedNoTerminal(result) {
  if (!result || result.status !== 'FAILED') return false;
  const o = result.output || {};
  const started = Boolean(o.stage_timings || o.stage_manifest || o.floor);
  const decided = Boolean(o.error_code || o.video_url || o.public_url || o.rendered_video_url);
  return started && !decided;
}

function respawnDecision(initial, recheck, elapsedMs) {
  if (!workerNeverStarted(initial)) return 'as_is';          // completed / wedged
  if (recheck && recheck.status === 'COMPLETED') return 'project';  // rendered-but-unwritten
  if (workerNeverStarted(recheck)) return 'respawn';         // genuinely never started
  // FOURTH CASE (2026-08-03): the worker STARTED and left no terminal — the
  // shape a drained container leaves behind. Previously this fell to 'as_is'
  // and the user got a failure for a render nothing was wrong with.
  //
  // This is NOT "retry as an answer to failure": a failure produces a coded
  // envelope, which still returns 'as_is' below and is surfaced honestly. This
  // is the ABSENCE of any verdict — nobody decided anything.
  //
  // Gated on elapsed BEYOND the worker's own function timeout, because that is
  // the only point at which the container provably cannot still be rendering.
  // Unknown elapsed fails safe to 'as_is' — never re-spawn on a guess.
  if (workerStrandedNoTerminal(recheck)
      && typeof elapsedMs === 'number' && elapsedMs > WORKER_FN_TIMEOUT_MS) {
    return 'respawn';
  }
  return 'as_is';                                            // re-check surfaced worker output → wedged
}

/**
 * Did the worker ever actually RUN on this job?
 *
 * DISPATCH_UNREACHABLE has been unowned all day (44 jobs / 29 users in 30d, 34
 * in the last 7) because its detail said only "dispatch threw: spawned job did
 * not complete" — which cannot distinguish the two very different causes:
 *
 *   NEVER-SPAWNED : Modal accepted the spawn and no container ever started.
 *                   The fix is on the spawn/platform side.
 *   RAN-AND-LOST  : a worker ran, wrote progress, and its completion never
 *                   reached us. The fix is delivery, not spawn.
 *
 * The job row answers it: the worker owns current_step/progress and moves them
 * off 'queued'/0 as soon as it starts. Reading that at terminal-write time
 * splits the class in two without any new instrumentation.
 */
async function workerProgressWitness(supabaseAdmin, jobId) {
  try {
    const { data } = await supabaseAdmin
      .from('video_jobs')
      .select('current_step, progress, progress_step, started_at, result')
      .eq('id', jobId)
      .maybeSingle();
    if (!data) return { moved: null, reason: 'row_unreadable' };
    const step = String(data.current_step || '');
    const pct = Number(data.progress || 0);
    const res = (data && data.result) || {};
    const workerFields = ['stage_timings', 'stage_manifest', 'floor', 'enhancements_dropped']
      .filter((k) => k in res);
    const moved = Boolean(
      (step && step !== 'queued' && step !== 'Queued') || pct > 0 || workerFields.length,
    );
    return {
      moved,
      current_step: step || null,
      progress: pct,
      worker_fields: workerFields,
      verdict: moved ? 'RAN_AND_LOST' : 'NEVER_SPAWNED',
    };
  } catch (e) {
    return { moved: null, reason: `witness_failed: ${e && e.message}` };
  }
}

async function resolveSpawnedCompletionFallback({ jobId, callId }) {
  try {
    const { data: row } = await supabaseAdmin
      .from('video_jobs')
      .select('status, result, error_message')
      .eq('id', jobId)
      .maybeSingle();
    const r = (row && row.result) || {};
    const workerStatus = String(r.status || row?.status || '').toLowerCase();
    // video_url is only ONE of the three URL fields the tail accepts; a worker
    // that wrote public_url / rendered_video_url instead used to read here as
    // "never completed" and get routed to the reaper as a dead job.
    const anyVideoUrl = r.video_url || r.public_url || r.rendered_video_url;
    const completed = workerStatus === 'success' || workerStatus === 'completed' || !!anyVideoUrl;
    if (completed) {
      // (2a) A double-loss (worker POST AND Modal webhook both gone) is
      // infrastructure sickness, not a log line — the owner hears it every time.
      // Grep-stable [ALERT] + owner push + a durable analytics record. All
      // best-effort: recovery must proceed even if the alerting fails.
      // CORRECTED (2026-08-02): this used to claim "recovered FULLY" on the
      // strength of the ROW alone. Job 476fe663 logged exactly that while every
      // delivery column stayed NULL — the user never received the video. An
      // alert that claims recovery must verify what the CLIENT reads, so the
      // claim is now conditional on the delivery columns and the unrecovered
      // case says so loudly.
      const _delivered = Boolean(row && (row.rendered_video_url || row.result_url));
      console.error(
        `[ALERT] completion delivery DOUBLE-LOSS job=${jobId} call=${callId} — `
        + (_delivered
          ? "row + delivery columns both present — recovered from the worker's Supabase write"
          : 'row recovered but DELIVERY COLUMNS ARE STILL NULL — the user cannot play this '
            + 'yet; the completion reconciler must project it (lib/completion-reconcile.js)')
      );
      sendOwnerAlert({
        ownerUserId: OWNER_USER_ID,
        title: '⚠️ [Promptly] completion delivery double-loss (recovered)',
        body: `job ${String(jobId).slice(0, 8)} — both deliveries lost, recovered fully from Supabase`,
        threadId: 'render-alert',
        supabaseAdmin,
      }).catch((e) => console.error(`[dispatch] double-loss owner alert failed: ${e && e.message}`));
      supabaseAdmin.from('analytics_events').insert({
        event: 'completion_delivery_double_loss',
        platform: 'server',
        props: { job_id: jobId, call_id: callId,
                 recovery: _delivered ? 'full' : 'row_only_columns_null' },
      }).then(({ error }) => {
        if (error) console.error(`[dispatch] double-loss ledger insert failed: ${error.message}`);
      }).catch(() => {});
      return {
        status: 'COMPLETED',
        // PASS-THROUGH, not an allowlist. Everything the worker durably wrote
        // rides forward — including the keys the completion tail reads that
        // the old hand-list dropped (public_url, rendered_video_url,
        // cover_frame_b64/_mime, clarification_question, user_message,
        // retryable, requires_new_video, requires_vibe_change) and every
        // diagnostic (error_code, error_detail, stage_timings, floor, ...).
        output: {
          ...carryWorkerResult(r),
          // Only the fields recovery must NORMALISE are overridden.
          status: 'success',
          job_id: jobId,
          // video_url is what the tail prefers; fall back to the worker's other
          // URL fields so a result that wrote public_url still delivers a video.
          video_url: anyVideoUrl || null,
          hls_manifest_url: r.hls_manifest_url || null,
        },
      };
    }
    // The FAILED branch was dropping the worker's honest envelope too — a
    // double-loss on a failed job degraded a coded, user-facing error into a
    // bare row-level error_message. Carry the whole envelope; `error` stays
    // the string the caller expects.
    return {
      status: 'FAILED',
      output: carryWorkerResult(r),
      error: r.error || r.user_message || row?.error_message
        || 'spawned job did not complete; reaper will terminalize',
    };
  } catch (e) {
    return { status: 'FAILED', error: `spawn fallback poll failed: ${e.message}` };
  }
}

// ── Dispatch-layer outage detector + cap-detection ──────────────────────────
// /api/internal/render-alert is WORKER-triggered, so a failure at the DISPATCH
// layer (Modal 404 / spend-cap stop / network / Modal down) never reaches the
// worker and pages nobody — a 100% render outage ran >24h unpaged (2026-07-30:
// Modal stopped promptly-gpu-worker at the $1,500 billing-cycle spend cap). This
// pages the owner when dispatch failures cluster within a short window, and
// NAMES the cap explicitly so the next person diagnoses it in seconds.
const _dispatchFails = [];               // timestamps of recent dispatch-layer failures
const _dispatchFailMeta = [];            // {jobId, userId, status} parallel to _dispatchFails (for the diag payload)
let _dispatchAlertedAt = 0;
let _lastGoodTs = null;                   // last known-good dispatch (2xx) — carried in the agent payload
const _DF_WINDOW_MS = 10 * 60 * 1000;    // rolling window
const _DF_THRESHOLD = 5;                 // N failures in-window across jobs → page
const _DF_COOLDOWN_MS = 30 * 60 * 1000;  // don't re-page for 30 min once fired
// RECOVERY latch (2026-07-31, condition 4): once the app has been seen DOWN — a
// MODAL_404 dispatch, or a boot inside the known-outage window — the FIRST
// successful completion fires ONE owner page ("renders are back"), as loudly as
// the break would have. Seeded from the outage flag so a process that boots
// during the outage is primed to announce the recovery.
let _sawOutage = isKnownOutageActive();
let _recoveryPaged = false;
function noteDispatchSuccess() { _dispatchFails.length = 0; _dispatchFailMeta.length = 0; _lastGoodTs = new Date().toISOString(); }  // any success clears the window
// Called on the first real render_completed. Announces recovery exactly once.
function noteRenderRecovery() {
  if (!_sawOutage || _recoveryPaged) return;
  _recoveryPaged = true;
  _sawOutage = false;
  console.log('[ALERT] RENDER RECOVERY — first completion after the outage; paging owner');
  Promise.resolve(sendOwnerAlert({
    ownerUserId: OWNER_USER_ID,
    title: '✅ [Promptly] RENDERS ARE BACK',
    body: 'First render completed after the outage — the pipeline is delivering again.',
    threadId: 'render-recovery', supabaseAdmin,
  })).catch((e) => console.error('[ALERT] recovery page failed:', e && e.message));
}
function noteDispatchFailure(status, jobId, userId) {
  const now = Date.now();
  _dispatchFails.push(now);
  _dispatchFailMeta.push({ jobId, userId, status });
  if (Number(status) === 404) _sawOutage = true; // prime the recovery page
  while (_dispatchFails.length && _dispatchFails[0] < now - _DF_WINDOW_MS) { _dispatchFails.shift(); _dispatchFailMeta.shift(); }
  const n = _dispatchFails.length;
  if (n < _DF_THRESHOLD || now - _dispatchAlertedAt < _DF_COOLDOWN_MS) return;
  _dispatchAlertedAt = now;
  const is404 = Number(status) === 404;  // a run of 404s = the Modal spend-cap / stopped-app signature
  // OWNER-PAGE MUTE (condition 1): during a KNOWN outage, mute the owner page ONLY
  // for the pure cap signature — an all-MODAL_404 cluster. If ANY failure in the
  // window is a different status, allCap is false → page loudly, so the mute can
  // never hide a NEW break behind the known one. Logging + the agent webhook fire
  // regardless of the mute.
  const allCap = _dispatchFailMeta.length > 0 && _dispatchFailMeta.every((m) => Number(m.status) === 404);
  const muteOwnerPage = allCap && isKnownOutageActive();
  const title = is404
    ? '🚨 [Promptly] RENDER SERVICE UNAVAILABLE — check Modal spend cap'
    : `🚨 [Promptly] RENDER DISPATCH FAILING (${status || 'network'})`;
  const body = `${n} dispatch failures in ${_DF_WINDOW_MS / 60000}min`
    + (is404 ? ' · all Modal 404 → app likely stopped at the $1,500 billing-cycle spend cap' : ` · Modal ${status || 'unreachable'}`);
  console.error(`[ALERT] DISPATCH-LAYER OUTAGE — ${body}${muteOwnerPage ? ' · owner page MUTED (known outage, pure-cap signature)' : ''}`);
  if (!muteOwnerPage) {
    Promise.resolve(sendOwnerAlert({ ownerUserId: OWNER_USER_ID, title, body, threadId: 'dispatch-outage', supabaseAdmin }))
      .catch((e) => console.error('[ALERT] dispatch-outage page failed:', e && e.message));
  }
  // ALSO wake an investigating agent (gated + hard-capped inside postAgentAlert;
  // dormant until AGENT_ALERT_WEBHOOK_URL is set). Payload carries enough to
  // diagnose without a query round-trip: class, count, window, affected ids,
  // last known-good dispatch time.
  Promise.resolve(postAgentAlert({
    error_class: is404 ? 'RENDER_UNAVAILABLE_404' : 'DISPATCH_FAILURE',
    count: n,
    window_min: _DF_WINDOW_MS / 60000,
    job_ids: _dispatchFailMeta.map((m) => m.jobId).filter(Boolean).slice(-10),
    user_ids: [...new Set(_dispatchFailMeta.map((m) => m.userId).filter(Boolean))].slice(0, 10),
    last_good_ts: _lastGoodTs,
    hint: is404
      ? 'Run of Modal 404s — the render app is likely stopped at the $1,500 billing-cycle spend cap. Nothing content-studio-side restores renders until the cycle rolls; verify the Modal app status.'
      : `Modal ${status || 'unreachable'} at the dispatch layer.`,
  })).catch((e) => console.error('[ALERT] dispatch-outage agent-wake failed:', e && e.message));
}

async function dispatchJobToModal({
  jobId,
  videoUrl,
  proxyVideoUrl,
  vibe,
  userId,
  pushProgressToSSE,
  // Prewarm hint already resolved by the caller (the NO_SPEECH pre-dispatch gate
  // awaits it to gate, then passes it here so we don't await it a second time).
  // `undefined` (not passed) → resolve it ourselves as before.
  prewarmHintResult,
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
  // §5 progressive playback CAPABILITY (per-dispatch). True only when a 1.3.3+
  // client advertised it. The worker publishes a partial HLS preview ONLY for
  // flagged jobs, and gates on the global kill switch on top. Defaults false so
  // pre-1.3.3 dispatches (and any caller that omits it) never trigger a preview.
  supportsProgressive = false,
  // Per-job integrity bypass (2026-08-02, owner re-dispatch). When true the worker
  // ships the render even if the integrity guard trips — e.g. black spans that are
  // the user's OWN footage, where shipping-with-the-black is the correct outcome.
  // Owner-initiated only; the worker reads input_data.integrity_observe_only.
  integrityObserveOnly = false,
}) {
  if (!supabaseAdmin) throw new Error('supabase_not_configured');

  // Funnel: the render actually kicks off here. `mode` distinguishes a fresh
  // render from a re-edit/resume so the activation funnel isn't polluted.
  funnelEvent(userId, 'render_started', { job_id: jobId, mode: mode || 'render', premium: !!premiumPipeline });

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
    // Reuse the caller's already-resolved hint (from the pre-dispatch gate) when
    // provided; otherwise resolve it here as before.
    const hintResult = prewarmHintResult !== undefined ? prewarmHintResult : await awaitPrewarmHint(videoUrl);
    if (hintResult && !hintResult.error) {
      prewarmHint = {
        cache_key: hintResult.cache_key || null,
        source_cached: Boolean(hintResult.cached || hintResult.status === 'success' || hintResult.status === 'cached'),
        transcript_cached: Boolean(hintResult.transcript_cached),
        // Worker's word count from the cached transcription — powers the
        // NO_SPEECH pre-dispatch gate and rides to the worker as a confirmation.
        word_count: hintResult.word_count,
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
    // §5 progressive: the client can consume a partial HLS preview. The worker
    // publishes a preview for this job ONLY when true (and the global kill switch
    // is on). Absent/false on the 1.3.2 majority → no wasted preview encode.
    supports_progressive: !!supportsProgressive,
    ...(integrityObserveOnly ? { integrity_observe_only: true } : {}),
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

  // ── SOURCE PRESENCE GATE (2026-08-02) — never spawn for a video that
  // isn't there. One HEAD (~50ms) decides it. If the object is still in
  // flight we wait HERE, server-side, with NO Modal container running; the
  // worker used to hold cpu=16/64GiB for the full 600s just to discover this
  // (94 jobs / 60% of all failures in the 7 days to 2026-08-02, ~$0.62 each).
  //
  // Budget stays 600s deliberately: the only reason to shorten it was cost,
  // and moving the wait off Modal removes that. Killing a slow-but-working
  // upload on a poor connection is strictly worse than a long wait.
  //
  // FAIL-OPEN: waitForSource returns present:true/unknown whenever S3 cannot
  // answer, so an S3 blip can never reject a real upload.
  {
    const _srcKey = sourceKeyFromUrl(videoUrl);
    const _t0 = Date.now();
    const _pres = await waitForSource(_srcKey, {
      log: (m) => console.log(`[source] job=${jobId} ${m}`),
    });
    if (_pres.present && _pres.unknown) {
      console.log(`[source] job=${jobId} presence UNKNOWN (${_pres.reason}) — dispatching anyway (fail-open)`);
    } else if (_pres.present) {
      if ((_pres.attempts || 1) > 1) {
        console.log(`[source] job=${jobId} arrived after ${Math.round((Date.now() - _t0) / 1000)}s `
          + `(${_pres.attempts} HEADs) — dispatching`);
      }
    } else {
      // Definite: the source never landed. Terminal WITHOUT ever spawning.
      const _msg = sourceMissingMessage();
      console.log(`[source] job=${jobId} NEVER ARRIVED after ${Math.round((Date.now() - _t0) / 1000)}s `
        + `(${_pres.attempts} HEADs) — failing WITHOUT spawning Modal`);
      const { data: _wonRows } = await supabaseAdmin
        .from('video_jobs')
        .update({
          status: 'failed',
          error_message: _msg,
          result: {
            error: 'UPLOAD_NEVER_STARTED',
            error_code: 'UPLOAD_NEVER_STARTED',
            error_class: 'upload',
            error_where: 'content-studio/dispatch (pre-spawn source gate)',
            user_message: _msg,
            // A render that never had a source must not cost a credit, and a
            // retry of THIS key can only fail again — the user must re-pick,
            // which mints a fresh key. Both facts are in the envelope so the
            // client can route to the picker instead of to a retry button.
            retryable: false,
            requires_new_video: true,
            refunded: true,
            modal_spawned: false,
            source_key: _srcKey,
            waited_s: Math.round((Date.now() - _t0) / 1000),
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .not('status', 'in', TERMINAL_SQL_LIST)
        .select('id');
      await refundJobInline(jobId, 'source-never-arrived');
      if (Array.isArray(_wonRows) && _wonRows.length > 0) {
        sendLifecyclePush(supabaseAdmin, {
          jobId, userId, kind: 'failed', errorMessage: _msg, refunded: true,
        }).catch(() => {});
      }
      if (typeof pushProgressToSSE === 'function') {
        pushProgressToSSE(jobId, {
          status: 'failed', progress: 0, step: 'error', message: '',
          videoUrl: null, thumbnailUrl: null, final: true,
          error: _msg, error_code: 'UPLOAD_NEVER_STARTED',
          retryable: false, requires_new_video: true,
        });
      }
      return { jobId, publicUrl: null, skipped: 'source-never-arrived' };
    }
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
    const maxAttempts = 4;
    // An attempt that runs past this before it FAILS is a wedged/timed-out
    // RENDER, not a transient reach blip. The synchronous worker holds the HTTP
    // connection open for the whole render, so a genuinely unreachable Modal
    // fails in seconds (connection refused, router 502 cold-start race), while a
    // wedged GPU job only fails when Modal SIGKILLs it at its ~900s function
    // ceiling. Re-firing the latter just burns ANOTHER ~900s — the 15min→31min
    // long-hang compound seen in prod. So a slow failure is TERMINAL here
    // (capped at one ceiling) instead of silently re-run. NOTE: the wedge itself
    // is an UNCODED worker SIGKILL — the backend owns the real fix (v352 +
    // per-stage worker deadlines, which surface a coded error fast through the
    // worker-error path above). This cap only stops the dispatch layer from
    // COMPOUNDING the wait; it is not the root fix. A wedged render still
    // terminalizes via the outer catch's transient DISPATCH_UNREACHABLE line.
    const SLOW_FAIL_MS = 120_000;
    // Hard backstop above Modal's 900s function ceiling. A legit long render
    // (≤900s) always completes and returns 2xx before this fires; it only trips
    // when the connection dangles (function gone, socket never closed) so the
    // user can't be walled forever waiting on a corpse.
    const FETCH_TIMEOUT_MS = 960_000;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = Date.now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
      let failedSlow = false;
      try {
        const r = await fetch(modalEndpointUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ctl.signal,
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
        // 5xx / 408 / 429 → retriable ONLY if it failed fast (a real reach /
        // platform blip). A slow 5xx is a wedged render — see SLOW_FAIL_MS.
        lastErr = new Error(`Modal HTTP ${r.status}`);
        failedSlow = Date.now() - startedAt > SLOW_FAIL_MS;
        const body = await r.text().catch(() => '');
        console.warn(`[dispatch] Modal ${r.status} for ${jobId} (attempt ${attempt}/${maxAttempts}, ${Math.round((Date.now() - startedAt) / 1000)}s): ${body.slice(0, 200)}`);
      } catch (e) {
        // Network-level failure OR our backstop abort. An abort is slow by
        // definition; any other throw is slow iff it took a while (a socket that
        // died mid-render, not a fast unreachable-service error).
        lastErr = e;
        failedSlow = e?.name === 'AbortError' || Date.now() - startedAt > SLOW_FAIL_MS;
        console.warn(`[dispatch] Modal fetch threw for ${jobId} (attempt ${attempt}/${maxAttempts}, ${Math.round((Date.now() - startedAt) / 1000)}s): ${e.message}`);
      } finally {
        clearTimeout(timer);
      }
      // A slow failure is a wedged render: do NOT re-fire (it would wedge for
      // another ~900s — the compound). Terminal; the outer catch surfaces the
      // transient DISPATCH_UNREACHABLE line + refund, same as any dispatch throw.
      if (failedSlow) {
        throw new Error(`Modal render timed out for ${jobId} after ${Math.round((Date.now() - startedAt) / 1000)}s`);
      }
      if (attempt < maxAttempts) {
        // COLD-START-RACE WIDENING (Zac 2026-07-26; RE-SIZED 2026-08-01): the
        // render worker scales to zero at low traffic; a dispatch to a cold worker
        // gets a FAST router 502 during the cold-start race. The attempts must SPAN
        // the cold-start window so the last one lands after the container is ready.
        // The old 0/12/34s ladder was sized against a ~15-30s July cold-start. On
        // 2026-08-01 04:32Z a dispatch EXHAUSTED all 3 attempts (34s) and still
        // 502'd ("trouble reaching the render service") — proof the cold-start now
        // exceeds 34s (the image has grown since July; the iOS prewarm that used to
        // hide it is frozen). Added a 4th attempt so the ladder is ~0/12/34/75s,
        // covering a cold-start up to ~75s with margin. NOTE: the exact boot time
        // is a Modal-side metric (dashboard / prewarm.result logs), not in the DB;
        // 75s is sized past the OBSERVED >34s failure, to be trimmed once backend
        // reports the real number. Idempotent (client_job_id dedupes any re-fire);
        // a slow/wedged render is already terminal via failedSlow, so this never
        // prolongs a real render hang — only fast cold-start 502s reach the wait.
        const backoffMs = attempt === 1 ? 12000 : attempt === 2 ? 22000 : 41000;
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
        noteDispatchFailure(res.status, jobId, userId);
        // CAP-DETECTION: a 404 at the dispatch layer is the Modal spend-cap /
        // stopped-app signature — record it diagnosably in the DB instead of a
        // generic "Modal error" (the client sanitizes this to a friendly line).
        const errMessage = res.status === 404
          ? 'RENDER_UNAVAILABLE: Modal 404 (render service down — check Modal spend cap)'
          : `Modal error: ${res.status}`;
        const { data: wonRows } = await supabaseAdmin
          .from('video_jobs')
          .update({
            status: 'failed',
            error_message: errMessage,
            // CODED ENVELOPE (2026-08-02): this write used to carry no `result`
            // at all, which is why the dispatch-reach class was invisible to
            // every error_code count.
            result: dispatchFailureResult({
              httpStatus: res.status,
              userMessage: dispatchErrorMessage(),
              detail: `${errMessage}${text ? ` :: ${String(text).slice(0, 200)}` : ''}`,
            }),
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId)
          .not('status', 'in', TERMINAL_SQL_LIST)
          .select('id');
        await refundJobInline(jobId, 'modal-non-ok');
        if (Array.isArray(wonRows) && wonRows.length > 0) {
          // Lifecycle push at the settle-once terminal write (flag + claim
          // gated inside; fire-and-forget).
          sendLifecyclePush(supabaseAdmin, {
            jobId, userId, kind: 'failed', errorMessage: errMessage, refunded: true,
          }).catch(() => {});
        }
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

      noteDispatchSuccess();  // dispatch reached Modal with a 2xx — clears the outage window

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
      let _respawned = false;
      if (result && result.spawned === true && result.call_id) {
        const callId = String(result.call_id);
        // Wall-clock since the spawn — the ONLY safe basis for deciding a
        // started worker is stranded rather than still rendering.
        const _dispatchT0 = Date.now();
        console.log(`[dispatch] ${jobId} spawned as ${callId} — awaiting completion (callback primary, fallback armed)`);
        // PERSIST THE HANDLE (Zac 2026-08-03). callId lived only in this closure,
        // so the reaper — a separate sweep that reads DB rows — could not see it.
        // That is exactly backwards: the stalls worth cancelling are the ones that
        // OUTLIVE this process (a deploy or restart drops the in-process pending
        // map, which is the projection-failure class), and for those the handle
        // was gone entirely. Written to progress_step, a free-text column the
        // worker does not own, so no migration and nothing to clobber.
        // Best-effort: a failed write must never block the dispatch.
        try {
          await supabaseAdmin
            .from('video_jobs')
            .update({ progress_step: `modal_call:${callId}` })
            .eq('id', jobId);
        } catch (err) {
          console.warn(`[dispatch] ${jobId} could not persist call_id (reaper cannot cancel it): ${err?.message || err}`);
        }
        result = await registerPendingModalJob(callId, {
          timeoutMs: 15 * 60 * 1000, // 900s pipeline + generous margin before the fallback
          onTimeoutCheck: () => resolveSpawnedCompletionFallback({ jobId, callId }),
        });
        // RE-SPAWN ONCE (Zac 2026-08-02, dispatch-loss mitigation): a spawn
        // ACCEPTED but whose worker NEVER STARTED (the fallback timed out with an
        // EMPTY worker envelope) has lost nothing, so a single fresh spawn saves
        // the "worker never runs" class. ⚠️ GUARD: a job that RENDERED but whose
        // completion write was lost/delayed looks IDENTICAL to never-started
        // (476fe663 lost both delivery paths, recovered from Supabase). So BEFORE
        // re-spawning, re-read Supabase once more (a fresh completion fallback =
        // the reconciler's find+project). respawnDecision turns (initial, recheck)
        // into project | respawn | as_is so we NEVER render+pay+deliver twice.
        if (!_respawned && workerNeverStarted(result)) {
          const recheck = await resolveSpawnedCompletionFallback({ jobId, callId });
          const decision = respawnDecision(result, recheck, Date.now() - _dispatchT0);
          if (decision === 'project') {
            console.warn(`[dispatch] ${jobId} completion EXISTED in Supabase on re-check — PROJECTING it, NOT re-spawning (rendered-but-write-lost; never pay twice)`);
            result = recheck;
          } else if (decision === 'respawn') {
            _respawned = true;
            console.warn(`[dispatch] ${jobId} spawn ${callId} never started a worker (empty on re-check too) — RE-SPAWNING once`);
            try {
              const res2 = await fetchModalWithRetry();
              const r2 = await res2.json().catch(() => ({}));
              if (r2 && r2.spawned === true && r2.call_id) {
                const callId2 = String(r2.call_id);
                console.log(`[dispatch] ${jobId} re-spawned as ${callId2} — awaiting completion`);
                result = await registerPendingModalJob(callId2, {
                  timeoutMs: 15 * 60 * 1000,
                  onTimeoutCheck: () => resolveSpawnedCompletionFallback({ jobId, callId: callId2 }),
                });
              } else if (r2 && r2.spawned !== true) {
                result = r2; // synchronous worker returned the result inline
              }
            } catch (e2) {
              console.error(`[dispatch] ${jobId} re-spawn failed (${e2 && e2.message}) — terminalizing the original`);
            }
          } else {
            // 'as_is' — the re-check surfaced worker output (a wedged render that
            // ran): carry its honest coded envelope, never re-spawn.
            result = recheck || result;
          }
        }
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
        // Funnel: every classified render failure, plus the specific content-
        // rejection signals (the non-talking-head demand signal Zac wants to
        // see, and the upload-quality failures) as their own events.
        // SOFT REJECT (2026-07-31): a tier-concurrency limit is "wait your turn",
        // NOT a failed generation — funnel it distinctly so it never inflates the
        // render-failure rate/census. Quota stays net-zero (the failure-refund law
        // returns the claimed slot) and iOS still pops the wait/upgrade paywall on
        // the error_code + user_message below. (A fuller soft outcome that also
        // suppresses the failed-status push + job-history row needs a valid_status
        // DB decision — flagged for Zac, deliberately not done here.)
        if (errCode === 'tier_concurrency_limit') {
          funnelEvent(userId, 'concurrency_soft_reject', { job_id: jobId });
        } else {
          funnelEvent(userId, 'render_failed', { job_id: jobId, error_code: errCode });
        }
        const rejEvent = rejectionEventFor(errCode);
        if (rejEvent) funnelEvent(userId, rejEvent, { job_id: jobId, error_code: errCode });
        // RENDER_TOO_SHORT: the server's canonical copy (failure-copy.js) wins
        // over the worker's inline string — one source of truth for the words a
        // user reads, refund confirmation included.
        // Server-canonical rejection copy wins over the worker's inline string
        // (one source of truth for the words users read), then the worker's own
        // message for any code we didn't map, then the generic our-fault line —
        // so the user NEVER sees a bare error code or an empty reason.
        const userMsg = rejectionCopy(errCode)
          || (typeof result.user_message === 'string' && result.user_message.trim()
            ? result.user_message
            : null)
          || coreErrorMessage();
        // Behavioral flags from the worker's classified envelope. These drive
        // the iOS failure screen: requires_new_video → "trim and resubmit" flow
        // (e.g. CLIP_TOO_LONG), requires_vibe_change, retryable. Pass them
        // through verbatim so the app never has to re-classify.
        const requiresNewVideo = result.requires_new_video === true;
        const requiresVibeChange = result.requires_vibe_change === true;
        const retryable = result.retryable === true;
        console.error(`[dispatch] Pipeline error for ${jobId}: ${errCode}${userMsg ? ' — ' + userMsg : ''}`);
        const { data: failWonRows } = await supabaseAdmin
          .from('video_jobs')
          .update({
            status: 'failed',
            error_message: userMsg || errCode,
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId)
          .not('status', 'in', TERMINAL_SQL_LIST)
          .select('id');
        await refundJobInline(jobId, `worker-error:${errCode}`);
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

        // Lifecycle failure push (consolidates the 1.2.0 rider) — fires only
        // when THIS write won the terminal transition; body is the worker's
        // classified honest copy with the credit line handled by the
        // chokepoint (every failed row refunds — refund-leg law). Flag +
        // per-job claim gated inside; fire-and-forget.
        if (Array.isArray(failWonRows) && failWonRows.length > 0) {
          sendLifecyclePush(supabaseAdmin, {
            jobId, userId, kind: 'failed', errorMessage: userMsg || null, refunded: true,
          }).catch(() => {});
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
      //    .select('id'): winning THIS transition (the fast-path /api/modal-progress
      //    complete event usually got there first and owns the lifecycle push)
      //    makes the tail the push owner — the fallback/double-loss recoveries
      //    land here, so completion pushes survive even lost deliveries.
      const { data: completeWonRows } = await supabaseAdmin
        .from('video_jobs')
        .update({ status: 'completed' })
        .eq('id', jobId)
        .not('status', 'in', TERMINAL_SQL_LIST)
        .select('id');

      // Funnel: the render finished successfully — the activation payoff.
      funnelEvent(userId, 'render_completed', { job_id: jobId, mode: mode || 'render' });
      noteRenderRecovery(); // if we'd seen the outage, this first completion pages "renders are back"

      // COMPLETION EMAIL (flagged, token-free recovery path). Fires ONLY here on a
      // real completion — never on any failure branch — behind
      // COMPLETION_EMAIL_ENABLED. Idempotent per job inside sendCompletionEmail;
      // fire-and-forget so it never touches the render path. During the cap
      // outage there are zero completions, so this is structurally unreachable
      // then (double-safe: no completion → no email).
      if (process.env.COMPLETION_EMAIL_ENABLED === '1' && userId) {
        Promise.resolve(sendCompletionEmail(supabaseAdmin, { userId, jobId }))
          .catch((e) => console.warn('[completion-email] send failed (non-fatal):', e && e.message));
      }

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

        // Visible alert — the lifecycle chokepoint (flag + per-job claim
        // gated inside). Fires only when the terminal write above won; on the
        // normal path /api/modal-progress won first and already owns the push,
        // so this is the fallback-recovery sender, never a duplicate.
        if (Array.isArray(completeWonRows) && completeWonRows.length > 0) {
          sendLifecyclePush(supabaseAdmin, {
            jobId, userId, kind: 'completed', vibe: vibe || null,
          }).catch((err) => {
            console.warn(`[dispatch] Alert push failed for ${jobId}: ${err.message}`);
          });
        }
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
      // Split the class at the moment we terminalize it — see
      // workerProgressWitness. Without this the detail cannot tell a spawn that
      // never produced a container from a worker that ran and lost its
      // completion, and those need opposite fixes.
      const _witness = await workerProgressWitness(supabaseAdmin, jobId);
      console.error(`[dispatch] ${jobId} DISPATCH_UNREACHABLE verdict=${_witness.verdict || _witness.reason} `
        + `step=${_witness.current_step} progress=${_witness.progress} worker_fields=${JSON.stringify(_witness.worker_fields || [])}`);
      const { data: threwWonRows } = await supabaseAdmin
        .from('video_jobs')
        .update({
          status: 'failed',
          error_message: dispatchCopy,
          // CODED ENVELOPE (2026-08-02) — see dispatchFailureResult. httpStatus
          // is null here: the fetch never got a response (network / retries
          // exhausted), which is exactly what DISPATCH_UNREACHABLE names.
          result: dispatchFailureResult({
            httpStatus: null,
            userMessage: dispatchCopy,
            // FRONT-LOADED verdict: the durable copy must name WHICH cause,
            // because the two need opposite fixes and the row is the only
            // record that survives.
            detail: `[${_witness.verdict || _witness.reason}] step=${_witness.current_step} `
              + `progress=${_witness.progress} :: dispatch threw: `
              + `${String(err && err.message).slice(0, 160)}`,
            worker_ran: _witness.moved,
            spawn_verdict: _witness.verdict || _witness.reason,
          }),
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .not('status', 'in', TERMINAL_SQL_LIST)
        .select('id');
      await refundJobInline(jobId, 'dispatch-threw');
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
      // Lifecycle failure push (consolidates the 1.2.0 rider) — the push body
      // is the row's OWN honest copy (dispatchCopy), so the banner and the
      // failure screen say the same thing. Fires only when this write won the
      // terminal transition; flag + per-job claim gated inside.
      if (Array.isArray(threwWonRows) && threwWonRows.length > 0) {
        sendLifecyclePush(supabaseAdmin, {
          jobId, userId, kind: 'failed', errorMessage: dispatchCopy, refunded: true,
        }).catch((pushErr) => {
          console.warn(`[dispatch] Failure push failed for ${jobId}: ${pushErr.message}`);
        });
      }
    }
  })();

  return { jobId, publicUrl };
}

module.exports = {
  dispatchJobToModal, registerPrewarm,
  awaitPrewarmHint, markJobFailed, NO_SPEECH_COPY, NO_SPEECH_MIC_COPY,
  // Exported for lib/__smoke_result_passthrough.js — the recovery path is
  // where result keys were being silently dropped, so it must be testable.
  resolveSpawnedCompletionFallback, carryWorkerResult, workerNeverStarted, respawnDecision, DISPATCH_TRANSPORT_KEYS,
  dispatchFailureResult, DISPATCH_ERROR_CODES,
  workerProgressWitness, workerStrandedNoTerminal, WORKER_FN_TIMEOUT_MS,
};

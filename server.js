const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { supabaseAdmin } = require('./services/supabase-admin');
const { getFeatureUsageCount, incrementFeatureUsage } = require('./services/featureUsage');
const {
  isUserPro: isProfilePro,
  entitlementTier,
  tierFromEntitlement,
  unknownPeriodPaid,
  proEntitlementFromV2ActiveList,
  PRO_ENTITLEMENT_ID,
  revenuecatWebhookAuthMatches,
} = require('./lib/entitlement');
const { capabilities } = require('./lib/tier-capabilities');
const { resolveEnforce, effectiveTier, clientWallCapable, clientFreemium, wallEnabled, gateDecision, uploadDecision } = require('./lib/wall-enforcement');
const { wallRequiredMessage, sourceMissingMessage } = require('./lib/failure-copy');
const { phCapture, phShutdown } = require('./lib/posthog-sink');
const { ENABLE_DESIGN_LAB } = require('./config/flags');
const { triggerPreAnalysis } = require('./lib/video-processor/pre-analyze');
const s3 = require('./services/s3');
const { dispatchJobToModal, registerPrewarm, awaitPrewarmHint, markJobFailed, NO_SPEECH_COPY, workerAuthField } = require('./lib/video-processor/dispatch-to-modal');
const { findDeadSourceJob } = require('./lib/source-presence');
const apiLedger = require('./lib/api-outcome-ledger');
const { makeJob404Guard } = require('./lib/job404-guard');
const { isTerminalJobStatus, classifyLostTransition } = require('./lib/job-status');

const { settlePendingModalJob } = require('./lib/video-processor/modal-webhook');
const { sendOwnerAlert } = require('./services/pushNotifier');
const { postAgentAlert } = require('./lib/agent-alert');
const { isKnownOutageActive, maintenanceUserMessage } = require('./lib/known-outage');
const { checkSpendGuards, checkRejectionAttemptCap } = require('./lib/spend-guard');

// Public result page for the completion-email deep link. `data` = { videoUrl,
// thumbnailUrl } for a COMPLETED job, or null for anything else (missing /
// processing / failed) → one neutral page that never confirms a job's state.
// Self-contained (inline CSS), mobile-first (recipients open on a phone), no PII.
const APP_STORE_URL = 'https://apps.apple.com/app/id6762497454';

// Acquisition landing (/get). The store CTA carries data-store-link + a real
// href, so normal browsers navigate straight to the App Store; inside a Meta/
// TikTok in-app browser the escape module intercepts the tap and breaks out to
// Safari (falling back to instructions). Self-contained, mobile-first, no PII.
function renderGetLanding() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="robots" content="noindex">
  <title>Get Promptly</title>
  <style>
    :root{color-scheme:dark}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;
      padding:32px 24px calc(32px + env(safe-area-inset-bottom));text-align:center;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
      background:#0e0e10;color:#f5f4f2}
    .wrap{width:100%;max-width:420px}
    .brand{font-weight:800;font-size:17px;letter-spacing:.3px;color:#C8A95E;margin-bottom:28px}
    h1{font-size:30px;line-height:1.2;font-weight:800;letter-spacing:-.02em;margin:0 0 14px}
    p{font-size:17px;line-height:1.55;color:#a8a8ad;margin:0 0 32px}
    .cta{display:block;width:100%;padding:17px 20px;border-radius:999px;text-decoration:none;
      background:#C8A95E;color:#1a1a1a;font-weight:800;font-size:17px}
    .note{margin-top:16px;font-size:13px;color:#77777e}
  </style></head><body>
  <div class="wrap">
    <div class="brand">Promptly</div>
    <h1>Make a scroll-stopping video in minutes.</h1>
    <p>Upload a clip of yourself talking, tell Promptly the vibe, and get a captioned, edited short back — no timeline, no editing.</p>
    <a class="cta" href="${APP_STORE_URL}" data-store-link>Download on the App Store</a>
    <div class="note">Free to start — one video edit every day.</div>
  </div>
  <script src="/js/inapp-browser-escape.js"></script>
  </body></html>`;
}

// Server-side funnel event → BOTH sinks (analytics_events + PostHog), keyed by
// the Supabase user id (the same distinct_id the client identify()s as, so the
// funnel joins across the client/server seam). Fire-and-forget; never blocks the
// response. Used to light up the signup→upload region from SERVER-visible signals
// while the client-side instrumentation waits on an App Store release (build 223).
function serverFunnel(userId, event, props = {}) {
  if (!userId || !supabaseAdmin) return;
  try {
    supabaseAdmin.from('analytics_events').insert({
      event, anon_user_id: userId, user_id: userId, platform: 'server', app_version: 'server', props,
    }).then(({ error }) => { if (error) console.warn(`[funnel] ${event} mirror failed:`, error.message); });
    phCapture(userId, event, props);
  } catch (e) { console.warn(`[funnel] ${event} failed:`, e && e.message); }
}

// Warm the render dispatcher on REAL upload intent (server-side, no client
// release). The Modal warmup() endpoint (boot-only, no source) provisions the
// cpu=8 dispatcher so the run_job dispatch ~10-90s later hits a WARM container
// instead of racing a cold-start 502 ("trouble reaching the render service").
// This is the exact signal warmup() was DESIGNED for ("fired at upload-start");
// it replaces the frozen blanket client prewarm for cold-start reachability at
// ~2% of the volume — real uploads only, not editor-open/composer-focus, and not
// the 63% who never render. Fire-and-forget; a warm failure never touches the
// upload. Kill switch: WARM_ON_INTENT=0.
function warmDispatcherOnIntent() {
  if (process.env.WARM_ON_INTENT === '0') return;
  const modalRunUrl = process.env.MODAL_ENDPOINT_URL || '';
  const warmUrl = process.env.MODAL_WARMUP_URL || modalRunUrl.replace(/-run-job(\.|$)/, '-warmup$1');
  if (!warmUrl) return;
  Promise.resolve(fetch(warmUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000),
  })).then(() => {}, (e) => console.warn('[warm-on-intent] warmup failed (non-fatal):', e && e.message));
}

function renderResultPage(data) {
  const esc = (s) => String(s || '').replace(/[<>"&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' }[c]));
  const body = data
    ? `<div class="card">
        <div class="brand">Promptly</div>
        <h1>Your video is ready 🎬</h1>
        <video controls playsinline preload="metadata" src="${esc(data.videoUrl)}"></video>
        <a class="btn primary" href="${esc(data.videoUrl)}" download>Download video</a>
        <a class="btn ghost" href="${APP_STORE_URL}">Open Promptly to edit or make another</a>
      </div>`
    : `<div class="card">
        <div class="brand">Promptly</div>
        <h1>This video isn't available</h1>
        <p class="muted">The link may be old, or the video isn't ready yet. Open Promptly to find your videos.</p>
        <a class="btn primary" href="${APP_STORE_URL}">Open Promptly</a>
      </div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Your Promptly video</title>
  <style>
    :root{color-scheme:light dark}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#0e0e10;color:#f5f4f2}
    .card{width:100%;max-width:480px;background:#17171a;border:1px solid #26262b;border-radius:20px;padding:28px;text-align:center}
    .brand{font-weight:800;font-size:15px;letter-spacing:.3px;color:#C8A95E;margin-bottom:14px}
    h1{font-size:22px;font-weight:700;line-height:1.3;margin:0 0 18px}
    video{width:100%;border-radius:14px;background:#000;margin-bottom:18px;max-height:70vh}
    .muted{color:#a0a0a8;font-size:15px;line-height:1.6;margin:0 0 20px}
    .btn{display:block;width:100%;padding:14px 20px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px;margin-top:10px}
    .primary{background:#C8A95E;color:#1a1a1a}
    .ghost{background:transparent;color:#f5f4f2;border:1px solid #3a3a42}
  </style></head><body>${body}</body></html>`;
}
const { sendLifecyclePush, buildCompletedAlert, buildFailedAlert, OWNER_USER_ID: LIFECYCLE_OWNER_USER_ID } = require('./lib/lifecycle-push');

// BUILD-GATE RECEIPT (TRUTH→DELIVERY request 2026-08-11, reports/REQUEST_
// DELIVERY_GATE_RECEIPT.md): validate_deploy.js writes .gate_receipt.json when
// the 20-smoke gate passes during the Render build. Read ONCE at boot —
// boot-time truth is the point (the receipt describes THIS build) — and served
// on /api/health as `gate`. null = the file is absent = the build did not run
// the gate (the fact nobody could establish from outside). Read failures never
// affect boot.
const BOOT_GATE_RECEIPT = require('./lib/gate-receipt').readGateReceipt(__dirname);

// DAILY SCOREBOARD, IN-PROCESS (2026-08-12). Was a separate render.yaml cron
// service whose existence has been [UNKNOWN] since it was added — the same
// blueprint-sync question that turned out to be REAL for the build gate. Moved
// into the process that is provably running. Idempotent: the scoreboard upserts
// one row per UTC day, so catch-up on every boot cannot double-count. Started
// below, after supabaseAdmin exists.
// npm postinstall marker — read at boot beside the receipt. See
// scripts/build-marker.js: together they say WHICH half of the build ran.
const BOOT_BUILD_MARKER = require('./lib/gate-receipt').readBuildMarker(__dirname);

// ARMED-BUT-UNVERIFIED alarm (2026-08-11). Say it once, loudly, at boot — hours
// before the first free export rather than after it. The predicate is a pure
// function in lib/gate-receipt so the smoke proves it actually fires; a warning
// nobody has watched fire is not a warning. Logs only, never blocks boot.
const _wmWarning = require('./lib/gate-receipt').watermarkArmingWarning(BOOT_GATE_RECEIPT);
if (_wmWarning) console.error(_wmWarning);
const {
  validateUploadRequest,
  validateSubmission,
  isSubmissionAdmin,
  isSubmissionAdminUserId,
  isValidStatus,
} = require('./lib/submissions');
const { validateFeedback } = require('./lib/feedback');
const { isAnswerSubmission, validateAnswer, canAcceptAnswer } = require('./lib/ask');
const { isJobCancellable } = require('./lib/cancel');
const { isTrivialMessage, TRIVIAL_REPLY, isStatusQuestion, statusAnswerFromJob, jobContextLine } = require('./lib/chat-router');
const { recordQuotaFailure } = require('./lib/quota-failure');

// ── CHAT MODEL: PINNED, NEVER AN ALIAS (2026-08-17) ─────────────────────────
// `gemini-flash-latest` is an ALIAS and it ROTATED UNDER US. The AI Studio usage
// panel shows 1.87K 429s on Aug 8 with ZERO of every other error class, and the
// per-model request curve runs 3.6 Flash -> 3.7 Flash -> ZERO. That is the
// signature of the alias moving onto a model with NO PROVISIONED QUOTA on this
// project: the limit is zero, so volume is irrelevant — chat runs ~0.3 req/min
// against paid-tier limits in the thousands and still 429s on 100% of requests.
//
// A pin is not a preference here, it is the difference between a model we have
// quota for and whichever model Google promoted this week. This is the same
// lesson as `supabase==2.7.4`: a floating reference resolved to something nobody
// chose, and the damage landed far from the change. The difference is that pin
// was too tight on the wrong axis; this one is tight on the right one.
//
// ENV-OVERRIDABLE so the owner can move it from the dashboard the moment the
// Rate Limit page names a model with confirmed quota — no deploy needed. The
// DEFAULT must always be an explicit version; validate_deploy fails on an alias,
// and startup logs loudly if the override reintroduces one.

// ── TRANSIENT-429 BACKOFF (2026-08-17) ──────────────────────────────────────
// MEASURED, 35-minute window: 28 upstream 429s, 100% of them the message "This
// model is currently experiencing high demand. Spikes in demand are usually
// temporary." — and 11 of them reached a USER as a 502 on a feature that had just
// come back from nine days dead. Meanwhile 7 requests SUCCEEDED for 4 users in
// the same window, which is the fact that justifies retrying: the contention is
// INTERMITTENT, not total, so a second attempt lands often enough to matter.
//
// BOUNDED ON PURPOSE. Chat is interactive. A user waiting through an exponential
// ladder feels worse than a fast honest error, so this is ONE extra attempt with
// a short fixed delay and a hard ceiling — not a generic retry policy. If the
// upstream is genuinely saturated the user still gets an answer quickly, just an
// unhappy one.
//
// IT RETRIES ONLY `transient_capacity`. A billing 429 is permanent until a human
// tops up an account: retrying it burns latency to reach the same wall, and it is
// exactly the case the classifier exists to separate. quota_exceeded and any
// unclassified shape also fall through untouched — when in doubt, do not retry.
const CHAT_RETRY_DELAY_MS = Number(process.env.CHAT_RETRY_DELAY_MS || 450);
const CHAT_RETRY_MAX_MS = 1200;   // hard ceiling on added interactive latency

async function fetchGeminiWithTransientRetry(url, init, { route, model, userId }) {
  const { parseQuotaFailure, recordRetryOutcome } = require('./lib/quota-failure');
  let res = await fetch(url, init);
  if (res.ok) return { res, retried: false, absorbed: false };

  // Read the body ONCE — a Response body cannot be consumed twice, and the
  // classifier needs it to decide whether a retry is even appropriate.
  const firstBody = await res.text().catch(() => '');

  // GATE ON CLASSIFICATION, NEVER ON STATUS CODE.
  //
  // This read `if (res.status !== 429) return` and returned BEFORE consulting the
  // classifier — so it never retried anything. MEASURED: 21 consecutive overload
  // responses carried classification=transient_capacity and http_status=503.
  // Google returns 503 UNAVAILABLE for model overload; 429 is the quota/billing
  // shape. The retry was keyed on a code the condition does not use.
  //
  // Worse, I called them "429s" all night — in reports, in commit messages, and
  // in the watcher, which PRINTED a hardcoded "429" label rather than the row's
  // actual http_status. The value was in the row the whole time. Same defect as
  // the thinking-budget log: a display asserting a constant while the data says
  // otherwise.
  //
  // The classifier already answers the only question that matters — is this
  // condition transient — and it answers it from the MESSAGE, which is why it got
  // this right when the status check did not. An overloaded upstream is retryable
  // whether it says 429, 503, or whatever appears next.
  const q = parseQuotaFailure(firstBody);
  if (!q || q.classification !== 'transient_capacity') {
    return { res, firstBody, retried: false, absorbed: false };
  }

  // Honour the upstream's own retryDelay when it gives one, clamped to the
  // ceiling. Guessing longer than the server asked for is not politeness, it is
  // latency the user pays for nothing.
  let waitMs = CHAT_RETRY_DELAY_MS;
  const rd = String((q && q.retry_delay) || '');
  const m = rd.match(/^(\d+(?:\.\d+)?)s$/);
  if (m) waitMs = Math.min(CHAT_RETRY_MAX_MS, Math.round(Number(m[1]) * 1000));
  waitMs = Math.min(waitMs, CHAT_RETRY_MAX_MS);

  console.log(`[chat-retry] ${route} transient 429 on ${model} — one retry in ${waitMs}ms`);
  await new Promise((r) => setTimeout(r, waitMs));
  const res2 = await fetch(url, init);
  // BOTH outcomes are persisted. An absorbed retry writes no failure row, so
  // without this the fix's own effect is invisible and "429s continue" cannot be
  // told apart from "the retry never ran".
  await recordRetryOutcome(supabaseAdmin, {
    route, model, absorbed: res2.ok, waitMs, userId,
  }).catch(() => {});
  if (res2.ok) return { res: res2, retried: true, absorbed: true };
  const secondBody = await res2.text().catch(() => '');
  return { res: res2, firstBody: secondBody, retried: true, absorbed: false };
}

const CHAT_MODEL = (process.env.CHAT_MODEL || 'gemini-3.6-flash').trim();
if (/-latest$|^gemini-(flash|pro)-latest$/.test(CHAT_MODEL)) {
  console.error(`[chat-model] !! CHAT_MODEL="${CHAT_MODEL}" is an ALIAS. Aliases `
    + 'rotate onto models with no provisioned quota — that is what took chat to '
    + '100% 429 with zero other error classes. Pin an explicit version.');
}
console.log(`[chat-model] pinned: ${CHAT_MODEL}`);



// [restored dep]
function normalizePlanLabel(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'paid' || raw === 'premium') return 'pro';
  return raw;
}



// ── [restored: over-deletion regression fix, from 858d19d] ──
// Module-level state the restored rate-limiter + self-heal functions depend on.
const _rateBuckets = new Map(); // `${scope}:${key}` -> { tokens, lastRefill }
const _selfHealNextAllowed = new Map();
// Caps runaway GET /api/video-jobs/:jobId poll loops on dead job_ids (see
// lib/job404-guard.js). Module-level so the negative cache survives across requests.
const _jobStatusGuard = makeJob404Guard();
const SELF_HEAL_TTL_MS = 5 * 60 * 1000;       // after a DEFINITIVE RC answer
const SELF_HEAL_ERROR_TTL_MS = 60 * 1000;     // after a TRANSIENT RC error — retry soon
const isProduction = process.env.NODE_ENV === 'production';

const REVENUECAT_API_BASE = 'https://api.revenuecat.com/v2';

function _consumeRateToken(scope, key, capacity, refillSeconds) {
  const id = `${scope}:${key}`;
  const now = Date.now();
  const refillRateMs = (refillSeconds * 1000) / capacity; // ms per single token
  const bucket = _rateBuckets.get(id) || { tokens: capacity, lastRefill: now };
  // Refill based on elapsed time
  const elapsed = now - bucket.lastRefill;
  if (elapsed > 0) {
    const refilled = elapsed / refillRateMs;
    bucket.tokens = Math.min(capacity, bucket.tokens + refilled);
    bucket.lastRefill = now;
  }
  if (bucket.tokens < 1) {
    _rateBuckets.set(id, bucket);
    const retryAfterMs = Math.ceil((1 - bucket.tokens) * refillRateMs);
    return { ok: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
  }
  bucket.tokens -= 1;
  _rateBuckets.set(id, bucket);
  return { ok: true };
}

function checkRateLimit(res, scope, key, capacity, refillSeconds) {
  const result = _consumeRateToken(scope, key, capacity, refillSeconds);
  if (result.ok) return true;
  res.setHeader('Retry-After', String(result.retryAfterSeconds));
  sendJson(res, 429, {
    error: 'Too many requests. Slow down and try again shortly.',
    retry_after_seconds: result.retryAfterSeconds,
  });
  return false;
}

async function fetchSubscriptionEntitlement(userId) {
  if (!supabaseAdmin || !userId) {
    return { status: null, plan: null, sourceTable: 'profiles', row: null };
  }
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    const err = new Error(error?.message || 'entitlements_lookup_failed');
    err.statusCode = 500;
    err.sourceTable = 'profiles';
    throw err;
  }
  if (!data) {
    return { status: null, plan: null, sourceTable: 'profiles', row: null };
  }
  // RevenueCat era: tier + pro_until are the authoritative source. We
  // still expose `plan` and `status` in the return shape because other
  // code paths read them, but they're derived from tier now.
  const plan = normalizePlanLabel(data?.tier || data?.subscription_plan || null);
  const status = isProfilePro(data) ? 'active' : null;
  return { status, plan, sourceTable: 'profiles', row: data };
}

function resolveEntitlementDecision(entitlement) {
  const row = entitlement?.row || null;
  const plan = entitlement?.plan || null;
  const status = entitlement?.status || null;
  const isPro = isProfilePro(row);
  if (isPro) {
    return { isPro: true, reason: 'IS_USER_PRO', plan, status };
  }
  if (!row) {
    return { isPro: false, reason: 'NO_ENTITLEMENT_ROW', plan, status };
  }
  return { isPro: false, reason: 'TIER_NOT_PRO', plan, status };
}

function _selfHealDue(userId) {
  return Date.now() >= (_selfHealNextAllowed.get(userId) || 0);
}

function _markSelfHeal(userId, isError) {
  _selfHealNextAllowed.set(userId, Date.now() + (isError ? SELF_HEAL_ERROR_TTL_MS : SELF_HEAL_TTL_MS));
  if (_selfHealNextAllowed.size > 5000) {
    const now = Date.now();
    for (const [k, v] of _selfHealNextAllowed) if (v < now) _selfHealNextAllowed.delete(k);
  }
}

function _hasSubscriptionHistory(row) {
  if (!row) return false;
  if (row.rc_app_user_id) return true;
  if (row.pro_until) return true;
  const tier = String(row.tier || '').toLowerCase().trim();
  return tier === 'pro' || tier === 'teams' || tier === 'premium';
}

// True when enforcement could actually deny THIS request, so the extra RC rescue
// in assertProEntitled is worth doing (a zero-DB-signal granted/comped Pro must
// never be limited). Two cases:
//   - a FREEMIUM (1.3.0+) client — freemium is ALWAYS enforced for it, so the RC
//     rescue must ALWAYS run or a comped-pro on 1.3.0 would hit free-tier caps;
//   - the legacy knob-gated wall for a wall-capable (1.2.0) client with the knob
//     on (which stays off — so this term is inert today).
// Grant-only + per-user throttled, so a genuinely-free user costs at most one
// throttled RC read that 404s fast. A non-freemium client on the knob-off path
// pays nothing (both terms false).
function wallForceRcCheck(req) {
  const headers = (req && req.headers) || {};
  return clientFreemium(headers) || (wallEnabled() && clientWallCapable(headers));
}

// NO_SPEECH pre-dispatch gate (2026-07-23). The prewarm transcribes the source
// once at upload and caches it; the worker loads that cache and never re-
// transcribes (no double Deepgram cost). Its word_count lets us reject a 0-word
// (speechless) clip BEFORE spending 20-40s of GPU — the biggest single content
// rejection, previously only caught after the full render.
//
// FAIL OPEN by contract: only a CONFIRMED `word_count === 0` gates. A missing or
// unknown word_count (worker hasn't emitted it yet, prewarm didn't fire, hint
// timed out, or the resolve threw) returns { gated:false } and the caller
// dispatches exactly as today — zero regression until the worker side ships.
// Returns the resolved hint so the caller passes it to dispatchJobToModal and
// never awaits it twice. On markJobFailed failure it ALSO fails open (dispatch,
// let the worker's own gate catch it) rather than silently dropping the render.
async function preDispatchNoSpeechGate({ jobId, videoUrl, userId, pushProgressToSSE }) {
  let hint = null;
  try {
    hint = await awaitPrewarmHint(videoUrl);
  } catch (e) {
    console.warn('[no-speech-gate] hint resolve failed — fail open:', e && e.message);
    return { gated: false, hint: null };
  }
  if (hint && hint.word_count === 0) {
    try {
      await markJobFailed(jobId, { errorCode: 'NO_SPEECH', userMessage: NO_SPEECH_COPY, userId, pushProgressToSSE });
      console.log('  [no-speech-gate] 0-word clip rejected PRE-dispatch job=%s user=%s', jobId, userId);
      return { gated: true, hint };
    } catch (e) {
      console.error('[no-speech-gate] markJobFailed failed — fail open to dispatch:', e && e.message);
      return { gated: false, hint };
    }
  }
  return { gated: false, hint };
}

async function assertProEntitled(userId, opts = {}) {
  if (!supabaseAdmin) {
    const err = new Error('supabase_not_configured');
    err.statusCode = 500;
    throw err;
  }
  const entitlement = await fetchSubscriptionEntitlement(userId);
  const decision = resolveEntitlementDecision(entitlement);
  if (decision.isPro) {
    // `row` rides on every return so the wall gates can compute the tier from
    // the SAME read that decided isPro — tierFromEntitlement(entitlement) needs
    // it, and a missing row must never make a Pro user read as tier 'none'.
    return { ...decision, row: entitlement.row || null, sourceTable: entitlement.sourceTable };
  }

  // SELF-HEAL — the guarantee that a paying user is NEVER denied, even if the
  // webhook was missed, delayed, or (as happened) silently 401'd. The DB says
  // "not Pro", but RevenueCat is the source of truth. If this user has any
  // subscription history, verify against RC (grant-only — it can only upgrade,
  // never wrongly revoke) before returning a denial. Throttled per user so a
  // genuinely-free ex-subscriber can't hammer RC, and skipped entirely for
  // never-subscribed users so the common free/Pro paths stay a single DB read.
  // COMPED-PRO EXEMPTION (Zac 2026-07-21): a user granted Pro via the
  // RevenueCat dashboard "Grant Entitlement" may leave NO DB fingerprint
  // (no rc_app_user_id / pro_until / tier=pro) if the grant fired no webhook.
  // Then _hasSubscriptionHistory is false and this self-heal is skipped — RC is
  // never asked — and under enforcement the granted-pro would hit the 403 wall,
  // even though reconcile keys off the userId as the RC customer id and RC WOULD
  // report the grant. So when the wall could actually deny (opts.forceRcCheck,
  // set only for wall-capable clients with the knob on), force the RC check even
  // for a zero-history row. Grant-only + throttled: a genuinely-free user costs
  // at most one throttled RC read that 404s fast, and NEVER on the knob-off path.
  if ((_hasSubscriptionHistory(entitlement.row) || opts.forceRcCheck === true) && _selfHealDue(userId)) {
    try {
      const healed = await reconcileEntitlementFromRevenueCat(userId);
      if (healed && healed.isPro) {
        // Definitive POSITIVE: we granted + persisted pro_until, so the next
        // read short-circuits before self-heal. Full-window throttle is fine.
        _markSelfHeal(userId, false);
        console.log('[entitlement] self-heal granted Pro from RevenueCat', { userId });
        return { isPro: true, reason: 'RC_SELF_HEAL', plan: decision.plan, status: 'active', row: entitlement.row || null, sourceTable: entitlement.sourceTable };
      }
      // RC says NOT active — but for a user WITH subscription history this is
      // NOT a definitive negative right after a conversion/renewal. RC's REST
      // active_entitlements view is eventually-consistent and can briefly lag
      // Apple's renewal while the RENEWAL webhook is still in flight. The full
      // 5-min throttle here would suppress the self-heal backstop for the exact
      // window the webhook is most likely delayed — gating a paying, just-
      // converted user to free-tier limits (402s, 3/day cap, non-Lumen). Use
      // the SHORT (60s) throttle so the backstop re-checks RC within ~60s.
      // Grant-only, so the extra checks never wrongly revoke; the only cost is
      // a few more RC reads for a genuinely-lapsed ex-subscriber, bounded to
      // ~1/min and only while they keep hitting a Pro gate.
      _markSelfHeal(userId, true);
    } catch (e) {
      // Transient RC error/outage: short throttle so a paying user retries
      // within ~60s instead of being locked out for the full window, while
      // still bounding calls during an outage. Grant-only → never wrongly
      // revokes; we just couldn't upgrade this instant.
      _markSelfHeal(userId, true);
      console.warn('[entitlement] self-heal reconcile failed (non-fatal)', { userId, error: e?.message });
    }
  }
  return { ...decision, row: entitlement.row || null, sourceTable: entitlement.sourceTable };
}

/**
 * Lean wall decision for endpoints that had NO entitlement read before the wall
 * (upload presigns, GPU prewarm). Called when enforcement is live — the knob is
 * on OR the caller is a freemium (1.3.0+) client; a legacy request that is
 * neither short-circuits at the call site, so today's 1.2.0 paths gain zero reads.
 *
 * Reads the profile row directly, escalates through assertProEntitled (grant-only,
 * throttled) before denying so a paying/comped user is never wrongly capped, and
 * then applies the ACCOUNT-GLOBAL concurrency cap (1 free / 10 pro in flight).
 */
// ACCOUNT-GLOBAL in-flight video count: how many of THIS user's videos are
// queued or processing right NOW, across every chat/session (keyed on user_id,
// never on chat_id). This single definition is the one both the upload doors
// (leanWallDecision) and the render door use, so "1 video at a time" means the
// same thing whether the 2nd video is started in the same chat or a new one.
async function inFlightJobCount(userId) {
  if (!supabaseAdmin) return 0;
  // §4: exclude demo rows so an in-flight demo never blocks the user's own render.
  const { count, error } = await supabaseAdmin
    .from('video_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('demo', false)
    .in('status', ['queued', 'processing']);
  if (error) { const e = new Error(error.message); e.code = 'pending_check_failed'; throw e; }
  return count || 0;
}

async function leanWallDecision(userId, req, { count = 1 } = {}) {
  let row = null;
  if (supabaseAdmin) {
    const { data } = await supabaseAdmin
      .from('profiles')
      .select('tier, comp_pro, pro_until, rc_period_type, rc_app_user_id, created_at')
      .eq('id', userId)
      .maybeSingle();
    row = data || null;
  }
  let tier = entitlementTier(row || {});
  const enforce = resolveEnforce({
    headers: req.headers,
    accountCreatedAt: (row || {}).created_at,
  });

  // Per-request upload-size decision (files in THIS request vs the tier cap).
  let dec = uploadDecision({ tier, count, enforce });

  // Resolve the AUTHORITATIVE entitlement before enforcing the concurrency cap —
  // a zero-DB-signal comped/granted Pro must read as paid (cap 10), never be
  // capped at 1. forceRcCheck fires for freemium clients, mirroring the render
  // door's never-deny-a-payer rule. Pay for it only when actually enforcing (or
  // the per-request decision already denied).
  if (enforce || !dec.allow) {
    const healed = await assertProEntitled(userId, { forceRcCheck: wallForceRcCheck(req) });
    tier = tierFromEntitlement(healed);
    dec = uploadDecision({ tier, count, enforce });
  }
  if (!dec.allow) return { ...dec, tier };

  // ACCOUNT-GLOBAL concurrency — the loophole fix. A free user gets 1 video in
  // flight at a time, a Pro/comped-pro 10, counted across ALL chats/sessions.
  // The iOS pending-tile cap is per-chat, so a free user could open a new chat
  // and start a 2nd upload; this denies that 2nd concurrent UPLOAD here (before
  // any S3/pre-analysis spend) with the upgrade paywall (402). Only when
  // enforcing (freemium clients); legacy/1.2.0 requests never reach this branch.
  if (enforce) {
    const cap = capabilities(effectiveTier(tier, enforce)).uploadMax; // 1 free / 10 pro
    let inFlight;
    try {
      inFlight = await inFlightJobCount(userId);
    } catch (e) {
      console.error('  [concurrency] in-flight count failed, refusing action', { userId, error: e.message });
      return { allow: false, route: null, status: 503, tier, error: 'pending_check_failed' };
    }
    if (inFlight >= cap) {
      const proC = cap >= 10;
      console.log('  [paywall] 402 concurrency_limit_reached (upload) userId=%s inFlight=%d cap=%d', userId, inFlight, cap);
      return {
        allow: false, route: 'paywall', status: 402, tier,
        error: 'concurrency_limit_reached',
        kind: proC ? 'concurrency_pro' : 'concurrency_free',
        limit: cap, max: cap,
        message: proC
          ? `You can have up to ${cap} videos in flight at once.`
          : 'Free accounts can process 1 video at a time. Upgrade to Pro for 10 in parallel.',
      };
    }
  }
  return { ...dec, tier };
}

// Format an upload-door denial from leanWallDecision consistently across all four
// doors (legacy-upload / upload-url / multipart-init / prewarm). A wall stays a
// 403 wall_required; a concurrency/upload cap is a 402 the client routes to the
// upgrade paywall (kind + message carried through so the copy is accurate); an
// in-flight-count failure is a 503 (fail closed, never silently allow).
function sendUploadDenial(res, dec, label, userId) {
  console.log('  [wall] %d %s (%s) userId=%s tier=%s', dec.status, dec.route || dec.error || '-', label, userId, dec.tier);
  if (dec.route === 'wall') {
    return sendJson(res, dec.status, { error: 'wall_required', route: 'wall', message: wallRequiredMessage() });
  }
  if (dec.status === 503) {
    return sendJson(res, 503, { error: dec.error || 'pending_check_failed' });
  }
  return sendJson(res, dec.status, {
    error: dec.error || 'upload_limit_reached',
    route: 'paywall',
    kind: dec.kind,
    limit: dec.limit,
    max: dec.max,
    message: dec.message,
  });
}


// The owner's Supabase user id is always authorized to review submissions, so
// /review works with zero env config. Additional reviewers can be added via
// SUBMISSION_ADMIN_USER_IDS (uids) or SUBMISSION_ADMIN_EMAILS (emails) —
// both comma-separated. A user id is stable and not a credential, so gating by
// the owner's id (vs. a guessable/forgeable value) is safe: only that account's
// authenticated session passes requireSupabaseUser.
const SUBMISSION_OWNER_USER_ID = 'ec702499-ca10-49e6-8850-df8f99840904';
function isAuthorizedSubmissionReviewer(user) {
  if (!user) return false;
  if (user.id && String(user.id) === SUBMISSION_OWNER_USER_ID) return true;
  if (isSubmissionAdminUserId(user.id, process.env.SUBMISSION_ADMIN_USER_IDS || '')) return true;
  if (isSubmissionAdmin(user.email, process.env.SUBMISSION_ADMIN_EMAILS || '')) return true;
  return false;
}

// SSE client registry — maps jobId -> Set of response objects
const sseClients = new Map();

// FIRST-TERMINAL-WINS. Once video_jobs.status is one of these the job is
// finished; the app must not overwrite it (that clobbers the worker's write-once
// result/phase, or resurrects a user's cancel). Canonical durable terminals only
// (ratified set): completed, failed, canceled, needs_input. The migration
// normalizes legacy 'complete'/'cancelled' away, and the worker (v193) + this app
// both speak canonical, so no both-spellings tax here.
const TERMINAL_JOB_STATUSES_SQL =
  '(completed,failed,canceled,needs_input)';

function pushProgressToSSE(jobId, data) {
  const clients = sseClients.get(jobId);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (e) {
      clients.delete(res);
    }
  }
}

// §5 progressive-playback KILL SWITCH (single source of truth). Reads the Render env
// PROGRESSIVE_PLAYBACK_ENABLED and accepts "1" OR "true"/"yes"/"on" (case-insensitive)
// — deliberately more forgiving than the siblings' strict "=1" so a plain "true" in
// Render works and it can never be silently off on a casing/value mismatch. Controls
// BOTH sides: the client's CONSUMPTION (emitted in /api/usage) AND the server's
// forwarding of supports_progressive to the worker, so a preview is never PUBLISHED
// (never billed) while the switch is off.
function progressivePlaybackEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.PROGRESSIVE_PLAYBACK_ENABLED || '').trim());
}

// PREMIUM_PIPELINE_ENABLED — the LUMEN_READY master gate (Zac 2026-07-26). Pro
// defaults to STANDARD: even an entitled Pro user whose (picker-less) client asks
// for premium gets the standard (Flare) pipeline UNLESS this backend env is set.
// Flip ON only after Lumen clears Zac's eye — Pass-2 reel approved AND one real
// emitted designed scene passes in a finished video AND the C01-C24 blind scores
// exist. No client build / App Store round trip — one env in Render. Same
// forgiving matcher as progressivePlaybackEnabled so a plain "true" works.
function premiumPipelineEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.PREMIUM_PIPELINE_ENABLED || '').trim());
}

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const OPENAI_API_KEY = CLAUDE_API_KEY || '';
const CANONICAL_HOST = process.env.CANONICAL_HOST || '';
let profileSettingsSchemaWarned = false;











if (!OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set.');
}

// Simple local data directory for brand brains
const DATA_DIR = path.join(__dirname, 'data');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(CUSTOMERS_FILE)) fs.writeFileSync(CUSTOMERS_FILE, '{}', 'utf8');
} catch (e) {
  console.error('Failed to initialize data directories:', e);
}




// Template ID resolution is handled by resolveDesignTemplateId()




function sendJson(res, statusCode, payload) {
  const headers = { 'Content-Type': 'application/json' };
  const existingRequestId = res.getHeader('x-request-id');
  if (payload && payload.requestId) headers['x-request-id'] = payload.requestId;
  else if (existingRequestId) headers['x-request-id'] = existingRequestId;
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

// Returns a user-safe error message for a client response. 4xx errors carry
// intentional, user-appropriate copy (validation / quota / auth) and pass
// through; a 5xx or any unexpected error (ReferenceError, DB message, stack)
// collapses to a generic line so internals never reach the user. The real error
// is always logged at the call site — this only governs what the CLIENT sees.
function clientSafeMessage(error, fallback = 'Something went wrong. Please try again.') {
  const status = error && error.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500 && error.message) {
    return error.message;
  }
  return fallback;
}

// ─── Rate limiter ──────────────────────────────────────────────────────────
//
// In-memory token-bucket per (key, scope). Used for cheap abuse-prevention
// on expensive endpoints (video-job creation, re-edits, refresh URLs). Not
// a hard security boundary — process restart drops state — but enough to
// catch a runaway client without dragging Modal/AWS into the open.
//
// Scopes (chosen to be generous for normal use, tight for abuse):
//   video-job-create:  10 / 15 min  per user
//   video-job-reedit:  10 / 15 min  per user
//   refresh-urls:      60 / 1 min   per user
//

function generateRequestId(prefix = 'req') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}


function logServerError(tag, err, info = {}) {
  const payload = {
    tag,
    message: err?.message || 'internal_error',
    stack: err?.stack,
    ...info,
  };
  console.error(`[Server][${tag}]`, payload);
}

function respondWithServerError(res, err, { requestId, statusCode } = {}) {
  if (res.headersSent) return;
  const isOpenAISchema = err?.code === 'OPENAI_SCHEMA_ERROR';
  const isOpenAISchemaInvalid = err?.code === 'OPENAI_SCHEMA_INVALID';
  const requestIdValue = requestId || generateRequestId('server_error');
  if (isOpenAISchemaInvalid) {
    return sendJson(res, 422, {
      error: 'OPENAI_SCHEMA_INVALID',
      requestId: requestIdValue,
      details: err?.details || null,
    });
  }
  const status = statusCode || err?.statusCode || (isOpenAISchema ? 502 : 500);
  const code = isOpenAISchema ? 'OPENAI_SCHEMA_ERROR' : err?.code || 'server_error';
  const message = isOpenAISchema ? 'openai_schema_error' : err?.message || 'internal_error';
  const payload = {
    error: {
      code,
      message,
      requestId: requestIdValue,
    },
  };
  if (isOpenAISchema) {
    const detailPayload = { ...(err?.details || {}) };
    if (err?.schemaSnippet) detailPayload.schemaSnippet = err.schemaSnippet;
    if (Object.keys(detailPayload).length) {
      payload.error.details = detailPayload;
    }
    if (!isProduction && err?.rawContent) {
      payload.error.debug = err.rawContent;
    }
  } else if (!isProduction && err?.stack) {
    payload.debugStack = err.stack;
  }
  sendJson(res, status, payload);
}



















function isUserPro(req) {
  const plan = req?.user?.plan;
  const tier = req?.user?.tier;
  if (req?.user?.isPro) return true;
  const normalizedTier = tier ? String(tier).toLowerCase().trim() : '';
  if (normalizedTier === 'pro' || normalizedTier === 'paid' || normalizedTier === 'premium') return true;
  if (plan && (plan === 'pro' || plan === 'teams')) return true;
  return false;
}







// Throttle the gate-side self-heal so a free-appearing ex-subscriber can't make
// us call RevenueCat on every request. Map<userId, nextAllowedMs>.

// The internal entitlement id ("entl…") that our 'pro' lookup_key resolves to.
// Static per project, so we memoise it for the process lifetime after the
// first successful lookup.
let _rcProEntitlementInternalId = null;

// Process-lifetime probe of the RC PROJECT itself: null = never probed (or the
// probe was transient-failed and will retry), 'ok' = project readable under the
// configured secret, 'http_NNN' = the project 404s/403s under this key — the
// misconfig signature that makes every customer lookup 404 as NO_RC_CUSTOMER.
let _rcProjectProbe = null;

/**
 * Resolve the internal id for the 'pro' lookup_key from RevenueCat. Returns
 * null on any failure — callers treat null as "accept any active entitlement",
 * which is the correct behaviour for a single-entitlement project, so a blip
 * here never blocks activation.
 */
async function resolveProEntitlementInternalId(projectId, secret) {
  if (_rcProEntitlementInternalId) return _rcProEntitlementInternalId;
  const url = `${REVENUECAT_API_BASE}/projects/${encodeURIComponent(projectId)}/entitlements`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const items = body && Array.isArray(body.items) ? body.items : [];
    const match = items.find((e) => e && e.lookup_key === PRO_ENTITLEMENT_ID);
    if (match && match.id) {
      _rcProEntitlementInternalId = match.id;
      return match.id;
    }
  } catch (e) {
    /* fall through to null */
  }
  return null;
}

/**
 * Verify a user's Pro entitlement straight from RevenueCat's REST **v2** API
 * and mirror it into profiles. This is the synchronous reconciliation path
 * that removes the webhook as a single point of failure: the iOS app calls it
 * right after a successful purchase/restore, and the webhook's TRANSFER branch
 * reuses it.
 *
 * GRANT-ONLY by design. Revocation stays with the webhook
 * (EXPIRATION/BILLING_ISSUE), so a client-triggered call can never strip Pro
 * on a transient/eventually-consistent RC read.
 *
 * Returns { ok, isPro, reason, proUntil } on a definitive answer; throws with
 * a `.statusCode` on misconfiguration / RC outage so callers can surface a
 * 5xx WITHOUT writing the DB.
 */
// True when a Supabase error is a missing-column error for an OPTIONAL RC
// profile column — rc_last_event_ms (migration 20260701_rc_event_ordering) or
// rc_environment (add-rc-environment-to-profiles). Lets the webhook + reconcile
// fall back to a plain core write so they never 500 on a not-yet-applied column;
// the ordering guard + sandbox tag each activate automatically once their column
// exists. The PGRST204/42703 codes are column-agnostic (they cover both); the
// message regex is the belt-and-braces fallback for error shapes with no code.
function rcOrderingColumnMissing(error) {
  if (!error) return false;
  if (error.code === 'PGRST204' || error.code === '42703') return true;
  const blob = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`;
  return /rc_last_event_ms|rc_environment/i.test(blob);
}

async function reconcileEntitlementFromRevenueCat(appUserId) {
  const secret = process.env.REVENUECAT_SECRET_KEY || '';
  const projectId = process.env.REVENUECAT_PROJECT_ID || '';
  if (!secret || !projectId) {
    const err = new Error('revenuecat_not_configured');
    err.statusCode = 503;
    throw err;
  }
  if (!supabaseAdmin) {
    const err = new Error('supabase_not_configured');
    err.statusCode = 500;
    throw err;
  }
  const id = String(appUserId || '').trim();
  if (!id) {
    const err = new Error('app_user_id_missing');
    err.statusCode = 400;
    throw err;
  }

  // null → accept any active entitlement (single-entitlement fallback).
  const proEntId = await resolveProEntitlementInternalId(projectId, secret);

  const url =
    `${REVENUECAT_API_BASE}/projects/${encodeURIComponent(projectId)}` +
    `/customers/${encodeURIComponent(id)}/active_entitlements`;
  let rcRes;
  try {
    rcRes = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    const err = new Error('revenuecat_unreachable');
    err.statusCode = 502;
    throw err;
  }
  // 404 = RC has never seen this customer (no purchase under this identity) —
  // OR the PROJECT id itself is wrong, which 404s identically and had every
  // /sync ever made reading NO_RC_CUSTOMER (measured 2026-08-10: 100% of
  // reconcile_result rows, including one 16s after a webhook-applied purchase).
  // Disambiguate by probing the project itself once per process: a project
  // that 404s under this key means REVENUECAT_PROJECT_ID / REVENUECAT_SECRET_KEY
  // don't belong together — a misconfig, not a customer fact. Grant behavior
  // is unchanged either way (isPro:false); only the REASON stops lying.
  if (rcRes.status === 404) {
    if (_rcProjectProbe === null) {
      try {
        const probe = await fetch(
          `${REVENUECAT_API_BASE}/projects/${encodeURIComponent(projectId)}`,
          { headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(10000) });
        _rcProjectProbe = probe.ok ? 'ok' : `http_${probe.status}`;
      } catch (_) { _rcProjectProbe = null; /* transient — re-probe next time */ }
    }
    if (_rcProjectProbe && _rcProjectProbe !== 'ok') {
      console.error(`[RevenueCat] CONFIG SUSPECT: project ${projectId ? projectId.slice(0, 8) + '…' : '(empty)'} is ${_rcProjectProbe} under this secret key — every /sync will 404. Fix REVENUECAT_PROJECT_ID (must be the V2 "proj…" id) / REVENUECAT_SECRET_KEY (a V2 sk_ key for THAT project).`);
      return { ok: true, isPro: false, reason: 'RC_CONFIG_SUSPECT', proUntil: null };
    }
    return { ok: true, isPro: false, reason: 'NO_RC_CUSTOMER', proUntil: null };
  }
  if (!rcRes.ok) {
    const err = new Error(`revenuecat_http_${rcRes.status}`);
    err.statusCode = 502;
    throw err;
  }
  const body = await rcRes.json().catch(() => null);
  const items = body && Array.isArray(body.items) ? body.items : [];
  const decision = proEntitlementFromV2ActiveList(items, proEntId, Date.now());
  if (!decision.active) {
    // Not entitled per RC. Grant-only: never downgrade here.
    return { ok: true, isPro: false, reason: 'RC_NOT_ACTIVE', proUntil: decision.proUntil };
  }

  // Mirror only the fields isUserPro() depends on. rc_product_id /
  // rc_period_type are informational and owned by the webhook — we don't null
  // them out from this path.
  const update = {
    tier: 'pro',
    pro_until: decision.proUntil,
    rc_app_user_id: id,
    // Advance the webhook ordering stamp. This reconcile reflects RC's CURRENT
    // source-of-truth (live active_entitlements), so a webhook whose event
    // predates now must not later clobber it — its eventMs < now → rejected by
    // the webhook guard. A webhook that fires AFTER this reconcile has
    // eventMs > now and correctly wins. (Column added in 20260701_rc_event_ordering.)
    rc_last_event_ms: Date.now(),
  };
  let { data, error } = await supabaseAdmin
    .from('profiles')
    .update(update)
    .eq('id', id)
    .select('id');
  if (error && rcOrderingColumnMissing(error)) {
    // Ordering column not migrated yet — retry without the stamp.
    const { rc_last_event_ms, ...plain } = update;
    ({ data, error } = await supabaseAdmin.from('profiles').update(plain).eq('id', id).select('id'));
  }
  if (error) {
    const err = new Error('profile_update_failed');
    err.statusCode = 500;
    throw err;
  }
  if (!data || data.length === 0) {
    // RC says Pro but there's no profile row for this id. Surface loudly
    // rather than reporting a phantom success.
    const err = new Error('no_profile_for_app_user_id');
    err.statusCode = 409;
    throw err;
  }
  return { ok: true, isPro: true, reason: 'GRANTED', proUntil: decision.proUntil };
}











const MAX_JSON_BODY = 1 * 1024 * 1024; // 1MB cap to prevent oversized payloads.
const MAX_UPLOAD_BODY = 520 * 1024 * 1024; // multipart overhead for 500MB file cap
const MAX_VIDEO_FILE_SIZE = 500 * 1024 * 1024;
const VIDEO_ALLOWED_TYPES = ['video/mp4', 'video/quicktime', 'video/x-msvideo'];
const VIDEO_ALLOWED_EXTENSIONS = ['.mp4', '.mov', '.avi'];

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_JSON_BODY) {
        const err = new Error('Payload too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
    });
    req.on('end', async () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        const err = new Error('Invalid JSON payload');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}


async function readRawBodyWithLimit(req, maxBytes = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > maxBytes) {
        const err = new Error('Payload too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, length)));
    req.on('error', reject);
  });
}

function parseMultipartFormData(rawBuffer, contentType = '') {
  const boundaryMatch = String(contentType).match(/boundary=(.+)$/i);
  if (!boundaryMatch) {
    const err = new Error('Invalid multipart payload: missing boundary');
    err.statusCode = 400;
    throw err;
  }

  const boundary = Buffer.from(`--${boundaryMatch[1]}`);
  const parts = [];
  let start = rawBuffer.indexOf(boundary);
  while (start !== -1) {
    const next = rawBuffer.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const part = rawBuffer.slice(start + boundary.length + 2, next - 2);
    if (part.length > 0) parts.push(part);
    start = next;
  }

  const result = { fields: {}, files: {} };
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headers = part.slice(0, headerEnd).toString('utf8');
    let body = part.slice(headerEnd + 4);
    if (body.slice(-2).toString() === '\r\n') body = body.slice(0, -2);

    const nameMatch = headers.match(/name="([^"]+)"/i);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];

    const filenameMatch = headers.match(/filename="([^"]*)"/i);
    const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);

    if (filenameMatch && filenameMatch[1]) {
      result.files[fieldName] = {
        name: filenameMatch[1],
        type: contentTypeMatch ? contentTypeMatch[1].trim() : '',
        size: body.length,
        buffer: body,
      };
    } else {
      result.fields[fieldName] = body.toString('utf8');
    }
  }

  return result;
}



// Authenticates inbound Modal worker callbacks (/api/modal-progress,
// /api/modal-webhook). When MODAL_CALLBACK_SECRET is set, the worker must echo
// it in the X-Modal-Secret header. Backward-compatible: if the secret is unset
// (worker not yet updated) this returns true — so roll the worker's header out
// FIRST, then set the env to switch enforcement on with zero downtime.
function modalCallbackAuthed(req) {
  // Trim BOTH sides. A trailing newline/space in the Render env value (extremely
  // common on dashboard paste) makes lengths differ and 401s a CORRECT secret —
  // the exact "dashboards match but the server 401s" symptom. main independently
  // shipped the same trim + fingerprint; this keeps that AND stays FAIL-CLOSED.
  const rawSecret = process.env.MODAL_CALLBACK_SECRET || '';
  const secret = rawSecret.trim();
  if (!secret) return false;   // FAIL CLOSED — a missing secret is misconfig, not open. Boot gate keeps it present.
  const got = String((req.headers && req.headers['x-modal-secret']) || '').trim();
  let ok = false;
  if (got && got.length === secret.length) {
    try { ok = crypto.timingSafeEqual(Buffer.from(got), Buffer.from(secret)); } catch { ok = false; }
  }
  if (!ok) {
    // Request-time diagnostic (Zac 2026-08-03: dashboards lied twice). Logs what
    // the RUNNING process actually holds vs what the worker sent — first/last 4 +
    // lengths only, never the whole secret. Compare to the worker's 04fa…7553:
    // different first/last4 ⇒ stale process / wrong Render service; same first/last4
    // but raw_len≠len ⇒ whitespace (now auto-trimmed). One request ends the guessing.
    const fp = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)} len=${s.length}` : '(empty)');
    console.warn(`[modal-auth] 401 mismatch: server=${fp(secret)} raw_len=${rawSecret.length} got=${fp(got)}`);
  }
  return ok;
}

// BOOT WARN (Zac 2026-08-03): the request-time trim above silently normalises a
// whitespace-tainted secret — good for uptime, but silent normalisation HIDES the
// misconfiguration. Say it ONCE at startup so the next newline-paste is visible
// rather than absorbed forever (a trailing newline 401'd every completion tonight).
(() => {
  const raw = process.env.MODAL_CALLBACK_SECRET || '';
  if (raw && raw !== raw.trim()) {
    console.error(`[modal-auth] ⚠️ BOOT: MODAL_CALLBACK_SECRET had surrounding whitespace (raw len=${raw.length} → trimmed ${raw.trim().length}) — normalising at runtime. FIX THE RENDER ENV VALUE (strip the trailing newline); the trim is a safety net, not the config.`);
  }
})();

// SSRF guard for a client-supplied media URL that the GPU worker will download.
// Rejects non-https and internal/loopback/link-local/private/metadata targets
// (e.g. 169.254.169.254 — cloud metadata) while allowing any normal public
// https host, so legitimate S3 / CloudFront / Supabase source URLs pass.
function isSafeRemoteMediaUrl(urlStr) {
  if (!urlStr) return false;
  let u;
  try { u = new URL(String(urlStr)); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  // Strip a trailing dot (FQDN root) so `169.254.169.254.` / `foo.internal.`
  // can't slip past the IP-literal regex and the suffix checks below.
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.internal') || host.endsWith('.local')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const p = host.split('.').map(Number);
    if (p.some((n) => n > 255)) return false;
    if (p[0] === 0 || p[0] === 127 || p[0] === 10 ||
        (p[0] === 169 && p[1] === 254) ||           // link-local + cloud metadata
        (p[0] === 192 && p[1] === 168) ||
        (p[0] === 172 && p[1] >= 16 && p[1] <= 31)) return false;
  }
  // IPv6 loopback / unique-local (fc00::/7) / link-local (fe80::/10)
  if (host === '[::1]' || host === '::1' ||
      host.startsWith('[fc') || host.startsWith('[fd') || host.startsWith('[fe8') ||
      host.startsWith('[fe9') || host.startsWith('[fea') || host.startsWith('[feb')) return false;
  return true;
}

// Per-key async mutex. Serializes async critical sections that share a key
// (e.g. one user's concurrent quota claims) WITHIN this process, so a burst of
// parallel requests can't each pass a check-then-write gate before any write
// lands (TOCTOU). Single-process scope; the DB advisory-lock RPC covers the
// multi-instance case. Map holds one (settled) promise per active key.
const _keyLocks = new Map();
async function withKeyLock(key, fn) {
  const prev = _keyLocks.get(key) || Promise.resolve();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const chained = prev.then(() => held);
  _keyLocks.set(key, chained);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Drop the entry once this holder is the tail, to bound map growth.
    if (_keyLocks.get(key) === chained) _keyLocks.delete(key);
  }
}

async function requireSupabaseUser(req) {
  if (!supabaseAdmin) {
    const err = new Error('Supabase admin client not configured');
    err.statusCode = 501;
    throw err;
  }
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  return data.user;
}















// NOTE: design provider template currently only binds title, subtitle, cta, logo, background_image, brand_color, and platform.









































// Generic sanitizer + parse attempts for LLM JSON array output.
// Returns { data, attempts } where data is parsed array (or object wrapped into array) and attempts is diagnostics.







































let TERMS_CSP_LOGGED = false;



// Language-level idiom groups for Tier A matching; not niche-specific.






// Language-level offer parsing to preserve numeric tokens for topic binding.






























































function toPlainString(value) {
  return String(value || '').trim();
}






















































// Contract: required fields for regenerated posts (mirrors validatePostCompleteness).



























































































































function isProfileSettingsSchemaMissing(err) {
  if (!err) return false;
  const code = String(err?.code || '');
  const msg = String(err?.message || '').toLowerCase();
  return (
    code === '42703' ||
    (msg.includes('profile_settings') && msg.includes('column') && msg.includes('does not exist'))
  );
}

// ── Daily scoreboard scheduler (see lib/scoreboard-scheduler.js) ─────────────
// hasRow is injected so the scheduler never owns a DB client. It returns null
// on ANY uncertainty (table absent, query error) and the scheduler then does
// NOT run — an unknown is not a missing row, and running blindly every boot
// would hammer the judge.
if (String(process.env.SCOREBOARD_SCHEDULER_DISABLED || '') !== '1') {
  try {
    require('./lib/scoreboard-scheduler').startScoreboardScheduler({
      hasRow: async (day) => {
        try {
          const { data, error } = await supabaseAdmin
            .from('daily_scoreboard').select('day').eq('day', day).maybeSingle();
          if (error) return null;
          return Boolean(data);
        } catch (_) {
          return null;
        }
      },
    });
  } catch (e) {
    console.error('[scoreboard] scheduler failed to start (non-fatal):', e?.message);
  }
}

const server = http.createServer((req, res) => {
  try {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  const parsed = url.parse(req.url, true);

  // Count this response's outcome once it finishes. Attaches a 'finish' listener
  // and nothing else — it cannot delay, alter or fail the response. Placed at the
  // ABSOLUTE TOP of the entry, BEFORE the /healthz early-return and every
  // res.writeHead handler, so the 22 writeHead paths, unrouted 404s, AND the
  // early health check all record their outcome — closing the blind spot the
  // instrument itself named (Zac 2026-08-03). res.on('finish') fires once per
  // response regardless of writeHead/sendJson, so one attach here covers all.
  apiLedger.attach(req, res);

  // Render health checks should be constant-time and avoid any extra work.
  if (req.method === 'GET' && parsed.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('OK');
  }

  // ── Internal: Gemini credential diagnostic (operator-only) ──────────────
  // Two key-sets, two chat 502s: dashboards and local values lie — only the
  // running process tells the truth (the MODAL_CALLBACK_SECRET saga again).
  // Auth: exact Bearer match on the service-role key (operator-only by
  // construction). Returns a FINGERPRINT of the running GEMINI_API_KEY (len +
  // first/last4, NEVER the secret) plus the EXACT verdict of a live
  // generateContent call — API_KEY_INVALID vs SERVICE_DISABLED vs a restriction
  // — visible without Render logs or a local curl. Read-only; touches nothing.
  if (parsed.pathname === '/api/internal/gemini-diag' && req.method === 'GET') {
    (async () => {
      // Both names — prod may set SUPABASE_SERVICE_KEY (the fallback), same as
      // supabase-admin.js and the proof endpoint. Checking only _ROLE_KEY 401s
      // when prod uses the other name (fail-closed on an empty svc).
      const svc = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
      const got = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
      let authed = false;
      if (svc && got.length === svc.length) {
        try { authed = crypto.timingSafeEqual(Buffer.from(got), Buffer.from(svc)); } catch { authed = false; }
      }
      if (!authed) return sendJson(res, 401, { error: 'unauthorized' });

      const raw = process.env.GEMINI_API_KEY || '';
      const key = raw.trim();
      const out = {
        key_present: !!key,
        key_len: key.length,
        key_raw_len: raw.length,               // raw_len ≠ len ⇒ whitespace in the stored value
        key_fp: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '(empty)',
        model: 'gemini-2.5-flash',
      };
      try {
        const r = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 8 } }),
          }
        );
        out.gemini_http = r.status;
        out.gemini_ok = r.status === 200;
        const j = await r.json().catch(() => ({}));
        out.gemini_error_status = j && j.error && j.error.status ? j.error.status : null;    // SERVICE_DISABLED | API_KEY_INVALID | ...
        out.gemini_error_message = String((j && j.error && j.error.message) || '').slice(0, 300) || null;
      } catch (e) {
        out.gemini_http = 0;
        out.gemini_ok = false;
        out.gemini_error_status = 'FETCH_EXCEPTION';
        out.gemini_error_message = String((e && e.message) || e).slice(0, 200);
      }
      // Which models can THIS key actually call generateContent on? List + test
      // candidates so the chat model swap is a KNOWN-good value, not a guess that
      // deprecates again (gemini-2.5-flash just did, for new-user keys).
      try {
        const lr = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
        const lj = await lr.json().catch(() => ({}));
        out.models_available = (lj.models || [])
          .filter((m) => /generateContent/.test((m.supportedGenerationMethods || []).join(',')))
          .map((m) => String(m.name || '').replace('models/', ''));
      } catch (e) { out.models_available = 'list_failed:' + String((e && e.message) || e).slice(0, 80); }
      out.candidate_test = {};
      for (const m of ['gemini-flash-latest', 'gemini-2.0-flash', 'gemini-2.5-flash-latest', 'gemini-2.0-flash-001']) {
        try {
          const cr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 8 } }),
          });
          out.candidate_test[m] = cr.status;
        } catch (e) { out.candidate_test[m] = 'exc'; }
      }
      // Chat-body test: gemini-flash-latest 200s on a minimal body but /api/chat
      // sends system_instruction + thinkingConfig. Test the full shape WITH and
      // WITHOUT thinkingConfig to pinpoint which param the newer model rejects.
      const chatBase = {
        system_instruction: { parts: [{ text: 'You are a helpful assistant.' }] },
        contents: [{ role: 'user', parts: [{ text: 'say PONG' }] }],
        generationConfig: { maxOutputTokens: 32, temperature: 0.8 },
      };
      out.chatbody_test = {};
      for (const [label, body] of [
        ['with_thinkingConfig', { ...chatBase, generationConfig: { ...chatBase.generationConfig, thinkingConfig: { thinkingBudget: 0 } } }],
        ['without_thinkingConfig', chatBase],
      ]) {
        try {
          const cr = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify(body),
          });
          const cj = await cr.json().catch(() => ({}));
          out.chatbody_test[label] = {
            http: cr.status,
            reply: cj && cj.candidates && cj.candidates[0] && cj.candidates[0].content && cj.candidates[0].content.parts ? String(cj.candidates[0].content.parts[0].text || '').slice(0, 20) : null,
            error_status: cj && cj.error && cj.error.status ? cj.error.status : null,
            error_message: String((cj && cj.error && cj.error.message) || '').slice(0, 200) || null,
          };
        } catch (e) { out.chatbody_test[label] = { http: 0, error_message: String((e && e.message) || e).slice(0, 120) }; }
      }
      // EXACT real chat body: the true system prompt (hoisted fn) + the real
      // generationConfig, so we see what /api/chat itself sends. The simplified
      // body above 200s; if THIS fails, the difference is the real system prompt.
      try {
        const realSys = promptlyChatSystemPrompt();
        out.real_system_prompt_len = realSys.length;
        const rr = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: realSys }] },
            contents: [{ role: 'user', parts: [{ text: 'say PONG' }] }],
            generationConfig: { maxOutputTokens: 2048, temperature: 0.8 },
          }),
        });
        const rj = await rr.json().catch(() => ({}));
        out.real_chat_test = {
          http: rr.status,
          finish_reason: rj && rj.candidates && rj.candidates[0] ? rj.candidates[0].finishReason : null,
          reply: rj && rj.candidates && rj.candidates[0] && rj.candidates[0].content && rj.candidates[0].content.parts ? String(rj.candidates[0].content.parts[0].text || '').slice(0, 30) : null,
          error_status: rj && rj.error && rj.error.status ? rj.error.status : null,
          error_message: String((rj && rj.error && rj.error.message) || '').slice(0, 250) || null,
          usage: rj && rj.usageMetadata ? rj.usageMetadata : null,
        };
      } catch (e) { out.real_chat_test = { http: 0, error_message: String((e && e.message) || e).slice(0, 200) }; }
      // STREAM FRAME CAPTURE: what does gemini-flash-latest actually stream? The
      // handler reads parts[0].text and gets nothing — capture the raw frame
      // shapes so the fix parses the real structure (thought parts vs text).
      try {
        const sr = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:streamGenerateContent?alt=sse', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say hello in one short sentence.' }] }], generationConfig: { maxOutputTokens: 256, temperature: 0.8 } }),
        });
        const reader = sr.body.getReader();
        const dec = new TextDecoder();
        let raw = '', frames = 0;
        const t0 = Date.now();
        while (frames < 6) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += dec.decode(value, { stream: true });
          frames++;
          if (Date.now() - t0 > 12000) break;
        }
        reader.cancel().catch(() => {});
        // Return the first data: frame's parsed shape so we see parts structure.
        const firstData = raw.split('\n\n').map((f) => f.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean)[0];
        let shape = null;
        if (firstData) { try { const p = JSON.parse(firstData.slice(6)); shape = { keys_candidate0_content: Object.keys((p.candidates && p.candidates[0] && p.candidates[0].content) || {}), parts: ((p.candidates && p.candidates[0] && p.candidates[0].content && p.candidates[0].content.parts) || []).map((x) => ({ hasText: typeof x.text === 'string', thought: !!x.thought, textSample: String(x.text || '').slice(0, 20) })) }; } catch (e) { shape = 'parse_fail'; } }
        out.stream_capture = { http: sr.status, chunks: frames, raw_head: raw.slice(0, 600), first_frame_shape: shape };
      } catch (e) { out.stream_capture = { error: String((e && e.message) || e).slice(0, 200) }; }
      return sendJson(res, 200, out);
    })();
    return;
  }

  const cspNonce = crypto.randomBytes(16).toString('base64');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Security & professionalism headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('X-Frame-Options', 'DENY');
  // Basic CSP (allow self + needed CDNs). Removed unsafe-inline for scripts; add nonce for inline JSON-LD if present.
  // Note: We still allow 'unsafe-inline' for styles until all inline styles are refactored.
  const baseCsp = `default-src 'self'; script-src 'self' 'nonce-${cspNonce}' https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com https://cdn.jsdelivr.net/npm/@supabase https://cdn.getphyllo.com https://t.contentsquare.net https://*.contentsquare.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https://usepromptly.app https://res.asset-store.com https://*.contentsquare.net https://*.contentsquare.com https://*.s3.amazonaws.com https://*.s3-ap-southeast-2.amazonaws.com https://html.tailus.io https://lh3.googleusercontent.com https://*.supabase.co https://*.supabase.com; media-src 'self' blob: https://*.s3.amazonaws.com https://*.s3-ap-southeast-2.amazonaws.com https://*.backblazeb2.com https://*.supabase.co https://ik.imagekit.io; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://api.openai.com https://api.anthropic.com https://*.supabase.co https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://fonts.gstatic.com https://api.insightiq.ai https://api.getphyllo.com https://*.contentsquare.net https://*.contentsquare.com https://*.s3.amazonaws.com https://*.s3.us-west-1.amazonaws.com; frame-src 'self' https://connect.getphyllo.com; frame-ancestors 'none'; worker-src 'self' blob: https://t.contentsquare.net https://*.contentsquare.net; child-src 'self' blob:;`;
  res.setHeader('Content-Security-Policy', baseCsp);
  // Asset service is allowed in img-src so asset previews work.
  // HSTS only if behind HTTPS (skip for localhost dev)
  if ((req.headers.host || '').includes('usepromptly.app')) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }



  if (parsed.pathname === '/api/user/subscription' && req.method === 'GET') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        if (!user || !user.id) {
          return sendJson(res, 200, { ok: true, plan: 'free' });
        }

        const { data, error } = await supabaseAdmin
          .from('profiles')
          .select('subscription_plan, tier')
          .eq('id', user.id)
          .maybeSingle();

        if (error) {
          console.error('[Subscription] fetch error', error);
          return sendJson(res, 200, { ok: true, plan: 'free' });
        }

        const rawPlan = data?.subscription_plan || data?.tier || 'free';
        const normalized =
          rawPlan === 'paid' || rawPlan === 'premium' ? 'pro' : rawPlan;
        return sendJson(res, 200, { ok: true, plan: normalized, tier: normalized });
      } catch (err) {
        console.error('[Subscription] server error', err);
        return sendJson(res, 200, { ok: true, plan: 'free' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/user/subscription' && req.method === 'POST') {
    (async () => {
      // CRITICAL BYPASS — this endpoint used to accept `{ "tier": "pro" }`
      // from ANY authenticated user and write it straight to profiles via
      // the service-role client (RLS bypassed). That made the entire Pro
      // gate self-serve: anyone with their own Supabase JWT could grant
      // themselves unlimited renders, unlimited chats, and re-edit.
      //
      // No legitimate caller exists in this repo or the iOS app — the
      // only consumer of subscription state is the GET counterpart at
      // line 9474, which reads. RevenueCat writes via its webhook at
      // /api/revenuecat/webhook, signed and validated.
      //
      // Removed. Returns 410 Gone so any stale caller fails loudly
      // rather than silently no-op'ing.
      try {
        await requireSupabaseUser(req);
      } catch {
        // fall through to 410 — auth state irrelevant, the endpoint is gone
      }
      return sendJson(res, 410, {
        ok: false,
        error: 'gone',
        message: 'Tier writes happen via the RevenueCat webhook only.',
      });
    })();
    return;
  }

  if (parsed.pathname === '/api/profile/settings' && req.method === 'GET') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        if (!user || !user.id) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        if (!supabaseAdmin) {
          return sendJson(res, 500, { ok: false, error: 'supabase_not_configured' });
        }

        const { data, error } = await supabaseAdmin
          .from('profiles')
          .select('profile_settings')
          .eq('id', user.id)
          .maybeSingle();

        if (error) {
          if (isProfileSettingsSchemaMissing(error)) {
            if (!profileSettingsSchemaWarned) {
              profileSettingsSchemaWarned = true;
              console.warn('[ProfileSettings] schema missing: profiles.profile_settings');
            }
            return sendJson(res, 503, { ok: false, error: 'PROFILE_SETTINGS_SCHEMA_MISSING' });
          }
          console.error('[ProfileSettings] fetch error', error);
          return sendJson(res, 500, { ok: false, error: 'profile_settings_fetch_failed' });
        }

        const settings = data?.profile_settings && typeof data.profile_settings === 'object'
          ? data.profile_settings
          : {};
        return sendJson(res, 200, { ok: true, settings });
      } catch (err) {
        const status = err.statusCode || 500;
        if (status !== 401) {
          console.error('[ProfileSettings] handler error', err);
        }
        return sendJson(res, status, { ok: false, error: 'profile_settings_fetch_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/profile/settings' && req.method === 'POST') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        if (!user || !user.id) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        if (!supabaseAdmin) {
          return sendJson(res, 500, { ok: false, error: 'supabase_not_configured' });
        }
        const body = await readJsonBody(req);
        const patch = body?.patch || body?.settings || {};
        const safePatch = patch && typeof patch === 'object' ? patch : {};

        const { data, error } = await supabaseAdmin
          .from('profiles')
          .select('profile_settings')
          .eq('id', user.id)
          .maybeSingle();

        if (error) {
          if (isProfileSettingsSchemaMissing(error)) {
            if (!profileSettingsSchemaWarned) {
              profileSettingsSchemaWarned = true;
              console.warn('[ProfileSettings] schema missing: profiles.profile_settings');
            }
            return sendJson(res, 503, { ok: false, error: 'PROFILE_SETTINGS_SCHEMA_MISSING' });
          }
          console.error('[ProfileSettings] fetch error', error);
          return sendJson(res, 500, { ok: false, error: 'profile_settings_fetch_failed' });
        }

        const current = data?.profile_settings && typeof data.profile_settings === 'object'
          ? data.profile_settings
          : {};
        const nextSettings = { ...current, ...safePatch };

        const { data: updated, error: updateError } = await supabaseAdmin
          .from('profiles')
          .upsert(
            {
              id: user.id,
              email: toPlainString(user.email || user?.user_metadata?.email || ''),
              profile_settings: nextSettings,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'id' }
          )
          .select('profile_settings')
          .maybeSingle();

        if (updateError) {
          if (isProfileSettingsSchemaMissing(updateError)) {
            if (!profileSettingsSchemaWarned) {
              profileSettingsSchemaWarned = true;
              console.warn('[ProfileSettings] schema missing: profiles.profile_settings');
            }
            return sendJson(res, 503, { ok: false, error: 'PROFILE_SETTINGS_SCHEMA_MISSING' });
          }
          console.error('[ProfileSettings] update error', updateError);
          return sendJson(res, 500, { ok: false, error: 'profile_settings_update_failed' });
        }

        const updatedSettings = updated?.profile_settings || nextSettings;
        const sanitized = updatedSettings;
        return sendJson(res, 200, {
          ok: true,
          settings: sanitized,
        });
      } catch (err) {
        const status = err.statusCode || 500;
        if (status !== 401) {
          console.error('[ProfileSettings] handler error', err);
        }
        return sendJson(res, status, { ok: false, error: 'profile_settings_update_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/upload' && req.method === 'POST') {
    (async () => {
      try {
        if (!s3.isConfigured() && !supabaseAdmin) {
          return sendJson(res, 500, { error: 'storage_not_configured' });
        }

        // Authenticate and derive the owner from the token — NEVER from a client
        // field. Previously this route was unauthenticated and used a
        // client-supplied fields.userId, allowing anyone to write into any
        // user's storage prefix and trigger paid pre-analysis. (Legacy route;
        // the live client uploads via /api/upload-url + /api/upload-multipart-*.)
        const authUser = await requireSupabaseUser(req);
        if (!checkRateLimit(res, 'legacy-upload', authUser.id, 10, 900)) return;
        // Upload door (wall N+1 — NEW gate; upload was rate-limit-only before).
        // Uploads spend S3 storage + paid pre-analysis, so an enforced `.none`
        // is denied before any byte lands. Knob OFF (default) short-circuits —
        // byte-for-byte today's behavior, zero extra reads.
        if (wallEnabled() || clientFreemium(req.headers)) {
          const dec = await leanWallDecision(authUser.id, req);
          if (!dec.allow) return sendUploadDenial(res, dec, 'upload', authUser.id);
        }
        const userId = authUser.id;

        const rawBody = await readRawBodyWithLimit(req, MAX_UPLOAD_BODY);
        const { fields, files } = parseMultipartFormData(rawBody, req.headers['content-type'] || '');
        const file = files.video;

        if (!file) return sendJson(res, 400, { error: 'No video file provided' });
        if (file.size > MAX_VIDEO_FILE_SIZE) {
          return sendJson(res, 400, { error: 'File size exceeds 500MB limit' });
        }

        const fileExtension = String(file.name || '').toLowerCase().match(/\.[^.]*$/)?.[0] || '';
        if (!VIDEO_ALLOWED_TYPES.includes(file.type) && !VIDEO_ALLOWED_EXTENSIONS.includes(fileExtension)) {
          return sendJson(res, 400, { error: 'Only MP4, MOV, and AVI files are allowed' });
        }

        const timestamp = Date.now();
        const sanitizedFilename = String(file.name || 'video.mp4')
          .replace(/[^a-zA-Z0-9.-]/g, '_')
          .replace(/_{2,}/g, '_');

        let publicUrl = null;
        let storagePath = null;

        if (s3.isConfigured()) {
          // Primary: upload to S3 (colocated with Modal worker)
          storagePath = `sources/${userId}/${timestamp}-${sanitizedFilename}`;
          try {
            publicUrl = await s3.upload(storagePath, file.buffer, file.type);
            console.log(`[upload] S3 upload success: ${storagePath}`);
          } catch (err) {
            console.error('[upload] S3 upload failed, falling back to Supabase:', err.message);
            publicUrl = null;
          }
        }

        if (!publicUrl && supabaseAdmin) {
          // Fallback: upload to Supabase Storage
          storagePath = `${userId}/${timestamp}-${sanitizedFilename}`;
          const { error: uploadError } = await supabaseAdmin.storage
            .from('videos')
            .upload(storagePath, file.buffer, {
              contentType: file.type,
              upsert: false,
            });
          if (uploadError) {
            console.error('[VideoEditor][Upload] Supabase upload error:', uploadError);
            return sendJson(res, 500, { error: 'Failed to upload video to storage' });
          }
          const { data: urlData } = supabaseAdmin.storage
            .from('videos')
            .getPublicUrl(storagePath);
          publicUrl = urlData?.publicUrl;
        }

        if (!publicUrl) {
          return sendJson(res, 500, { error: 'Failed to upload video to storage' });
        }

        console.log('[upload] Calling triggerPreAnalysis for:', publicUrl);
        try {
          triggerPreAnalysis(publicUrl);
        } catch (err) {
          console.error('[upload] triggerPreAnalysis threw synchronously:', err.message, err.stack);
        }

        return sendJson(res, 200, {
          success: true,
          videoUrl: publicUrl,
          fileName: sanitizedFilename,
          fileSize: file.size,
          storagePath,
        });
      } catch (error) {
        const status = error?.statusCode || 500;
        console.error('[VideoEditor][Upload] error:', error);
        return sendJson(res, status, { error: clientSafeMessage(error, 'Upload failed. Please try again.') });
      }
    })();
    return;
  }

  const sseStreamMatch = parsed.pathname && parsed.pathname.match(/^\/api\/video-jobs\/([^/]+)\/stream$/i);
  if (sseStreamMatch && req.method === 'GET') {
    const jobId = decodeURIComponent(sseStreamMatch[1] || '').trim();
    if (!jobId) return sendJson(res, 400, { error: 'jobId required' });

    // Runaway-reconnect guard. A client (on ANY shipped build) that reopens the
    // SSE stream for the same job several times per second — a lifecycle churn we
    // can't fix without a release — otherwise pays auth.getUser + 2 Supabase
    // queries PER open (~15 round-trips/sec from one 2-job user). A real viewer
    // holds ONE connection open for minutes; a storm reopens ~150x/min. Cap opens
    // per job BEFORE spending any Supabase call — keyed on the URL's jobId so the
    // throttle runs pre-auth. On 429 the client falls back to its 45s DB poll and
    // SSEClient backs off to its 2s reconnect floor, so the storm self-dampens.
    if (!checkRateLimit(res, 'sse-stream', jobId, 12, 60)) return;

    (async () => {
    // Authenticate + verify ownership BEFORE opening the stream. Without this,
    // anyone holding a job UUID could read its status + signed rendered_video_url.
    // The iOS SSEClient already sends Authorization: Bearer <token>.
    let authUser;
    try { authUser = await requireSupabaseUser(req); }
    catch (e) { return sendJson(res, e?.statusCode || 401, { error: 'unauthorized' }); }
    if (supabaseAdmin) {
      const { data: sseOwner, error: sseOwnerErr } = await supabaseAdmin
        .from('video_jobs').select('user_id').eq('id', jobId).maybeSingle();
      if (sseOwnerErr) return sendJson(res, 500, { error: 'ownership_check_failed' });
      if (!sseOwner || sseOwner.user_id !== authUser.id) return sendJson(res, 404, { error: 'not_found' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    if (!sseClients.has(jobId)) sseClients.set(jobId, new Set());
    sseClients.get(jobId).add(res);

    // Send current state immediately so browser doesn't wait
    if (supabaseAdmin) {
      supabaseAdmin
        .from('video_jobs')
        .select('status, progress, current_step, step_message, rendered_video_url, hls_manifest_url, thumbnail_url, error_message')
        .eq('id', jobId)
        .maybeSingle()
        .then(({ data }) => {
          if (data) {
            try {
              res.write(`data: ${JSON.stringify({
                status: data.status,
                progress: data.progress || 0,
                step: data.current_step || '',
                message: data.step_message || '',
                videoUrl: data.rendered_video_url || null,
                // §5 progressive: a client reconnecting mid-render gets the manifest
                // in the connect snapshot and can resume the preview.
                hlsManifestUrl: data.hls_manifest_url || null,
                thumbnailUrl: data.thumbnail_url || null,
                error: data.error_message || null,
                // final:true on a terminal snapshot lets a correct client stop
                // reconnecting the moment it connects to an already-finished job
                // (SSEClient sets receivedFinalEvent → no reconnect). Its absence
                // is why a client that reconnects onto a completed job never learns
                // to quit. Matches the poll path, which already sets final:true.
                final: isTerminalJobStatus(data.status),
              })}\n\n`);
            } catch (e) {}
          }
        })
        .catch(() => {});
    }

    const pingInterval = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) { clearInterval(pingInterval); }
    }, 15000);

    req.on('close', () => {
      clearInterval(pingInterval);
      const clients = sseClients.get(jobId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) sseClients.delete(jobId);
      }
    });
    })();

    return;
  }

  if (parsed.pathname === '/api/modal-progress' && req.method === 'POST') {
    (async () => {
      try {
        // Authenticate the Modal worker callback. When MODAL_CALLBACK_SECRET is
        // configured, require the worker to echo it as X-Modal-Secret; without
        // it anyone who knows a job UUID could forge progress/completion, inject
        // a rendered_video_url, and trigger a push to the real owner. Backward-
        // compatible: if the secret isn't set yet (worker rollout pending) this
        // is a no-op, so deploy the worker's header first, then set the env.
        if (!modalCallbackAuthed(req)) return sendJson(res, 401, { error: 'unauthorized' });
        const body = await readJsonBody(req);
        const { job_id, step, pct, message } = body || {};
        if (!job_id) return sendJson(res, 400, { error: 'job_id required' });
        if (!supabaseAdmin) return sendJson(res, 500, { error: 'supabase_not_configured' });

        const status = Number(pct) >= 100 ? 'completed' : 'processing';
        const completionVideoUrl = body?.videoUrl || body?.video_url || body?.rendered_video_url || null;

        // Read the PREVIOUS state before the update so the push-
        // dedup path (below) can tell "first complete event for
        // this job" from "duplicate complete event we already pushed
        // for." Single round-trip — we'd be reading this row in the
        // 'complete' branch anyway. The fields we pull (status,
        // user_id, vibe_input, hls_manifest_url) cover both the
        // dedup decision and the push payload.
        const { data: prevState } = await supabaseAdmin
          .from('video_jobs')
          .select('status, user_id, vibe_input, hls_manifest_url, progress')
          .eq('id', job_id)
          .maybeSingle();
        const wasAlreadyCompleted = prevState?.status === 'completed';

        // §5 progressive playback: forward the HLS manifest the moment it exists so a
        // live client can start the inline preview MID-render (not only at completion).
        // The backend's (publishing) contract may deliver it either by writing
        // hls_manifest_url early — already read into prevState above — or by including
        // it in this progress POST; take whichever is present. Additive + null-safe:
        // inert until the worker emits it early. Client gates on progressive_playback_enabled.
        const progressiveManifestUrl = body?.hlsManifestUrl || body?.hls_manifest_url || prevState?.hls_manifest_url || null;
        const manifestFromBody = body?.hlsManifestUrl || body?.hls_manifest_url || null;

        // MONOTONIC PROGRESS CLAMP (Phase 3): a preempted job retries from
        // scratch → the fresh attempt restarts progress at ~0. Clamp so the bar
        // NEVER rewinds — a retry reads as a pause at the high-water mark until
        // it climbs past it, not a jarring 60%→0% reset. Completion (pct>=100)
        // always wins.
        const incomingPct = Number(pct || 0);
        const priorPct = Number(prevState?.progress || 0);
        const clampedPct = incomingPct >= 100 ? incomingPct : Math.max(incomingPct, priorPct);

        const updateData = {
          status,
          progress: clampedPct,
          current_step: step || '',
          step_message: message || '',
          updated_at: new Date().toISOString(),
        };
        if (completionVideoUrl) updateData.rendered_video_url = completionVideoUrl;
        // Persist a manifest that arrived via the progress POST so reconnect/poll/push
        // paths see it too (a worker that writes the column itself needs no help here).
        if (manifestFromBody && !prevState?.hls_manifest_url) updateData.hls_manifest_url = manifestFromBody;

        // First-terminal-wins: this fast-path progress write must never land on
        // a terminal row — it would respell the worker's status (dropping its
        // write-once result/phase) or resurrect a cancelled render. The SSE
        // push below still fires regardless, so the client stays live.
        // .select('id') so we KNOW whether this request won the transition —
        // when status flips to 'completed' here, the winner (and only the
        // winner) owns the lifecycle push below.
        // The error is CAPTURED, not discarded (2026-08-11). Dropping it made a
        // failed write indistinguishable from a genuine zero-row match: both
        // land here as `data == null`, and the stuck-job diagnostic below then
        // reported one mechanism for two different faults. The cancel path at
        // the /api/jobs/:id/cancel handler already captured its error; this one
        // did not, which is how the distinction went missing.
        const { data: transitionRows, error: transitionErr } = await supabaseAdmin
          .from('video_jobs')
          .update(updateData)
          .eq('id', job_id)
          .not('status', 'in', TERMINAL_JOB_STATUSES_SQL)
          .select('id');
        const wonCompletedTransition = status === 'completed'
          && Array.isArray(transitionRows) && transitionRows.length > 0;
        // STUCK-JOB DIAGNOSTIC (lane/delivery 2026-08-11, TRUTH's b384e1c watch):
        // two jobs completed at the worker and their rows NEVER flipped to
        // 'completed' — the half-landed signature (progress=100/current_step=
        // 'complete'/status='processing'). The two candidate mechanisms both
        // become one loud, greppable line here on their next occurrence:
        //   (a) a 'complete' step whose pct did not parse >=100 → this handler
        //       computed status='processing' — the half-landed patch EXACTLY;
        //   (b) a completed-status patch matching 0 rows on a NON-terminal row.
        if (step === 'complete' && status !== 'completed') {
          console.error(`[modal-progress] COMPLETE-WITHOUT-TERMINAL job=${job_id} pct=${JSON.stringify(pct)} `
            + `parsed=${incomingPct} — status computed '${status}'; this writes the half-landed stuck row`);
          supabaseAdmin.from('analytics_events').insert({
            event: 'terminal_flip_lost', platform: 'server',
            props: { job_id, mechanism: 'complete_step_bad_pct', pct: String(pct).slice(0, 20) },
          }).then(() => {}).catch(() => {});
        } else if (status === 'completed' && !wonCompletedTransition
                   && prevState
                   && !['completed', 'failed', 'canceled', 'needs_input'].includes(String(prevState.status))) {
          // FIRED FOR REAL on job 4f37eb44, twice, 2026-08-11 20:20:16Z and
          // 20:22:37Z — 20 minutes after this diagnostic went live, on the
          // post-hang-fix worker image. It named the branch and stopped there,
          // because 'zero rows' still covers three different faults:
          //
          //   update_error        the write FAILED; data is null and the error
          //                       was being discarded, so a failed write was
          //                       indistinguishable from a matched-zero
          //   lost_race_benign    a concurrent writer terminalized the row
          //                       between our read and our write. First-terminal-
          //                       wins working AS DESIGNED — not a defect, and
          //                       counting it as one inflates the class
          //   row_still_nonterminal  the row is STILL non-terminal after our
          //                       write. THE REAL STUCK CLASS: the render is
          //                       finished and the user will be told it failed
          //                       when the fallback timer terminalises it
          //
          // The re-read costs one query and only on this path (which is
          // supposed to be empty), and it is what makes the next occurrence
          // self-explaining instead of another round of inference.
          (async () => {
            let nowStatus = null;
            try {
              const { data: nowRow } = await supabaseAdmin
                .from('video_jobs').select('status').eq('id', job_id).maybeSingle();
              nowStatus = nowRow?.status ?? null;
            } catch (_) { /* diagnostic must never affect the response */ }
            const cause = classifyLostTransition({ transitionErr, nowStatus });
            console.error(`[modal-progress] TERMINAL-FLIP LOST job=${job_id} cause=${cause} — completed patch `
              + `matched 0 rows while prev status='${prevState.status}', row now '${nowStatus}'`
              + (transitionErr ? ` — UPDATE ERROR ${transitionErr.code || ''} ${transitionErr.message || ''}` : '')
              + (cause === 'row_still_nonterminal'
                ? ' — THE RENDER IS DONE AND THE ROW WILL STICK: the user gets a failure for a finished video'
                : ''));
            supabaseAdmin.from('analytics_events').insert({
              event: 'terminal_flip_lost', platform: 'server',
              props: {
                job_id, mechanism: 'zero_rows_nonterminal', cause,
                prev_status: prevState.status, now_status: nowStatus,
                err_code: transitionErr?.code || null,
                err: String(transitionErr?.message || '').slice(0, 160) || null,
              },
            }).then(() => {}).catch(() => {});
          })();
        }

        if (step === 'complete') {
          // Fast-path: tell the UI the video is ready as soon as the worker
          // says so. The thumbnail will arrive in a later 'final' event from
          // dispatchJobToModal, which is the only event with final:true.
          // The frontend keeps the SSE open until that final event arrives.
          // We already have user_id + vibe_input + hls_manifest_url from
          // prevState; only re-read the rendered_video_url because the
          // update above might have just set it.
          const { data: jobRow } = await supabaseAdmin
            .from('video_jobs')
            .select('rendered_video_url')
            .eq('id', job_id)
            .maybeSingle();
          const finalVideoUrl = jobRow?.rendered_video_url || completionVideoUrl || null;
          pushProgressToSSE(job_id, {
            status: 'completed',
            progress: 100,
            step: 'complete',
            message: message || 'Your video is ready!',
            videoUrl: finalVideoUrl,
            hlsManifestUrl: progressiveManifestUrl,
            thumbnailUrl: null,
            final: false,
            error: null,
          });
          if (wasAlreadyCompleted) {
            console.log(`[push] skipping duplicate render-complete for job=${job_id} (already completed)`);
          }
        } else {
          pushProgressToSSE(job_id, {
            status,
            progress: Number(pct || 0),
            step: step || '',
            message: message || '',
            videoUrl: completionVideoUrl,
            hlsManifestUrl: progressiveManifestUrl,
            error: null,
          });
        }

        // Lifecycle push — fires for WHOEVER won the non-terminal → 'completed'
        // transition above, INDEPENDENT of the step label: the transition is
        // consumed exactly once, so if a pct>=100 event ever arrived with a
        // step other than 'complete', gating the push on the step would burn
        // the one transition without a push and every later writer would lose
        // the race — the user would never be told. Fire-and-forget: a
        // notification failure must never affect the render success path (the
        // SSE above already told any foreground client). iOS deep-links into
        // the Library tab via the "render-complete" type handler. The
        // chokepoint's flag + per-job claim gate inside.
        if (wonCompletedTransition && prevState?.user_id) {
          sendLifecyclePush(supabaseAdmin, {
            jobId: job_id,
            userId: prevState.user_id,
            kind: 'completed',
            vibe: prevState.vibe_input || null,
          }).catch((err) => {
            console.error('[push] render-complete dispatch failed:', err.message);
          });
        }

        return sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error('[modal-progress] error:', err.message);
        return sendJson(res, 200, { ok: false });
      }
    })();
    return;
  }

  // ── Internal: render-failure alert (worker → owner push) ──
  // AUTH PING (Zac 2026-08-03): a deploy-time round-trip target. deploy.sh POSTs
  // here with the worker's live MODAL_CALLBACK_SECRET right after a worker deploy;
  // a non-200 FAILS THE DEPLOY LOUDLY instead of the mismatch degrading silently
  // into the recovery path for hours (which cost tonight). Uses the SAME
  // modalCallbackAuthed as every real callback, so it proves the exact auth the
  // completion POST will use. No side effects. Generalises to MODAL_RUN_SECRET.
  if (parsed.pathname === '/api/internal/auth-ping' && req.method === 'POST') {
    const authed = modalCallbackAuthed(req);
    return sendJson(res, authed ? 200 : 401, authed ? { ok: true } : { error: 'unauthorized' });
  }

  // The worker POSTs here when a job fails terminally with a REAL error (never
  // a designed rejection — those are honest and expected). Auth: the same
  // X-Modal-Secret the worker echoes on /api/modal-progress. Fire-and-forget:
  // log a grep-stable [ALERT] line (survives even if push is down) and push to
  // the founder's own device(s) via sendOwnerAlert. Always 202; never blocks
  // the worker's teardown.
  if (parsed.pathname === '/api/internal/render-alert' && req.method === 'POST') {
    (async () => {
      if (!modalCallbackAuthed(req)) return sendJson(res, 401, { error: 'unauthorized' });
      let body = null;
      try { body = await readJsonBody(req); } catch (_) { body = null; }
      sendJson(res, 202, { ok: true });
      try {
        const jobId = (body && body.job_id) || 'unknown';
        const code = (body && body.error_code) || 'UNKNOWN';
        const detail = (body && body.detail) || '';
        const dur = body && body.duration_s;
        const elapsed = body && body.elapsed_s;
        // SERVER-SIDE AT-FAULT GATE (Zac 2026-07-28): the worker's own alert gate
        // (handler _NON_ALERTING_CODES) should only POST at-fault codes here, but
        // enforce the split server-side too — a stale pre-gate worker container, a
        // race, or any future caller must NEVER page the owner for a designed
        // rejection or a non-actionable client-upload failure. Suppressed codes log
        // a digest line (NOT [ALERT]) and skip the push; UNKNOWN + every unclassified
        // code STILL page (loud-failsafe). Doubles as the diagnostic: an
        // [ALERT-SUPPRESSED] line means a code was still arriving despite the worker gate.
        const NON_ALERTING = new Set([
          'NO_AUDIO_TRACK', 'NO_SPEECH', 'NO_SPEECH_NONENGLISH', 'NO_SPEECH_FACE',
          'NOT_TALKING_HEAD', 'CLIP_TOO_LONG', 'CLIP_TOO_SHORT', 'WRONG_ORIENTATION',
          'INVALID_FORMAT', 'EMPTY_UPLOAD', 'INVALID_SOURCE_URL', 'TRANSCRIPTION',
          'TRANSCRIPTION_INCOMPLETE',
          'UPLOAD_STALLED', 'UPLOAD_TIMEOUT', 'UPLOAD_NEVER_STARTED',
        ]);
        // category (Zac 2026-08-03): 'intake' = the client-upload family. It was
        // digest-only (suppressed below) and thus INVISIBLE on the phone — 49
        // users in 2 days. Intake alerts now BYPASS the suppression and page under
        // their OWN collapsed thread, so a spike is visible without spamming the
        // render-alert thread. 'render' (default) keeps the suppression so designed
        // rejections stay digest-only.
        const category = (body && body.category) || 'render';
        const userId = body && body.user_id;
        const isIntake = category === 'intake';
        if (!isIntake && NON_ALERTING.has(code)) {
          console.log(`[ALERT-SUPPRESSED] non-actionable code=${code} job=${jobId} — digest only, no owner push`);
          return;
        }
        console.error(`[ALERT] ${category} failure job=${jobId} code=${code}`
          + (userId ? ` user=${String(userId).slice(0, 8)}` : '')
          + (dur ? ` dur=${dur}s` : '') + (elapsed ? ` elapsed=${elapsed}s` : '')
          + (detail ? ` detail=${String(detail).slice(0, 200)}` : ''));
        const bodyLine = `job ${String(jobId).slice(0, 8)}`
          + (userId ? ` · user ${String(userId).slice(0, 8)}` : '')
          + (dur ? ` · ${Math.round(dur)}s source` : '')
          + (elapsed ? ` · died @${Math.round(elapsed)}s` : '');
        await sendOwnerAlert({
          ownerUserId: SUBMISSION_OWNER_USER_ID,
          title: isIntake ? `📥 [Promptly] intake fail: ${code}` : `⚠️ [Promptly] render failed: ${code}`,
          body: bodyLine,
          threadId: isIntake ? 'intake-alert' : 'render-alert',
          supabaseAdmin,
        });
      } catch (e) {
        console.error('[ALERT] handler error:', e && e.message ? e.message : e);
      }
    })();
    return;
  }

  // ── Internal: lifecycle-push proof (owner-device delivery proof) ──
  // Fires a real completed-class or failed-class lifecycle push at the OWNER's
  // registered device(s) — never a real user — and returns the per-token APNs
  // responses in the body, so delivery can be proven end-to-end (logs are not
  // proof) BEFORE USER_LIFECYCLE_PUSHES is flipped on. Works regardless of the
  // flag (test mode bypasses flag + claim, so it is repeatable).
  //
  // Auth, two accepted paths — operator-only by construction either way:
  //   a) exact service-role-key bearer match, or
  //   b) a DB-minted single-use nonce: the operator (who by definition holds
  //      A valid service key for this project — key STRINGS can differ across
  //      environments, e.g. legacy-JWT vs new-format secrets, which is why (a)
  //      alone proved brittle) inserts an analytics_events row
  //      {event:'lifecycle_push_proof_nonce', props:{nonce}} and echoes the
  //      nonce in X-Proof-Nonce. The row must be <5 min old and is consumed
  //      (deleted) on use — replay-proof.
  if (parsed.pathname === '/api/internal/lifecycle-push-proof' && req.method === 'POST') {
    (async () => {
      try {
        const expect = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
        const got = String((req.headers && req.headers['authorization']) || '').replace(/^Bearer\s+/i, '').trim();
        let authed = false;
        if (expect && got && got.length === expect.length) {
          try { authed = crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expect)); } catch { authed = false; }
        }
        const nonceHdr = String((req.headers && req.headers['x-proof-nonce']) || '').trim();
        if (!authed && nonceHdr && nonceHdr.length >= 32 && nonceHdr.length <= 128 && supabaseAdmin) {
          const sinceISO = new Date(Date.now() - 5 * 60 * 1000).toISOString();
          const { data: nrows } = await supabaseAdmin
            .from('analytics_events')
            .select('id, props')
            .eq('event', 'lifecycle_push_proof_nonce')
            .gte('created_at', sinceISO)
            .order('created_at', { ascending: false })
            .limit(5);
          for (const nr of (nrows || [])) {
            const want = String((nr.props && nr.props.nonce) || '');
            if (want && want.length === nonceHdr.length) {
              let match = false;
              try { match = crypto.timingSafeEqual(Buffer.from(nonceHdr), Buffer.from(want)); } catch { match = false; }
              if (match) {
                await supabaseAdmin.from('analytics_events').delete().eq('id', nr.id); // single-use
                authed = true;
                break;
              }
            }
          }
        }
        if (!authed) return sendJson(res, 401, { error: 'unauthorized' });

        const body = await readJsonBody(req).catch(() => null);
        const kind = body && body.kind;
        if (kind !== 'completed' && kind !== 'failed') {
          return sendJson(res, 400, { error: "kind must be 'completed' or 'failed'" });
        }
        let vibe = (body && body.vibe) || null;
        let errorMessage = (body && body.error_message) || null;
        let jobId = (body && body.job_id) || `proof-${kind}`;
        if (body && body.job_id && supabaseAdmin) {
          // Copy realism: pull the actual row's copy — but ONLY an owner-owned
          // row may seed a proof (never touch a real user's job).
          const { data: row } = await supabaseAdmin
            .from('video_jobs')
            .select('user_id, vibe_input, error_message')
            .eq('id', body.job_id)
            .maybeSingle();
          if (!row) return sendJson(res, 404, { error: 'job not found' });
          if (row.user_id !== LIFECYCLE_OWNER_USER_ID) {
            return sendJson(res, 403, { error: 'proof jobs must be owner-owned' });
          }
          vibe = vibe || row.vibe_input || null;
          errorMessage = errorMessage || row.error_message || null;
        }
        const r = await sendLifecyclePush(supabaseAdmin, {
          jobId, kind, vibe, errorMessage,
          refunded: body && body.refunded !== undefined ? !!body.refunded : true,
          test: true,
        });
        const alert = kind === 'completed'
          ? buildCompletedAlert({ vibe })
          : buildFailedAlert({ errorMessage, refunded: body && body.refunded !== undefined ? !!body.refunded : true });
        console.log(`[lifecycle-push] PROOF kind=${kind} job=${jobId} sent=${r.sent ?? 0}/${r.total ?? 0}`);
        return sendJson(res, 200, { ok: true, kind, alert, sent: r.sent ?? 0, total: r.total ?? 0, skipped: r.skipped || null, apns: r.results || [] });
      } catch (e) {
        console.error('[lifecycle-push] proof error:', e && e.message ? e.message : e);
        return sendJson(res, 500, { error: 'proof failed' });
      }
    })();
    return;
  }

  // ── Worker completion callback (spawn refactor, Phase 2) ──
  // On the spawn path the worker POSTs the FULL pipeline result here at pipeline
  // end — the reliable, worker-controlled completion delivery. We settle the
  // pending promise the dispatch IIFE is awaiting → the completion tail runs.
  // Auth: the same X-Modal-Secret the worker echoes on progress. SETTLE-ONCE:
  // settlePendingModalJob dedups on call_id (map delete on first settle), so a
  // duplicate POST, a racing Modal platform webhook, or a late fallback are ALL
  // structural no-ops — the tail runs exactly once. Always 202; never blocks the
  // worker. Inert until Phase 3 (nothing POSTs here until the worker spawns).
  if (parsed.pathname === '/api/modal-complete' && req.method === 'POST') {
    (async () => {
      if (!modalCallbackAuthed(req)) return sendJson(res, 401, { error: 'unauthorized' });
      let body = null;
      try { body = await readJsonBody(req); } catch (_) { body = null; }
      sendJson(res, 202, { ok: true });
      try {
        const callId = body && String(body.call_id || body.id || '').trim();
        if (!callId) { console.warn('[modal-complete] missing call_id'); return; }
        // The worker's return value (success payload OR classified error envelope);
        // the dispatch tail branches on it exactly as it did on the sync response.
        const output = (body && (body.result || body.output)) || {};
        const settled = settlePendingModalJob({ id: callId, status: 'completed', output, via: 'callback' });
        console.log(`[modal-complete] call=${callId} job=${(body && body.job_id) || '?'} settled=${settled}`);
        // ORPHANED CALLBACK (lane/delivery 2026-08-10): settled=false means NO
        // pending promise holds this call_id in THIS process — the worker's POST
        // reached a process that isn't awaiting the job (a deploy/restart routed
        // it to the fresh instance while the old one holds the map, or the map
        // entry was already consumed). Every deploy orphans in-flight jobs this
        // way (standing law, 2026-08-04). Until now the 202 swallowed the POST
        // and the job's completion survived only through the worker's own
        // durable row + the old process's nets. Make the orphan VISIBLE and
        // repair the user-facing pieces that are claim-guarded/idempotent:
        //   • analytics row (the scoreboard's orphan counter)
        //   • completed_at backfill (the tail that would stamp it is gone)
        //   • completion_delivery = 'orphan_callback' (first-stamp-wins)
        //   • claim-guarded lifecycle push (no-op if any other path pushed)
        // Deliberately NO status write and NO URL signing here — the worker's
        // durable write owns the row; this only fills the gaps it can't.
        const jobIdForOrphan = (body && body.job_id) || null;
        if (!settled && jobIdForOrphan && supabaseAdmin) {
          (async () => {
            try {
              supabaseAdmin.from('analytics_events').insert({
                event: 'completion_callback_orphaned', platform: 'server',
                props: { job_id: jobIdForOrphan, call_id: callId },
              }).then(() => {}).catch(() => {});
              const { data: row } = await supabaseAdmin
                .from('video_jobs')
                .select('status, user_id, vibe_input, completed_at')
                .eq('id', jobIdForOrphan)
                .maybeSingle();
              if (String(row?.status || '') !== 'completed') {
                console.warn(`[modal-complete] ORPHAN call=${callId} job=${jobIdForOrphan} row status=${row?.status || 'missing'} — durable write not landed; nets own recovery`);
                return;
              }
              if (!row.completed_at) {
                await supabaseAdmin.from('video_jobs')
                  .update({ completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                  .eq('id', jobIdForOrphan)
                  .is('completed_at', null);
              }
              const { error: cdErr } = await supabaseAdmin.from('video_jobs')
                .update({ completion_delivery: 'orphan_callback' })
                .eq('id', jobIdForOrphan)
                .is('completion_delivery', null);
              if (cdErr && !/completion_delivery/.test(cdErr.message || '')) {
                console.warn(`[modal-complete] orphan marker soft-failed: ${cdErr.message}`);
              }
              if (row.user_id) {
                sendLifecyclePush(supabaseAdmin, {
                  jobId: jobIdForOrphan, userId: row.user_id, kind: 'completed',
                  vibe: row.vibe_input || null,
                }).catch(() => {});
              }
              console.log(`[modal-complete] ORPHAN repaired call=${callId} job=${jobIdForOrphan} (completed row: marker+completed_at+push-claim)`);
            } catch (e) {
              console.warn(`[modal-complete] orphan repair failed job=${jobIdForOrphan}: ${e && e.message}`);
            }
          })();
        }
      } catch (e) {
        console.error('[modal-complete] error:', e && e.message ? e.message : e);
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/modal-webhook' && req.method === 'POST') {
    (async () => {
      try {
        // NOTE: this callback is invoked by Modal's PLATFORM (the `webhook` URL
        // in callModalRender), not our worker, so it can't carry X-Modal-Secret.
        // It's keyed by an opaque, server-issued Modal call id — settlePending-
        // ModalJob is a no-op for any id that isn't currently in flight — so a
        // forged call can't settle a real render (audit-verified). Do NOT add
        // modalCallbackAuthed here: it would 401 every legitimate settlement.
        const body = await readJsonBody(req);
        const id = body?.id;
        const status = body?.status;
        const output = body?.output;
        const error = body?.error || body?.message || null;
        console.log(`[modal] Webhook received: ${id || 'unknown'} status=${status || 'UNKNOWN'}`);
        settlePendingModalJob({ id, status, output, error, via: 'webhook' });
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error('[modal] Webhook handler failed:', err.message);
        return sendJson(res, 200, { ok: false });
      }
    })();
    return;
  }

  // Client build stamp for build-adoption bucketing. Explicit X-App-Version
  // header (sent by 224+, format "1.3.6 (224)") wins; older live clients fall
  // back to the build number the default iOS URLSession User-Agent carries
  // ("Promptly/221 ..."). Null when neither is present — never guessed.
  function clientAppVersion(req) {
    const explicit = String((req && req.headers && req.headers['x-app-version']) || '').trim();
    if (explicit) return explicit.slice(0, 40);
    const ua = String((req && req.headers && req.headers['user-agent']) || '');
    const m = ua.match(/Promptly\/(\S+)/i);
    return m ? m[1].slice(0, 40) : null;
  }

  async function createQueuedVideoJob({ userId, videoUrl, vibeInput, clientJobId, demo = false, appVersion = null, sourceType = null, sourceDuration = null }) {
    if (!videoUrl) throw Object.assign(new Error('Video URL is required'), { statusCode: 400 });
    if (!vibeInput) throw Object.assign(new Error('Vibe input is required'), { statusCode: 400 });
    if (!userId) throw Object.assign(new Error('User ID is required'), { statusCode: 400 });

    const insertRow = {
      user_id: userId,
      video_url: videoUrl,
      vibe_input: vibeInput,
      status: 'queued',
      progress: 0,
      current_step: 'Queued',
    };
    // §4: mark the first-run sample-clip demo so it's quota-exempt AND excluded
    // from activation metrics. Only set when true (column defaults false).
    if (demo) insertRow.demo = true;
    // Idempotency keystone (stuck-jobs directive): the CLIENT mints the job
    // UUID at message creation, before upload starts. We insert under that id;
    // a double-submit (retry mashing, network replay) hits the primary-key
    // conflict and returns the EXISTING row flagged __replayed so the caller
    // can unwind the just-claimed charge — one job, one charge, by construction.
    if (clientJobId) insertRow.id = clientJobId;

    const { data, error } = await supabaseAdmin
      .from('video_jobs')
      .insert(insertRow)
      .select()
      .single();

    if (error) {
      // 23505 unique_violation on the client-supplied id → idempotent replay.
      if (clientJobId && (error.code === '23505' || /duplicate key/i.test(error.message || ''))) {
        const { data: existing } = await supabaseAdmin
          .from('video_jobs')
          .select('*')
          .eq('id', clientJobId)
          .eq('user_id', userId)
          .maybeSingle();
        if (existing) return { ...existing, __replayed: true };
        // The id exists but belongs to someone else — reject, never leak it.
        throw Object.assign(new Error('job_id_conflict'), { statusCode: 409 });
      }
      throw Object.assign(new Error(error.message || 'Failed to create job'), { statusCode: 500 });
    }
    // Provenance stamps: build (adoption bucketing) + source_type/source_duration
    // (measuring the iCloud reliability fix + deconfounding wait-time). Best-effort
    // and DECOUPLED from the insert: a missing column (before the additive
    // migration lands) comes back as an error object here, never a throw, so job
    // creation can NEVER break on it. Not awaited — zero added latency.
    if (data && data.id) {
      const patch = {};
      if (appVersion) patch.app_version = appVersion;
      if (sourceType) patch.source_type = String(sourceType).slice(0, 16);
      if (Number.isFinite(Number(sourceDuration))) patch.source_duration = Number(sourceDuration);
      if (Object.keys(patch).length) {
        supabaseAdmin.from('video_jobs').update(patch).eq('id', data.id).then(() => {}, () => {});
      }
    }
    return data;
  }


  // ── Daily usage tracking (RevenueCat-era gating) ──
  // Both counters use the usage_events table and a UTC midnight cutoff.
  // Cheap: composite index on (user_id, kind, created_at DESC).
  //
  // The authoritative daily caps live in lib/tier-capabilities.js
  // (capabilities()): freemium FREE = 1 render/day + 50 chats; legacy 'trial' =
  // 3/day. There is NO local render-cap constant here — a stale FREE_DAILY_RENDERS
  // = 3 used to sit in this spot, unreferenced, and it read as a second source of
  // truth. Removed so capabilities() is the ONLY place the numbers live.

  function utcDayStart() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  }

  async function countTodayUsage(userId, kind) {
    if (!supabaseAdmin) {
      // Closed by default. If supabase is down we cannot prove the user
      // has remaining quota, so refuse the action — better than letting
      // them through unbounded.
      const err = new Error('usage_count_unavailable');
      err.statusCode = 503;
      throw err;
    }
    const { count, error } = await supabaseAdmin
      .from('usage_events')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('kind', kind)
      .gte('created_at', utcDayStart());
    if (error) {
      // Fail CLOSED instead of returning 0. A Supabase-error response
      // returning 0 lets every free user blow past the cap until the
      // outage clears. We'd rather a brief "try again in a minute"
      // than silently turn off the paywall for the duration of an
      // incident.
      console.error('[usage] count failed — refusing action', { userId, kind, error: error.message });
      const wrapped = new Error('usage_count_failed');
      wrapped.statusCode = 503;
      throw wrapped;
    }
    return Number(count || 0);
  }

  async function logUsageEvent(userId, kind) {
    if (!supabaseAdmin || !userId) {
      // Same fail-closed reasoning. If we cannot increment the counter,
      // the next request will see the same (uncounted) value and the
      // gate becomes a no-op for the duration of the outage. Refuse the
      // current action so the user retries instead of getting unlimited.
      const err = new Error('usage_log_unavailable');
      err.statusCode = 503;
      throw err;
    }
    const { error } = await supabaseAdmin
      .from('usage_events')
      .insert({ user_id: userId, kind });
    if (error) {
      console.error('[usage] insert failed — refusing action', { userId, kind, error: error.message });
      const wrapped = new Error('usage_log_failed');
      wrapped.statusCode = 503;
      throw wrapped;
    }
  }

  // Atomically claim one daily-quota slot: check today's count AND insert the
  // usage event under a per-(user,kind) advisory lock, so concurrent requests
  // can't both pass the cap (TOCTOU double-spend). Returns { ok } — ok=false
  // means the daily limit is already reached. Falls back to the old
  // count-then-insert (best effort) if the RPC isn't deployed yet, so this is
  // safe to ship before the migration lands. Errors fail CLOSED (throw 503).
  async function claimDailyUsage(userId, kind, dailyLimit) {
    if (!supabaseAdmin || !userId) {
      const e = new Error('usage_claim_unavailable'); e.statusCode = 503; throw e;
    }
    const { data, error } = await supabaseAdmin.rpc('claim_usage_slot', {
      p_user: userId, p_kind: kind, p_daily_limit: dailyLimit,
    });
    if (!error) return { ok: data === true };
    // Fall back to the racy path ONLY when the function is genuinely absent
    // (migration not applied yet): PostgREST reports that as PGRST202 (schema
    // cache miss) or a message naming claim_usage_slot itself. A 42883 raised
    // from INSIDE the function must NOT be swallowed here — that would silently
    // disable the cross-instance lock — so it falls through to fail-closed 503.
    if (error.code === 'PGRST202'
        || /claim_usage_slot.*does not exist/i.test(error.message || '')) {
      const today = await countTodayUsage(userId, kind);
      if (today >= dailyLimit) return { ok: false };
      await logUsageEvent(userId, kind);
      return { ok: true };
    }
    console.error('[usage] claim_usage_slot failed — refusing action', { userId, kind, error: error.message });
    const e = new Error('usage_claim_failed'); e.statusCode = 503; throw e;
  }

  // ── Presigned S3 upload URL ──
  if (parsed.pathname === '/api/upload-url' && req.method === 'POST') {
    (async () => {
      try {
        const authUser = await requireSupabaseUser(req);
        const _preBody = await readJsonBody(req);

        // ── purpose: "chat_media" (§1 reference contract, 2026-08-23) ────────
        // A chat image is NOT a video upload: it must not consume a render from
        // the upload wall, it must not land under the world-readable `sources/`
        // prefix, and it has no public URL by design. Branching BEFORE the wall
        // is the point — routing chat attachments through the video door would
        // silently bill a user a render for sending a photo.
        if (String(_preBody?.purpose || '') === 'chat_media') {
          const cm = require('./lib/chat-media');
          const s3 = require('./services/s3');
          if (!s3.isConfigured()) return sendJson(res, 500, { error: 'Storage not configured' });
          let key;
          try {
            key = cm.buildKey(authUser.id, _preBody?.mime, _preBody?.fileName);
          } catch (e) {
            return sendJson(res, e.statusCode || 400, {
              error: e.message,
              allowed: Array.from(cm.ALLOWED_MIME),
            });
          }
          // 1 hour, NOT the 7 days the video path uses. A chat image is picked
          // and sent within seconds; the long TTL exists for background
          // URLSession resumes that do not apply here, and a shorter-lived
          // single-use PUT is strictly less to leak.
          const uploadUrl = await s3.createPresignedPutUrl(key, 3600);
          // No publicUrl. This prefix is private, and returning a public-shaped
          // URL is precisely how the exports/ paywall became theatre.
          return sendJson(res, 200, {
            uploadUrl,
            key,
            mime: cm.normalizeMime(_preBody?.mime),
            maxBytes: cm.MAX_MEDIA_BYTES,
            maxPerMessage: cm.MAX_MEDIA_PER_MESSAGE,
          });
        }

        // Upload door (wall N+1) — see /api/upload. Knob OFF short-circuits.
        if (wallEnabled() || clientFreemium(req.headers)) {
          const dec = await leanWallDecision(authUser.id, req);
          if (!dec.allow) return sendUploadDenial(res, dec, 'upload-url', authUser.id);
        }
        const body = _preBody;
        const fileName = String(body?.fileName || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
        const s3 = require('./services/s3');
        if (!s3.isConfigured()) {
          return sendJson(res, 500, { error: 'Storage not configured' });
        }
        const key = `sources/${authUser.id}/${Date.now()}-${fileName}`;
        // Presign TTL = 604800s (7 days, the SigV4 maximum). The whole
        // UPLOAD_NEVER_STARTED mechanism was a background URLSession task resuming
        // hours later with a baked-in presigned URL that had expired (600s, then
        // 3600s — both too short for an offline-overnight resume → guaranteed S3
        // 403 → source never lands). At 7 days it does not expire in any realistic
        // resume window, which closes the class server-side and largely obviates
        // the client "re-mint on retry" work. Risk: a 7-day validity window on a
        // SINGLE-USE PUT to a random per-job key — low, and far lower than users
        // losing videos. The only remaining cause is the local file itself
        // disappearing (camera-roll delete / iCloud eviction) → the 224 app-owned
        // copy at pick time.
        const uploadUrl = await s3.createPresignedPutUrl(key, 604800);
        const publicUrl = s3.getPublicUrl(key);
        // SERVER-TRUTH upload attempt — the user got far enough to request an
        // upload URL. More reliable than the client's upload_started (which drops
        // on weak networks), and it lights up the signup→upload region NOW without
        // waiting on a client release. (223 adds the earlier client steps.)
        serverFunnel(authUser.id, 'upload_url_requested', { path: 'single' });
        warmDispatcherOnIntent(); // boot the dispatcher during the upload window → no cold-start 502 at dispatch
        return sendJson(res, 200, { uploadUrl, publicUrl, key });
      } catch (error) {
        return sendJson(res, error?.statusCode || 500, { error: error?.message || 'Failed to generate upload URL' });
      }
    })();
    return;
  }

  // ── Multipart upload: init ────────────────────────────────────────────
  // Client POSTs {fileName, partCount}. Server creates an S3 multipart
  // upload, presigns N part URLs (accelerate endpoint), returns them.
  // Client uploads parts in parallel, then calls /api/upload-multipart-complete.
  // Dramatically faster than single-stream PUT — 2-3× on typical networks.
  if (parsed.pathname === '/api/upload-multipart-init' && req.method === 'POST') {
    (async () => {
      try {
        const authUser = await requireSupabaseUser(req);
        // Upload door (wall N+1) — see /api/upload. Knob OFF short-circuits.
        // partCount is parts of ONE file, so the decision count stays 1.
        if (wallEnabled() || clientFreemium(req.headers)) {
          const dec = await leanWallDecision(authUser.id, req);
          if (!dec.allow) return sendUploadDenial(res, dec, 'multipart-init', authUser.id);
        }
        const body = await readJsonBody(req);
        const fileName = String(body?.fileName || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
        const partCount = Math.max(1, Math.min(1000, parseInt(body?.partCount, 10) || 0));
        if (partCount === 0) return sendJson(res, 400, { error: 'partCount is required (1-1000)' });

        const s3 = require('./services/s3');
        if (!s3.isConfigured()) {
          return sendJson(res, 500, { error: 'Storage not configured' });
        }

        const key = `sources/${authUser.id}/${Date.now()}-${fileName}`;
        // Part-URL presign: 7 days (was 3600s — the Aug-24 spike's mechanism:
        // resume window expired = 51.3% of spike failures vs 26.8% baseline, with
        // error_domain EMPTY on 100% because there IS no transport error — the
        // 1h window killed backgrounded uploads by deadline, not by network.
        // The single-PUT door already presigns 604800; the parts asymmetry was
        // the defect. SigV4 caps at 7d. Client resumeTTL follows (6.5d margin).
        const { uploadId, partUrls } = await s3.initMultipartUpload(key, partCount, 604800);
        const publicUrl = s3.getPublicUrl(key);
        serverFunnel(authUser.id, 'upload_url_requested', { path: 'multipart' }); // server-truth upload attempt
        warmDispatcherOnIntent(); // boot the dispatcher during the upload window → no cold-start 502 at dispatch
        return sendJson(res, 200, { uploadId, partUrls, key, publicUrl });
      } catch (error) {
        console.error('[upload-multipart-init] error:', error?.message);
        return sendJson(res, error?.statusCode || 500, { error: error?.message || 'Failed to init multipart upload' });
      }
    })();
    return;
  }

  // ── Multipart upload: complete ────────────────────────────────────────
  // Body: {key, uploadId, parts: [{PartNumber, ETag}]}
  if (parsed.pathname === '/api/upload-multipart-complete' && req.method === 'POST') {
    (async () => {
      try {
        await requireSupabaseUser(req);
        const body = await readJsonBody(req);
        const key = String(body?.key || '').trim();
        const uploadId = String(body?.uploadId || '').trim();
        const parts = Array.isArray(body?.parts) ? body.parts : null;
        if (!key || !uploadId || !parts) {
          return sendJson(res, 400, { error: 'key, uploadId, and parts are required' });
        }

        const s3 = require('./services/s3');
        await s3.completeMultipartUpload(key, uploadId, parts);
        return sendJson(res, 200, { publicUrl: s3.getPublicUrl(key), key });
      } catch (error) {
        console.error('[upload-multipart-complete] error:', error?.message);
        return sendJson(res, error?.statusCode || 500, { error: error?.message || 'Failed to complete multipart upload' });
      }
    })();
    return;
  }

  // ── Multipart upload: abort (cleanup on client give-up) ──────────────
  if (parsed.pathname === '/api/upload-multipart-abort' && req.method === 'POST') {
    (async () => {
      try {
        await requireSupabaseUser(req);
        const body = await readJsonBody(req);
        const key = String(body?.key || '').trim();
        const uploadId = String(body?.uploadId || '').trim();
        if (!key || !uploadId) return sendJson(res, 400, { error: 'key + uploadId required' });
        const s3 = require('./services/s3');
        await s3.abortMultipartUpload(key, uploadId);
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        return sendJson(res, error?.statusCode || 500, { error: error?.message || 'Abort failed' });
      }
    })();
    return;
  }

  // ── Creator Submissions: presigned upload URL (PUBLIC, per-IP rate-limited) ──
  // Anonymous creators request a presigned PUT URL to upload a video. The S3
  // key is ALWAYS server-generated under submissions/ — we never trust a
  // client-supplied prefix or key.
  if (parsed.pathname === '/api/submissions/upload-url' && req.method === 'POST') {
    (async () => {
      try {
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
        // Generous: this only mints a presigned PUT (cheap, keys are server-
        // generated under submissions/, and every submission is human-reviewed).
        // The old 10/15min blocked legit creators — each failed-upload RETRY of a
        // large file burns a token, and mobile carriers NAT many users behind one
        // IP, so a real creator hit "Too many requests" after a few retries.
        // 100/10min (refill ~1 token/6s) covers retries + CGNAT while still
        // bounding abuse to junk uploads that never auto-process.
        if (!checkRateLimit(res, 'submissions:upload-url', clientIp, 100, 600)) return;
        const body = await readJsonBody(req);
        const result = validateUploadRequest({
          fileName: body?.fileName,
          contentType: body?.contentType,
          size: body?.size,
        });
        if (!result.ok) {
          return sendJson(res, 400, { error: result.error });
        }
        if (!s3.isConfigured()) {
          return sendJson(res, 500, { error: 'Storage not configured' });
        }
        // Key is always server-generated under submissions/ — never trust client prefix.
        const key = `submissions/${Date.now()}-${crypto.randomUUID()}-${result.safeName}`;
        const uploadUrl = await s3.createPresignedPutUrl(key, 600);
        const publicUrl = s3.getPublicUrl(key);
        return sendJson(res, 200, { uploadUrl, publicUrl, key });
      } catch (error) {
        return sendJson(res, error?.statusCode || 500, { error: error?.message || 'Failed to generate upload URL' });
      }
    })();
    return;
  }

  // ── Creator Submissions: create submission (PUBLIC, per-IP rate-limited) ──
  // Body: {creator_name, creator_email, notes, videos:[{key,filename,size,content_type}]}.
  // Each video URL is derived server-side from its (validated) key — client url is ignored.
  if (parsed.pathname === '/api/submissions' && req.method === 'POST') {
    (async () => {
      try {
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
        // Bumped from 10/15min for the same reason (retries + mobile CGNAT sharing
        // one IP). A submission is reviewed, so a higher ceiling is low-risk.
        if (!checkRateLimit(res, 'submissions:submit', clientIp, 30, 900)) return;
        const body = await readJsonBody(req);
        const result = validateSubmission({
          creator_name: body?.creator_name,
          creator_email: body?.creator_email,
          notes: body?.notes,
          videos: body?.videos,
        });
        if (!result.ok) {
          return sendJson(res, 400, { error: result.error });
        }
        if (!supabaseAdmin) {
          return sendJson(res, 501, { error: 'Supabase admin client not configured' });
        }
        // Derive each video URL from its validated key (keys are guaranteed
        // under submissions/ by lib/submissions). Ignore any client-supplied url.
        const videos = result.value.videos.map((v) => ({
          key: v.key,
          filename: v.filename,
          size: v.size,
          content_type: v.content_type,
          url: s3.getPublicUrl(v.key),
        }));
        const { data, error } = await supabaseAdmin
          .from('creator_submissions')
          .insert({
            creator_name: result.value.creator_name,
            creator_email: result.value.creator_email,
            notes: result.value.notes,
            videos,
          })
          .select('id')
          .single();
        if (error) {
          throw Object.assign(new Error(error.message || 'Failed to create submission'), { statusCode: 500 });
        }
        return sendJson(res, 200, { ok: true, id: data.id });
      } catch (error) {
        return sendJson(res, error?.statusCode || 500, { error: error?.message || 'Failed to create submission' });
      }
    })();
    return;
  }

  // ── Creator Submissions: list all (ADMIN) ──
  // Gated by isAuthorizedSubmissionReviewer: the owner's user id (always), plus
  // optional SUBMISSION_ADMIN_USER_IDS / SUBMISSION_ADMIN_EMAILS env allowlists.
  // Non-owner sessions with no matching env entry are rejected (403).
  if (parsed.pathname === '/api/admin/submissions' && req.method === 'GET') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        if (!isAuthorizedSubmissionReviewer(user)) {
          return sendJson(res, 403, { error: 'Forbidden' });
        }
        const { data, error } = await supabaseAdmin
          .from('creator_submissions')
          .select('*')
          .order('created_at', { ascending: false });
        if (error) {
          throw Object.assign(new Error(error.message || 'Failed to load submissions'), { statusCode: 500 });
        }
        return sendJson(res, 200, { submissions: data || [] });
      } catch (error) {
        return sendJson(res, error?.statusCode || 500, { error: error?.message || 'Failed to load submissions' });
      }
    })();
    return;
  }

  // ── Creator Submissions: update one (ADMIN) ──
  // PATCH /api/admin/submissions/:id  Body: {status?, review_notes?}.
  if (parsed.pathname.startsWith('/api/admin/submissions/') && req.method === 'PATCH') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        if (!isAuthorizedSubmissionReviewer(user)) {
          return sendJson(res, 403, { error: 'Forbidden' });
        }
        const id = parsed.pathname.slice('/api/admin/submissions/'.length);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
          return sendJson(res, 400, { error: 'Invalid submission id' });
        }
        const body = await readJsonBody(req);
        const patch = {};
        if (body?.status !== undefined) {
          if (!isValidStatus(body.status)) {
            return sendJson(res, 400, { error: 'Invalid status' });
          }
          patch.status = String(body.status).toLowerCase().trim();
        }
        if (body?.review_notes !== undefined) {
          patch.review_notes = body.review_notes === null ? null : String(body.review_notes);
        }
        if (Object.keys(patch).length === 0) {
          return sendJson(res, 400, { error: 'No fields to update' });
        }
        const { data, error } = await supabaseAdmin
          .from('creator_submissions')
          .update(patch)
          .eq('id', id)
          .select('*')
          .single();
        if (error) {
          throw Object.assign(new Error(error.message || 'Failed to update submission'), { statusCode: 500 });
        }
        return sendJson(res, 200, data);
      } catch (error) {
        return sendJson(res, error?.statusCode || 500, { error: error?.message || 'Failed to update submission' });
      }
    })();
    return;
  }

  // ── In-app feedback: submit (AUTHENTICATED) ──
  // The signed-in app user POSTs { rating: 'up'|'down'|null, text?, job_id?,
  // app_version? }. user_id is taken from the auth token, NEVER the client.
  if (parsed.pathname === '/api/feedback' && req.method === 'POST') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        const body = await readJsonBody(req);
        const v = validateFeedback(body || {});
        if (!v.ok) return sendJson(res, 400, { error: v.error });
        const { error } = await supabaseAdmin
          .from('app_feedback')
          .insert({
            user_id: user.id,
            rating: v.value.rating,
            text: v.value.text,
            job_id: v.value.job_id,
            app_version: v.value.app_version,
          });
        if (error) {
          throw Object.assign(new Error(error.message || 'Failed to save feedback'), { statusCode: 500 });
        }
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        return sendJson(res, error?.statusCode || 500, { error: error?.message || 'Failed to save feedback' });
      }
    })();
    return;
  }

  // ── Analytics events sink (fire-and-forget) ──
  // Receives the six client-emitted commerce events (paywall_view,
  // offerings_loaded, offerings_load_failed, purchase_attempt, purchase_error,
  // trial_start). This endpoint must NEVER block, slow, or fail the client:
  // it always responds 202 up front and does the insert best-effort, logging
  // (never surfacing) any failure. Anon-first — we store the RevenueCat
  // appUserID from the body, not the auth session, so an event lands even
  // before/without a Supabase token. See migrations/20260717_analytics_events.sql.
  // Health + deploy identity. `rev` is Render's injected commit SHA, so the
  // deploy-sanity pass can assert prod is running the commit we just pushed —
  // added after a blueprint-sync failure raised the question "is prod even
  // rolling new commits?" and nothing could answer it from outside.
  if (parsed.pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      rev: process.env.RENDER_GIT_COMMIT || null,
      // BUILD-GATE RECEIPT (TRUTH→DELIVERY request 2026-08-11): validate_deploy
      // writes .gate_receipt.json on success; we read it ONCE at boot and expose
      // it here beside rev. `null` is the load-bearing value — it PROVES the
      // build did NOT run the gate (Render blueprint-sync can silently keep an
      // old buildCommand; this converts the owner's build-log eyeball into a
      // curl). Shape: {passed, total, at} mirroring the receipt's
      // {smokes_passed, smokes_total, at}.
      gate: BOOT_GATE_RECEIPT,
      // npm postinstall marker (scripts/build-marker.js). Only meaningful when
      // `gate` is null, and then it is decisive: non-null here means npm install
      // ran and `node validate_deploy.js` did not — i.e. the live service is not
      // running render.yaml's buildCommand, so the 24 safety smokes are gating
      // nothing on Render. Both null means build writes never reach runtime.
      build: BOOT_BUILD_MARKER,
      // The ONE knob, effective value. Pre-auth clients read this to route the
      // onboarding: 'on' → wall onboarding (hook → quiz → wall), 'off' →
      // today's legacy flow, byte-for-byte. Same knob that drives the server
      // gates — flip once, both halves move together. Default 'off' on any
      // client fetch failure.
      // [§3.1/§6.1] LUMEN'S MASTER GATE, VISIBLE. generated_scenes fires 0/2,074
      // and the cause chain ends at a three-way AND (isPro && client asked &&
      // this flag). From outside the box the three were indistinguishable —
      // the discriminator lived only in a Render log line nobody can curl. It
      // is the same class as the build-gate receipt: an unanswerable question
      // that stayed unanswered because answering it required access. Now it is
      // a curl, for the owner and for me.
      premium_pipeline: premiumPipelineEnabled(),
      wall_enforcement: wallEnabled() ? 'on' : 'off',
      // Conversion item 1: the FIRST-LAUNCH dismissible paywall (iOS). A
      // SEPARATE knob from wall_enforcement (that one drives the server gates
      // and cannot be overloaded for a UI-only wall). Env-flipped, default
      // OFF; the client caches last-known and defaults dark on fetch failure.
      first_launch_paywall: String(process.env.FIRST_LAUNCH_PAYWALL || '') === '1' ? 'on' : 'off',
      // Conversion standing workstream (2026-08-22): three referral-surfacing
      // knobs, each its own flag so each ships/measures/kills independently.
      //   postrender_referral  — the delight-moment card after a finished video
      //   abandon_referral     — the second-chance referral on sheet-abandon
      //                          (two-step ask: the decline is the qualifier)
      //   ambient_wall_referral— the referral row on the manual/ambient wall
      //                          (88% of exposure, 0.2-0.3% buy — give the
      //                          curious a non-paying path)
      postrender_referral: String(process.env.POSTRENDER_REFERRAL || '') === '1' ? 'on' : 'off',
      abandon_referral: String(process.env.ABANDON_REFERRAL || '') === '1' ? 'on' : 'off',
      ambient_wall_referral: String(process.env.AMBIENT_WALL_REFERRAL || '') === '1' ? 'on' : 'off',
      postrender_save_cta: String(process.env.POSTRENDER_SAVE_CTA || '') === '1' ? 'on' : 'off',
      chat_media: String(process.env.CHAT_MEDIA || '') === '1' ? 'on' : 'off',
      // ARMED by default (ruled 2026-08-26 — the audit's #1 cliff, 1,611 users). Env can still disable with FIRST_SESSION_AUTOPICKER=0.
      first_session_autopicker: String(process.env.FIRST_SESSION_AUTOPICKER || '1') === '1' ? 'on' : 'off',
      yearly_frame_fix: String(process.env.YEARLY_FRAME_FIX || '') === '1' ? 'on' : 'off',
      // ARMED by default (shipped-today order 2026-08-27): a failed upload must tell the user when it's known. Env 0 disables.
      upload_fail_notify: String(process.env.UPLOAD_FAIL_NOTIFY || '1') === '1' ? 'on' : 'off',
      // Conversion build 2026-08-27 (post-235, coordinator-ordered): seven
      // surfaces around the moment of desire, EACH its own flag, default OFF —
      // arming order stays a ruling after 235's revenue-per-wall-view read.
      //   attribution_gate          — resurrected "how did you hear" question in the LIVE first-session path
      //   onboarding_v2             — <=4 screens, ends at the picker, content-type question feeds vibe prefill
      //   render_transparency       — stage-truthful progress feed during the render wait (never fake stages)
      //   exportgate_personalization— export gate shows the video's own thumbnail + named ask
      //   bad_render_suppressor     — thin/passthrough render => NO paywall at the gate
      //   annual_dollar_line        — "$X/wk billed annually — save $Y vs weekly", live StoreKit decimals, floored
      //   offer_surfacing           — StoreKit2 paid intro + iOS18 win-back rendering (display-only until ASC offers exist; NEVER a trial)
      //   push_primer               — post-first-delivery pre-permission primer; native prompt only on active tap
      attribution_gate: String(process.env.ATTRIBUTION_GATE || '') === '1' ? 'on' : 'off',
      onboarding_v2: String(process.env.ONBOARDING_V2 || '') === '1' ? 'on' : 'off',
      render_transparency: String(process.env.RENDER_TRANSPARENCY || '') === '1' ? 'on' : 'off',
      exportgate_personalization: String(process.env.EXPORTGATE_PERSONALIZATION || '') === '1' ? 'on' : 'off',
      bad_render_suppressor: String(process.env.BAD_RENDER_SUPPRESSOR || '') === '1' ? 'on' : 'off',
      annual_dollar_line: String(process.env.ANNUAL_DOLLAR_LINE || '') === '1' ? 'on' : 'off',
      offer_surfacing: String(process.env.OFFER_SURFACING || '') === '1' ? 'on' : 'off',
      push_primer: String(process.env.PUSH_PRIMER || '') === '1' ? 'on' : 'off',
      // Amendment 2026-08-27: the export gate as TWO pages (benefit case
      // written against the stated content type, then plans + price). Its own
      // flag so its contribution is readable separately.
      exportgate_two_page: String(process.env.EXPORTGATE_TWO_PAGE || '') === '1' ? 'on' : 'off',
      // Version awareness (client update prompts, server-driven so copy and
      // thresholds change WITHOUT a release):
      //   latest_version         — what's live on the App Store (soft banner
      //                            when the client is older; dismissible).
      //   min_supported_version  — floor for the FORCED update cover, armed
      //                            only when force_update='on' (broken-build
      //                            emergencies only; default OFF).
      //   update_notes           — one line of user-facing copy for the banner
      //                            (optional; client has a default).
      // All empty/off by default → the whole feature stays dark.
      latest_version: String(process.env.LATEST_APP_VERSION || ''),
      min_supported_version: String(process.env.MIN_SUPPORTED_APP_VERSION || ''),
      force_update: String(process.env.FORCE_UPDATE || '') === '1' ? 'on' : 'off',
      update_notes: String(process.env.UPDATE_NOTES || ''),
      // Conversion item 5: the onboarding RESULTS WALL — real renders, curated
      // server-side, swappable WITHOUT an app build (the stale-sample-demo
      // lesson, structurally). RESULTS_WALL_JSON is a JSON array of
      // {video_url, thumb_url}; unset/invalid → [] and the client skips the
      // beat entirely (auto-advance, never a blank wall).
      results_wall: (() => {
        try { const v = JSON.parse(process.env.RESULTS_WALL_JSON || '[]'); return Array.isArray(v) ? v : []; }
        catch { return []; }
      })(),
      posthog: process.env.POSTHOG_API_KEY ? 'configured' : 'dark',
      // Presence only (never the values) — the deploy-sanity readback drift-guard
      // asserts these so a "preserve current values" sweep that drops either
      // worker-auth secret is caught loudly instead of running open.
      modal_run_secret: !!process.env.MODAL_RUN_SECRET,
      modal_callback_secret: !!process.env.MODAL_CALLBACK_SECRET,
      // CDN SIGNING, PROVEN FROM INSIDE THE PROCESS (2026-08-23).
      //
      // "the env var is set" is NOT the question. cloudfront.js computes
      // signedMode from domain + KEY_PAIR_ID + a private key it must PARSE, and
      // Render's env editor is known to turn a multi-line PEM into \n-escaped
      // text. A malformed key leaves the vars present and the signer dead, and
      // the old code then returned a BARE, NON-EXPIRING CDN url that looked
      // exactly like a grant. My own guard read `cloudfront.signedMode` as
      // undefined and took that branch silently, so a boolean sourced from
      // env presence is not evidence.
      //
      // canSign actually RUNS the signer against a canary key and checks the
      // result carries a Signature. That is the difference between "configured"
      // and "working" — and with the exports prefix now behind
      // Restrict-viewer-access, a dead
      // signer means every paying user's export 403s.
      //
      // Booleans only. No URL, no key id, no expiry is exposed here.
      cloudfront: (() => {
        try {
          const cf = require('./services/cloudfront');
          let canSign = false;
          if (cf.signedMode) {
            const probe = cf.createSignedUrl('exports/__healthcheck__/probe.mp4', 60);
            canSign = typeof probe === 'string' && /[?&]Signature=/.test(probe);
          }
          const out = {
            enabled: !!cf.enabled,
            signedMode: !!cf.signedMode,
            unsignedMode: !!cf.unsignedMode,
            canSign,
            // TRUE means a key pair id IS configured and is not a key pair id
            // (2026-08-23: it was the public key PEM). Distinct from plain
            // unsigned mode, because this one is a live misconfiguration.
            keyPairIdMalformed: !!cf.keyPairIdMalformed,
          };
          // canSign proves WE can sign. It does NOT prove CloudFront ACCEPTS the
          // signature — that needs the key pair to be in the trusted key group
          // bound to the restricted behaviour, which is configured in the AWS
          // console, not here. Those are different failures with the same
          // symptom, and the second one 403s every paying user's export.
          //
          // ?cfcanary=1 returns a 60s signed URL for a key that DELIBERATELY DOES
          // NOT EXIST. Fetch it and the status is decisive:
          //   404 / NoSuchKey  -> signature ACCEPTED, CloudFront forwarded to S3
          //   403              -> signature REJECTED by the key group  (P0)
          // Nothing is leaked: the object is absent, the signature is scoped to
          // that exact URL, it dies in 60s, and Key-Pair-Id is public by
          // construction — it rides in every signed URL a client already gets.
          // Off by default so the default health payload stays a cheap boolean.
          // ?cfcanary=1 (exports) or ?cfcanary=<prefix> for any RESTRICTED
          // prefix. Every candidate is a hardcoded __healthcheck__ path under a
          // prefix we own, and every one DELIBERATELY DOES NOT EXIST, so the
          // probe can never mint a grant for real user data no matter what the
          // query string says. The allowlist is the security boundary — a
          // caller-supplied key here would be an open signing oracle.
          const CANARY = {
            exports: 'exports/__healthcheck__/probe.mp4',
            'chat-media': 'chat-media/__healthcheck__/probe.png',
            sources: 'sources/__healthcheck__/probe.mp4',
            'renders-private': 'renders-private/__healthcheck__/probe.mp4',
          };
          const want = String(parsed.query?.cfcanary || '');
          if (canSign && want) {
            const k = want === '1' ? CANARY.exports : CANARY[want];
            if (k) { out.canaryKey = k; out.canaryUrl = cf.createSignedUrl(k, 60); }
            else { out.canaryError = `unknown prefix; allowed: ${Object.keys(CANARY).join(', ')}`; }
          }
          return out;
        } catch (e) {
          return { error: String(e && e.message || e).slice(0, 120) };
        }
      })(),
    });
  }

  // (auth-ping endpoint lives above near the render-alert route — main added an
  // equivalent one; deduped here to a single handler.)

  if (parsed.pathname === '/api/events' && req.method === 'POST') {
    (async () => {
      let body = null;
      try {
        body = await readJsonBody(req);
      } catch (_) {
        body = null; // bad/oversized JSON — drop, but still 202 below
      }
      // Respond immediately. Analytics is never on the client's critical path.
      if (!res.headersSent) sendJson(res, 202, { ok: true });
      try {
        if (!body || typeof body.event !== 'string') return;
        const ALLOWED = new Set([
          'paywall_view', 'offerings_loaded', 'offerings_load_failed',
          'purchase_attempt', 'purchase_error', 'trial_start',
          // 1.1.7: funnel head for the re-edit conversion path. Paired with
          // paywall_view(reason:reedit) it measures the RACE-1 fix live —
          // free-user re-edit taps that reach a paywall view.
          'reedit_tap',
          // 1.2.0 registry — the wall onboarding + activation funnel (audit #1).
          // Same names flow to PostHog from the client dual-sink; this mirror
          // must accept them or the SQL half goes blind. subscription_* names
          // are deliberately ABSENT: transaction truth only enters via the
          // RevenueCat webhook mirror, never the open client endpoint.
          'onboarding_step', 'wall_view', 'trial_wall_start', 'trial_wall_bounce',
          'purchase_result', 'package_selected', 'restore_result',
          'app_open', 'signup_start', 'signup_complete',
          'first_render_start', 'render_complete', 'render_failed',
          'paywall_dismiss',
          // FREEMIUM funnels (2026-07-21). Discrete per-step events so each stage
          // is a PostHog funnel. render_started/completed and the RENDER-TIME
          // *_rejected fire SERVER-side (dispatch, authoritative) and never come
          // through here. The PRE-render content rejections DO come through here:
          // the client fires them at its on-device precheck + server sample-
          // validate, before any render is dispatched — allowlist them so the SQL
          // mirror gets the same events the client already sends to PostHog.
          // ONBOARDING:
          'language_selected', 'signup_completed', 'social_proof_viewed', 'onboarding_completed',
          // ACTIVATION (client half — server also fires render_* + render-time *_rejected):
          'upload_started', 'upload_completed', 'result_viewed',
          // Picker instrumentation (UNS/first-run BUILD(1)): picker_opened on every
          // present; picker_result {raw,resolved,dropped} on dismissal; and a durable
          // picker_asset_unresolved when a picked result resolves to no PHAsset (the
          // silent activation loss where a pick vanished with zero signal). Together
          // they split the 34% non-pickers into didn't-tap / cancelled / picked-but-
          // dropped. Allowlisted here AHEAD of the iOS build (dark until it ships) —
          // the __smoke_event_allowlist cert scans app-* branches, so the emitters on
          // app-uns-instrumentation already fail the deploy gate without this.
          'picker_opened', 'picker_result', 'picker_asset_unresolved',
          // Conversion build 2026-08-27 (post-235, seven flag-gated surfaces):
          // allowlisted on main BEFORE the branch emitters ship (standing law).
          'onboarding_v2_step', 'push_primer_viewed', 'push_primer_accepted',
          'push_primer_declined', 'annual_dollar_line_shown', 'offer_line_shown',
          'paywall_personalization_shown', 'paywall_suppressed_bad_render',
          'purchase_blocked_unidentified', 'render_transparency_viewed',
          'exportgate_benefit_viewed', 'exportgate_benefit_continue',
          // Referral program (conversion workstream; schema live 2026-08-21):
          // share-sheet open, ?ref= deep-link arrival, and client-observed claim.
          // Allowlisted AHEAD of the iOS build per the app-*-branch gate rule.
          'referral_share', 'referral_link_opened', 'referral_claimed',
          // Transport-error mirror (HTTPClientError diagnosis, 2026-08-22): the
          // iOS Sentry SDK auto-captures URLSession 5xx (enableCaptureFailedRequests
          // default-on) into a class we cannot query programmatically; this event
          // mirrors the SAME failures (upload part/PUT retries with status+conn)
          // into the SQL mirror where every read runs. Volume-bounded client-side.
          'upload_http_error',
          // Onboarding question answers (Q1 audience / Q2 intent / Q3
          // attribution). FIXES a live drift: the client emitted these via
          // NON-LITERAL names (OnboardingQuestion.X.event) invisible to the
          // gate's regex AND absent here — the SQL mirror silently dropped
          // them while PostHog kept them. The 3-question rework emits them as
          // literals; allowlisted so the mirror finally keeps the answers.
          'onboarding_audience', 'onboarding_intent', 'onboarding_attribution',
          // upload_attempt (1.3.7/225): durable {size_mb, path, src_key} fired at
          // upload START so the failing (never-settled) population has a SIZE to
          // band UNS by. Emitted on app-1.3.3; allowlisted here so the SQL mirror
          // keeps it (PostHog does regardless).
          'upload_attempt',
          'not_talking_head_rejected', 'no_speech_rejected', 'no_audio_rejected',
          // 2026-08-02 — the SPLIT names. `not_talking_head_rejected` fires with
          // props.proceeded:true on 68 of 109 events (62%): an event whose name
          // ends in "_rejected" describes a NON-rejection most of the time. That
          // naming produced a false 35.9% corrected-completion figure by counting
          // 68 warnings as blocks. Server-side normalisation below rewrites the
          // legacy name using props.proceeded, so the split works with the
          // CURRENT client and no app release; these are allowlisted so a future
          // client can also send them directly.
          'not_talking_head_warned', 'not_talking_head_blocked',
          // 1.3.1 on-device pre-checks (audio/duration) + push soft-prompt. Without
          // these on the allowlist the SQL mirror silently drops them (the same
          // class that bit not_talking_head_rejected); PostHog gets them regardless.
          'too_short_rejected', 'too_long_rejected', 'push_softprompt',
          // 1.3.4 (222) instruments — the upload/no-token blind spots + true
          // activation. MUST be here or the SQL mirror (the DB our upload/no-token
          // analysis queries) drops them while PostHog keeps them — half-blind.
          'upload_failed', 'export_completed', 'push_permission',
          // 1.3.4 in-app ready-state card (returning-user recovery funnel):
          'ready_banner_shown', 'ready_banner_open', 'ready_banner_dismiss',
          // Billing-identity hardening (blocked-pre-identity + RC identify diagnostics):
          'purchase_blocked_unidentified', 'rc_identify_failed', 'rc_identify_mismatch',
          // In-app-browser escape (web landing /get). Meta/TikTok webviews swallow
          // App Store taps; these size the problem + measure the breakout funnel.
          'inapp_landing', 'escape_attempted', 'escape_succeeded',
          'escape_fallback_shown', 'fallback_retry', 'fallback_copy',
          // UPGRADE:
          'free_limit_hit', 'upgrade_wall_viewed', 'plan_selected',
          'purchase_started', 'purchase_completed', 'purchase_failed',
          // RETENTION:
          'session_started',
          'save_cta_shown',
        ]);
        if (!ALLOWED.has(body.event)) {
          console.warn(`[events] dropped unknown event=${String(body.event).slice(0, 40)}`);
          return;
        }
        // Cheap abuse guard on an open endpoint — generous, drops silently
        // (never 429s the client, which ignores the response anyway).
        const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || (req.socket && req.socket.remoteAddress) || 'unknown';
        if (!_consumeRateToken('events', ip, 600, 300).ok) return; // 600 / 5 min / IP
        const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
        const props = (body.props && typeof body.props === 'object' && !Array.isArray(body.props))
          ? body.props : {};
        // Event-name normalisation + Rule-7 actor resolution. See
        // lib/analytics-normalize.js for the full why; pinned by
        // lib/__smoke_analytics_normalize.js.
        const _an = require('./lib/analytics-normalize');
        const _event = _an.normalizeEventName(body.event, body.props);
        const _anon = str(body.anon_user_id, 128);
        const row = {
          event: _event,
          user_id: _an.resolveUserId(_anon),
          anon_user_id: _anon,
          territory: str(body.territory, 8),
          storefront: str(body.storefront, 64),
          app_version: str(body.app_version, 32),
          platform: str(body.platform, 16) || 'ios',
          props,
        };
        const { error } = await supabaseAdmin.from('analytics_events').insert(row);
        if (error) console.warn(`[events] insert failed event=${row.event}: ${error.message}`);
        // Lifecycle email — WELCOME on signup completion (after OTP verify). The
        // client's distinct_id == the Supabase user.id for a signed-in user, so
        // anon_user_id resolves the auth email. Fail-soft + idempotent per user;
        // never blocks the (already-202'd) analytics path.
        if (row.event === 'signup_completed' && row.anon_user_id) {
          require('./lib/email').sendWelcomeEmail(supabaseAdmin, row.anon_user_id)
            .catch((e) => console.warn('[email] welcome trigger failed:', e && e.message));
        }
      } catch (e) {
        console.warn(`[events] handler error: ${e && e.message ? e.message : e}`);
      }
    })();
    return;
  }

  // ── In-app feedback: list all (ADMIN) ──
  // Owner-gated by the same allowlist as the submission review dashboard.
  if (parsed.pathname === '/api/admin/feedback' && req.method === 'GET') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        if (!isAuthorizedSubmissionReviewer(user)) {
          return sendJson(res, 403, { error: 'Forbidden' });
        }
        const { data, error } = await supabaseAdmin
          .from('app_feedback')
          .select('*')
          .order('created_at', { ascending: false });
        if (error) {
          throw Object.assign(new Error(error.message || 'Failed to load feedback'), { statusCode: 500 });
        }
        return sendJson(res, 200, { feedback: data || [] });
      } catch (error) {
        return sendJson(res, error?.statusCode || 500, { error: error?.message || 'Failed to load feedback' });
      }
    })();
    return;
  }

  // ── Gemini Chat Proxy ──
  // Single source of truth for the chat persona. Both /api/chat and
  // /api/chat/stream reference this so the streaming and fallback paths
  // can't drift. Anchored in WHAT Promptly actually is — without this
  // the model invents a fake "stock library + AI scene generation"
  // pipeline when asked how it works.
  // eslint-disable-next-line no-inner-declarations
  function promptlyChatSystemPrompt() {
    return [
      'You are Promptly, the in-app assistant inside the Promptly iOS app.',
      '',
      'WHAT PROMPTLY IS (USER-FACING):',
      "- An AI video editor for short-form vertical content (TikTok, Reels, YouTube Shorts).",
      "- The user uploads their own talking-head iPhone clip and gives a 'vibe' — a short prompt describing the style they want (e.g. 'viral hype', 'storytime', 'founder POV'). Promptly returns an edited vertical video ready to post.",
      "- Edits typically finish in under a minute.",
      "- Users can ask for changes to a finished video in chat — the Re-edit feature — without re-uploading.",
      "- iOS only.",
      '',
      'WHAT PROMPTLY ADDS TO THE EDIT:',
      "- Auto-captions in one of 20 styles, matched to the requested vibe",
      "- Cuts out filler words ('um', 'uh') and dead air",
      "- Zoom effects on key lines",
      "- Transitions between cuts",
      "- Motion graphics (on-screen callouts, animated text)",
      "- B-roll cutaways that visualize what the speaker is saying",
      "- Sound effects placed on the beats that need them",
      '',
      'WHAT PROMPTLY DOES NOT DO:',
      "- Does NOT add background music. Users should add music in TikTok/Reels/YouTube when they post — better for trending sounds and copyright safety.",
      "- Does NOT change pacing (no speed ramps).",
      "- Does NOT generate AI voiceovers or synthetic talking heads. Works only with the user's own uploaded clip.",
      '',
      'HOW TO ANSWER:',
      "- YOUR IDENTITY: You are Promptly's own editing AI. If asked what you are, what model or technology you run on, who built or trains you, or whether you are ChatGPT/Gemini/Claude/an LLM — you are Promptly's AI, built by the Promptly team. NEVER say Gemini, Google, OpenAI, Anthropic, GPT, or any model or vendor name, and never call yourself 'a large language model.' Saying you are another company's model in a paid product is wrong. Deflect warmly to what you help with: editing their video.",
      "- NEVER reveal implementation details, internal architecture, specific AI models, libraries, services, vendors, file formats, or step-by-step pipeline internals. That's proprietary.",
      "- If someone asks 'how does it work' or 'what are the steps' or 'why does it take so long,' answer at a HIGH LEVEL only: 'I analyze your clip, figure out the best edit for the vibe you asked for, and render the result.' Do not name technologies. Do not list numbered pipeline steps.",
      "- You CAN list the user-facing features above when asked what the app does — those are public and marketed.",
      "- Be honest. If you don't know something specific, say so — don't invent details.",
      '- Keep replies short and chat-shaped. 1–3 short paragraphs. Numbered lists only when the user explicitly asks for steps AND the question is user-facing (e.g. how to upload).',
      '- Friendly, direct, no marketing fluff. No emojis unless the user uses them first.',
    ].join('\n');
  }

  // LANE-SEAM Step 4 mount (one line, specified by routes/chat-actions.js and
  // applied by TRUTH). DARK behind PROMPTLY_CHAT_ACTIONS — unset ⇒ the handler
  // 404s, so the route does not exist as far as any client can tell.
  if (parsed.pathname === '/api/chat/actions' && req.method === 'POST') return require('./routes/chat-actions').handle(req, res, { requireSupabaseUser, readJsonBody, sendJson, supabaseAdmin, checkRateLimit, PORT });

  // ── POST /api/chat/media-resolve ─────────────────────────────────────────
  // {key} → {url, expiresIn}. The read half of the reference contract.
  //
  // Stored chat messages carry {kind, mime, key} and NEVER a URL, so nothing in
  // a transcript can expire. The client calls this when it is about to display
  // an image and again whenever a previously-resolved URL goes stale. That is
  // the whole reason the wire shape is a key: there is no server writer for
  // chats.messages (the client PATCHes it under RLS, and the one server writer
  // CASes on updated_at after a lost update cost 180 completions), so a URL
  // baked into a stored message could never be refreshed by us.
  //
  // Authorisation is the parse: assertOwnedKey compares the user id embedded in
  // the key against the caller. No DB read, no join, nothing to forget.
  if (parsed.pathname === '/api/chat/media-resolve' && req.method === 'POST') {
    (async () => {
      try {
        const authUser = await requireSupabaseUser(req);
        if (!checkRateLimit(res, 'chat-media-resolve', authUser.id, 120, 60)) return;
        const body = await readJsonBody(req).catch(() => ({}));
        const cm = require('./lib/chat-media');
        const s3 = require('./services/s3');
        if (!s3.isConfigured()) return sendJson(res, 500, { error: 'Storage not configured' });

        let key;
        try {
          key = cm.assertOwnedKey(authUser.id, body && body.key);
        } catch (e) {
          // 403 for someone else's key, and 403 for a malformed one — the two
          // must not be distinguishable, or this becomes an oracle for probing
          // which keys exist.
          return sendJson(res, 403, { error: 'forbidden_key' });
        }

        // 404 before minting: a URL for an absent object would 403 at the CDN
        // later and read to the client as an auth failure. objectExists returns
        // null when it cannot tell (no ListBucket) — treat that as present and
        // let the fetch decide, rather than hiding a real image.
        const exists = await s3.objectExists(key);
        if (exists === false) return sendJson(res, 404, { error: 'not_found' });

        // 1 hour. Long enough to render a conversation, short enough that a
        // leaked URL dies quickly — and re-resolve makes expiry a non-event.
        const expiresIn = 3600;
        const url = await s3.createPresignedGetUrl(key, expiresIn);
        return sendJson(res, 200, { url, expiresIn, key });
      } catch (error) {
        return sendJson(res, error?.statusCode || 500, { error: clientSafeMessage(error) });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/chat' && req.method === 'POST') {
    (async () => {
      try {
        const authUser = await requireSupabaseUser(req);
        const body = await readJsonBody(req);
        const message = String(body?.message || '').trim();
        // §1: a message may be images ALONE. Requiring text would make "what is
        // this?" with a photo attached a 400 — the single most obvious thing a
        // user does with an image, rejected by the boundary.
        const _cm = require('./lib/chat-media');
        let inboundMedia;
        try {
          inboundMedia = _cm.parseInboundMedia(authUser.id, body?.media);
        } catch (e) {
          return sendJson(res, e.statusCode || 400, { error: e.message, ...(e.detail || {}) });
        }
        if (!message && !inboundMedia.length) {
          return sendJson(res, 400, { error: 'Message is required' });
        }

        // ── Class 1: trivial input (a bare comma, "...", stray character) ──
        // Never reaches Gemini, never burns quota, never becomes a render.
        // Skipped when media rides along: "?" beside a photo is a real question.
        if (!inboundMedia.length && isTrivialMessage(message)) {
          return sendJson(res, 200, { reply: TRIVIAL_REPLY });
        }

        // Most recent job (last 2h) — powers the status fast-path AND grounds
        // the LLM's system prompt. One indexed read; null when none.
        let recentJob = null;
        if (supabaseAdmin) {
          try {
            const { data: jobs } = await supabaseAdmin
              .from('video_jobs')
              .select('id, status, progress, current_step, updated_at, error_message')
              .eq('user_id', authUser.id)
              .gte('updated_at', new Date(Date.now() - 2 * 3600 * 1000).toISOString())
              .order('updated_at', { ascending: false })
              .limit(1);
            recentJob = Array.isArray(jobs) ? jobs[0] || null : null;
          } catch (e) { /* context is best-effort; chat still answers */ }
        }

        // ── Class 2: status questions → deterministic answer from the row ──
        // No LLM, no quota: stage name + honest typical duration + freshness.
        // Also skipped with media: "how's it going?" beside a screenshot is
        // asking about the picture, and the canned status reply would ignore it.
        if (!inboundMedia.length && isStatusQuestion(message)) {
          const answer = statusAnswerFromJob(recentJob);
          if (answer) return sendJson(res, 200, { reply: answer });
          // No job to talk about → fall through to the conversational LLM.
        }

        // Chat door (wall N+1). Knob OFF (default) → byte-for-byte today: any
        // Pro entitlement (trial or paid) bypasses, free counts against 50/day.
        // Knob ON → enforced `.none` gets the wall (403); trial keeps 50/day
        // then routes to the paywall (402).
        const chatEnt = await assertProEntitled(authUser.id, { forceRcCheck: wallForceRcCheck(req) });
        const chatTier = tierFromEntitlement(chatEnt);
        const chatEnforce = resolveEnforce({
          headers: req.headers,
          accountCreatedAt: (chatEnt.row || {}).created_at,
        });
        const chatCaps = capabilities(effectiveTier(chatTier, chatEnforce));
        // Count only when the tier is actually capped — an unlimited tier skips
        // the read, exactly like today's isPro bypass.
        const todayChats = chatCaps.chatLimit === Infinity
          ? 0 : await countTodayUsage(authUser.id, 'chat');
        const chatGate = gateDecision({ tier: chatTier, kind: 'chat', todayCount: todayChats, enforce: chatEnforce });
        if (!chatGate.allow) {
          if (chatGate.route === 'wall') {
            console.log('  [wall] 403 wall_required (chat) userId=%s tier=%s', authUser.id, chatTier);
            return sendJson(res, 403, { error: 'wall_required', route: 'wall', message: wallRequiredMessage() });
          }
          return sendJson(res, 402, {
            error: 'daily_limit_reached',
            kind: 'chat',
            route: 'paywall',
            limit: chatCaps.chatLimit,
            message: `You've used your ${chatCaps.chatLimit} free chat messages today. Upgrade to Pro for unlimited.`,
          });
        }

        const history = Array.isArray(body?.history) ? body.history : [];
        // Trim: a key pasted into the Render dashboard with a trailing newline
        // is sent verbatim in the x-goog-api-key header → Gemini 401 → chat 502,
        // indistinguishable from a wrong key. Same class as MODAL_CALLBACK_SECRET
        // (e6f9a74). No-op on a clean value.
        const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
        if (!geminiKey) return sendJson(res, 500, { error: 'Chat not configured' });

        // Build Gemini request
        const contents = [];

        const jobCtx = jobContextLine(recentJob);
        const systemPrompt = promptlyChatSystemPrompt() + (jobCtx ? `\n\n${jobCtx}` : '');

        // Add conversation history
        for (const h of history.slice(-18)) {
          if (h.role === 'user' || h.role === 'assistant') {
            contents.push({
              role: h.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: h.content }],
            });
          }
        }

        // Add current message. Image parts come FIRST: Gemini grounds better
        // when the referent precedes the question, and it makes a text-free
        // attachment message ("<image>") a valid turn rather than an empty one.
        let _inlineParts = [];
        try {
          _inlineParts = await _cm.inlinePartsForGemini(require('./services/s3'), inboundMedia);
        } catch (e) {
          return sendJson(res, e.statusCode || 502, {
            error: e.statusCode === 413 ? 'media_too_large' : 'media_unreadable',
            ...(e.detail || {}),
          });
        }
        const _userParts = [..._inlineParts];
        if (message) _userParts.push({ text: message });
        contents.push({ role: 'user', parts: _userParts });

        // Flash model for the chat path. The pro/preview model burns
        // 5-15s on simple replies — fine for the analysis pipeline,
        // unacceptable for an in-app chat where the value of an AI reply
        // is its instant feel. 2.5-flash returns in ~500-1500ms with
        // identical helpfulness for short mobile-chat answers.
        const _chatUrl = `https://generativelanguage.googleapis.com/v1beta/models/${CHAT_MODEL}:generateContent`;
        // AQ-format keys are rejected on ?key= (ACCESS_TOKEN_TYPE_UNSUPPORTED)
        // and MUST travel in the x-goog-api-key header. Never send both — a
        // query key + header triggers "Multiple authentication credentials".
        const _chatInit = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: systemPrompt }] },
              contents,
              generationConfig: {
                // 1024 leaves headroom for "explain the pipeline" style
                // questions without clipping mid-sentence. The system
                // prompt holds replies short by default.
                // Raised to 2048: gemini-flash-latest points to a thinking model
                // (thinkingBudget:0 was rejected as INVALID_ARGUMENT — that param
                // is what kept chat 502 after the model swap). Default thinking
                // consumes output tokens, so give headroom for thinking + a full
                // reply; the system prompt still holds replies short.
                maxOutputTokens: 2048,
                temperature: 0.8,
              },
            }),
          };
        const _rr = await fetchGeminiWithTransientRetry(_chatUrl, _chatInit,
          { route: '/api/chat', model: CHAT_MODEL, userId: authUser && authUser.id });
        const geminiRes = _rr.res;

        if (!geminiRes.ok) {
          const errText = _rr.firstBody || '';
          console.error('[Chat] Gemini error:', geminiRes.status, errText);
          // PERSIST THE QUOTA STORY, don't just log it. The ledger recorded
          // `{code:502}` and nothing else, so "which quota, at what limit"
          // required catching a Render log line before it scrolled. The 429
          // body carries a structured QuotaFailure; throwing it away is what
          // made this take a day.
          await recordQuotaFailure(supabaseAdmin, {
            route: '/api/chat', httpStatus: geminiRes.status, bodyText: errText,
            userId: authUser && authUser.id, model: CHAT_MODEL,
          }).catch(() => {});
          return sendJson(res, 502, { error: 'AI service error' });
        }

        const geminiData = await geminiRes.json();
        // Walk ALL parts, not parts[0]. Two defects fixed here:
        //   (a) LIVE TODAY: a thinking model emits a THOUGHT part alongside the
        //       answer. If the thought lands at parts[0] the answer is dropped
        //       and a good reply becomes 502 empty_ai_reply. The STREAMING path
        //       already fixed this ("reading only parts[0] would drop the
        //       answer"); the one-shot path never got it. Same filter, so the
        //       two entrances cannot drift again.
        //   (b) "empty" meant "no text", making an image-only reply an error by
        //       construction and blocking every later multimodal part.
        const { decodeChatCandidate, isEmptyReply } = require('./lib/chat-reply');
        const decoded = decodeChatCandidate(geminiData?.candidates?.[0]);
        const reply = decoded.text;
        // Decode gate (server half): an empty candidate (safety block, model
        // hiccup) must be an ERROR, never a 200 with a blank reply — the
        // client's retry handler needs a throw to fire. EMPTY now means neither
        // text NOR attachment; a thought-only candidate is counted separately
        // so it stops hiding inside one opaque 502.
        if (isEmptyReply(decoded)) {
          console.error(`[Chat] Gemini returned an empty candidate`
            + `${decoded.thoughtOnly ? ' (thought-only — model reasoned but never answered)' : ''}`);
          return sendJson(res, 502, { error: 'empty_ai_reply' });
        }

        // Log usage AFTER a successful AI hit. Counts AI-reaching messages
        // only — burning a chat message that errored out shouldn't deplete
        // the user's daily quota.
        await logUsageEvent(authUser.id, 'chat');

        // §1 outbound: model-generated images are persisted to the PRIVATE
        // prefix and returned as {kind, mime, key} — never a base64 blob. The
        // client re-resolves the key via /api/chat/media-resolve on read, so a
        // stored transcript holds nothing that can expire.
        const attachments = await _cm.persistGeneratedAttachments(
          require('./services/s3'), authUser.id, decoded.attachments,
          (e) => console.error('[Chat] attachment persist failed:', e?.message)
        );
        // `attachments` is omitted entirely when empty rather than sent as [],
        // so an older client that has never seen the field is byte-unaffected.
        return sendJson(res, 200, attachments.length ? { reply, attachments } : { reply });
      } catch (error) {
        console.error('[Chat] Error:', error);
        return sendJson(res, error?.statusCode || 500, { error: error?.message || 'Chat error' });
      }
    })();
    return;
  }

  // ── Streaming chat ─────────────────────────────────────────────────
  // SSE-streamed Gemini response. Same model + system prompt as /api/chat
  // but uses streamGenerateContent so iOS can render tokens as they
  // arrive — the "feels like ChatGPT" path. Falls back to one-shot via
  // /api/chat if the client doesn't support streaming.
  if (parsed.pathname === '/api/chat/stream' && req.method === 'POST') {
    (async () => {
      try {
        const streamUser = await requireSupabaseUser(req);
        const body = await readJsonBody(req);
        const message = String(body?.message || '').trim();
        // §1: identical media handling to /api/chat. The client tries THIS
        // endpoint first, so a boundary enforced only on the one-shot path
        // would be enforced on the path almost nobody takes.
        const _cmS = require('./lib/chat-media');
        let streamMedia;
        try {
          streamMedia = _cmS.parseInboundMedia(streamUser.id, body?.media);
        } catch (e) {
          return sendJson(res, e.statusCode || 400, { error: e.message, ...(e.detail || {}) });
        }
        if (!message && !streamMedia.length) {
          return sendJson(res, 400, { error: 'Message is required' });
        }

        // Router classes 1+2 (same as /api/chat — the client tries THIS
        // endpoint first, so the gates must live here too). Canned replies
        // stream as a single token frame: no Gemini, no quota burn.
        const emitCanned = (reply) => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          });
          res.write(`data: ${JSON.stringify({ token: reply })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        };
        // Media present → never canned. See /api/chat for the reasoning.
        if (!streamMedia.length && isTrivialMessage(message)) return emitCanned(TRIVIAL_REPLY);

        let streamRecentJob = null;
        if (supabaseAdmin) {
          try {
            const { data: jobs } = await supabaseAdmin
              .from('video_jobs')
              .select('id, status, progress, current_step, updated_at, error_message')
              .eq('user_id', streamUser.id)
              .gte('updated_at', new Date(Date.now() - 2 * 3600 * 1000).toISOString())
              .order('updated_at', { ascending: false })
              .limit(1);
            streamRecentJob = Array.isArray(jobs) ? jobs[0] || null : null;
          } catch (e) { /* best-effort */ }
        }
        if (!streamMedia.length && isStatusQuestion(message)) {
          const answer = statusAnswerFromJob(streamRecentJob);
          if (answer) return emitCanned(answer);
        }

        // Chat door (wall N+1) — stream twin of the /api/chat gate above; the
        // same decision core, so the two entrances can never disagree.
        const streamEnt = await assertProEntitled(streamUser.id, { forceRcCheck: wallForceRcCheck(req) });
        const streamTier = tierFromEntitlement(streamEnt);
        const streamEnforce = resolveEnforce({
          headers: req.headers,
          accountCreatedAt: (streamEnt.row || {}).created_at,
        });
        const streamCaps = capabilities(effectiveTier(streamTier, streamEnforce));
        const streamTodayChats = streamCaps.chatLimit === Infinity
          ? 0 : await countTodayUsage(streamUser.id, 'chat');
        const streamGate = gateDecision({ tier: streamTier, kind: 'chat', todayCount: streamTodayChats, enforce: streamEnforce });
        if (!streamGate.allow) {
          if (streamGate.route === 'wall') {
            console.log('  [wall] 403 wall_required (chat-stream) userId=%s tier=%s', streamUser.id, streamTier);
            return sendJson(res, 403, { error: 'wall_required', route: 'wall', message: wallRequiredMessage() });
          }
          return sendJson(res, 402, {
            error: 'daily_limit_reached',
            kind: 'chat',
            route: 'paywall',
            limit: streamCaps.chatLimit,
            message: `You've used your ${streamCaps.chatLimit} free chat messages today. Upgrade to Pro for unlimited.`,
          });
        }

        const history = Array.isArray(body?.history) ? body.history : [];
        // Trim: a key pasted into the Render dashboard with a trailing newline
        // is sent verbatim in the x-goog-api-key header → Gemini 401 → chat 502,
        // indistinguishable from a wrong key. Same class as MODAL_CALLBACK_SECRET
        // (e6f9a74). No-op on a clean value.
        const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
        if (!geminiKey) return sendJson(res, 500, { error: 'Chat not configured' });

        // Build Gemini contents (same shape as /api/chat).
        const streamJobCtx = jobContextLine(streamRecentJob);
        const systemPrompt = promptlyChatSystemPrompt() + (streamJobCtx ? `\n\n${streamJobCtx}` : '');
        const contents = [];
        for (const h of history.slice(-18)) {
          if (h.role === 'user' || h.role === 'assistant') {
            contents.push({
              role: h.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: h.content }],
            });
          }
        }
        // Images first, then text — same ordering as /api/chat. Resolved BEFORE
        // the SSE headers go out: an unreadable or oversized image must be a
        // clean typed JSON error, and once `res.writeHead` has fired the only
        // way left to report it is an error frame the client may not surface.
        let _sInline = [];
        try {
          _sInline = await _cmS.inlinePartsForGemini(require('./services/s3'), streamMedia);
        } catch (e) {
          return sendJson(res, e.statusCode || 502, {
            error: e.statusCode === 413 ? 'media_too_large' : 'media_unreadable',
            ...(e.detail || {}),
          });
        }
        const _sParts = [..._sInline];
        if (message) _sParts.push({ text: message });
        contents.push({ role: 'user', parts: _sParts });

        // Open SSE response stream to the client BEFORE we hit Gemini —
        // a slow connection from us to Gemini shouldn't delay the
        // headers, and iOS's stream consumer wants to know the response
        // is alive ASAP.
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        // Initial padding so any proxy in the path flushes immediately.
        res.write(': stream-open\n\n');

        // Gemini streaming endpoint. alt=sse makes the response a true
        // SSE byte stream we can pipe through; without it Gemini returns
        // a JSON array we'd have to buffer.
        // Key travels in the x-goog-api-key header, not ?key= (AQ keys are
        // rejected on the query param). Keep ?alt=sse; drop &key= entirely.
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${CHAT_MODEL}:streamGenerateContent?alt=sse`;
        const _streamInit = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: {
              // Streaming can afford a generous cap — tokens flow as
              // they generate, so a long answer doesn't feel slow. The
              // system prompt still anchors replies to chat-shaped.
              maxOutputTokens: 2048,
              temperature: 0.8,
              // No thinkingConfig: gemini-flash-latest rejects thinkingBudget:0
              // (INVALID_ARGUMENT). Default thinking is fine here.
            },
          }),
        };

        // RETRY BEFORE ANY DATA FRAME. `: stream-open` has been written, but no
        // token frame has — so a retried upstream is invisible to the client.
        // Once a token is emitted this would no longer be safe.
        const _sr = await fetchGeminiWithTransientRetry(geminiUrl, _streamInit,
          { route: '/api/chat/stream', model: CHAT_MODEL,
            userId: streamUser && streamUser.id });
        const geminiRes = _sr.res;

        if (!geminiRes.ok || !geminiRes.body) {
          const errText = _sr.firstBody || '';
          console.error('[ChatStream] Gemini error:', geminiRes.status, errText);
          // Same persistence as /api/chat — BOTH surfaces 429 at 100%, so
          // instrumenting only one would leave half the evidence in a log.
          await recordQuotaFailure(supabaseAdmin, {
            route: '/api/chat/stream', httpStatus: geminiRes.status, bodyText: errText,
            userId: streamUser && streamUser.id, model: CHAT_MODEL,
          }).catch(() => {});
          res.write(`data: ${JSON.stringify({ error: 'AI service error' })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }

        // Stream Gemini's SSE through to the client. Gemini emits
        // `data: {json}\n\n` frames; we extract the token text and
        // re-emit `data: {"token":"..."}\n\n` so the client doesn't
        // need to know Gemini's response shape.
        const decoder = new TextDecoder();
        let buffer = '';
        // Generated image parts, accumulated across frames and persisted once
        // the stream drains (see the attachments frame below [DONE]).
        const _streamInlineAtts = [];
        const reader = geminiRes.body.getReader();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Normalize CRLF → LF. gemini-flash-latest (now gemini-3.6-flash)
          // streams SSE frames separated by \r\n\r\n; the \n\n split below never
          // matches inside \r\n\r\n, so the handler found NO frame boundaries and
          // emitted ZERO tokens — silently falling back to the one-shot
          // (all-at-once, the text-message feel). This one normalization is the
          // whole streaming fix.
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          // SSE frames are separated by \n\n.
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
            if (!dataLine) continue;
            const json = dataLine.slice(6);
            try {
              const parsed = JSON.parse(json);
              // Concatenate text across ALL non-thought parts: a thinking model
              // can emit a thought part alongside the visible-answer text part in
              // the same frame, and reading only parts[0] would drop the answer.
              const parts = parsed?.candidates?.[0]?.content?.parts || [];
              const token = parts
                .filter(p => p && typeof p.text === 'string' && !p.thought)
                .map(p => p.text)
                .join('');
              if (token) {
                res.write(`data: ${JSON.stringify({ token })}\n\n`);
              }
              // §1: collect generated image parts as they stream. They are NOT
              // emitted inline — a base64 blob in an SSE frame would be
              // megabytes on the wire and unusable in a stored transcript. They
              // are persisted after the stream drains and announced as keys.
              for (const p of parts) {
                if (!p || p.thought) continue;
                const inline = p.inlineData || p.inline_data;
                if (inline && inline.data) _streamInlineAtts.push(inline);
              }
            } catch {
              // Non-JSON frame (keep-alive comment, etc) — ignore.
            }
          }
        }
        // Log usage BEFORE writing the closing [DONE] frame. Previously
        // we logged after res.end(), which meant a client disconnect
        // mid-stream skipped the increment — a determined free user
        // could abort every stream after one token and never burn quota.
        // Counts the message regardless of how many tokens actually
        // streamed; even a one-token reply used the quota.
        try {
          await logUsageEvent(streamUser.id, 'chat');
        } catch (logErr) {
          console.error('[ChatStream] usage log failed — surfacing 503 mid-stream',
            { userId: streamUser.id, error: logErr?.message });
          // The Gemini reply already streamed; we cannot pull it back.
          // Surface the failure to the client so they retry and the
          // counter remains accurate. Better than letting an outage
          // disable the cap.
          res.write(`data: ${JSON.stringify({ error: 'usage_log_failed' })}\n\n`);
        }
        // §1: the attachments frame — LAST data frame, immediately before
        // [DONE]. Persisting to S3 takes a round trip per image, so doing it
        // inline during the stream would stall token delivery; doing it here
        // costs the user nothing they can perceive because the text has already
        // rendered. Shape matches /api/chat exactly: {kind, mime, key}.
        // Emitted only when non-empty, so a client that ignores the frame is
        // byte-unaffected.
        try {
          const streamAtts = await _cmS.persistGeneratedAttachments(
            require('./services/s3'), streamUser.id, _streamInlineAtts,
            (e) => console.error('[ChatStream] attachment persist failed:', e?.message)
          );
          if (streamAtts.length) {
            res.write(`data: ${JSON.stringify({ attachments: streamAtts })}\n\n`);
          }
        } catch (attErr) {
          // Never fatal: the text reply already streamed and is the answer.
          console.error('[ChatStream] attachment stage failed:', attErr?.message);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (error) {
        console.error('[ChatStream] Error:', error);
        try {
          res.write(`data: ${JSON.stringify({ error: error?.message || 'Chat error' })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } catch { /* connection probably already closed */ }
      }
    })();
    return;
  }

  // ── Prewarm ─────────────────────────────────────────────────────────
  // iOS calls this the instant a client-side S3 upload completes (well
  // before the user taps Send). Fire-and-forget to Modal's /prewarm
  // endpoint, which pulls the source video into its persistent Volume
  // cache. When the real /api/video-jobs arrives, the Modal worker
  // finds the file already present and skips the S3 download step
  // entirely — eliminating the "Loading your footage" latency.
  //
  // Returns 202 immediately without waiting for the Modal prewarm to
  // finish. The prewarm is a latency hedge; if it fails, the real job
  // ── Daily usage + Pro status ──
  // Single endpoint the iOS client polls on app foreground + after each
  // gated action. Returns the user's current counts vs limits and Pro
  // entitlement. iOS uses this to render the usage badge AND to know
  // when to surface the paywall preemptively (e.g., at 2/3 renders).
  if (parsed.pathname === '/api/usage' && req.method === 'GET') {
    (async () => {
      try {
        const u = await requireSupabaseUser(req);
        const ent = await assertProEntitled(u.id);
        const [renders, chats] = await Promise.all([
          countTodayUsage(u.id, 'render'),
          countTodayUsage(u.id, 'chat'),
        ]);
        // proUntil — when the current entitlement expires (trial end or
        // renewal date). Read straight from profiles so the client can
        // show a friendly "Trial ends Mar 5" line.
        let proUntil = null;
        let rawTier = ent.isPro ? 'paid' : 'none';
        let createdAt = null;
        if (supabaseAdmin) {
          const { data } = await supabaseAdmin
            .from('profiles')
            .select('tier, comp_pro, pro_until, rc_period_type, rc_app_user_id, created_at')
            .eq('id', u.id)
            .maybeSingle();
          proUntil = data?.pro_until || null;
          createdAt = data?.created_at || null;
          rawTier = tierFromEntitlement({ ...ent, row: data || ent.row });
          if (unknownPeriodPaid(data)) {
            console.warn('[entitlement.edge] active_paid_missing_period', { rc_linked: true });
          }
        }
        // EFFECTIVE tier — what the user ACTUALLY gets, computed the same way the
        // gates do (freemium when the knob is on, legacy when off). New clients
        // read `tier` ('free' 1/day vs 'paid'); is_pro still drives unlimited.
        const usageEnforce = resolveEnforce({
          headers: req.headers,
          accountCreatedAt: createdAt,
        });
        const effTier = effectiveTier(rawTier, usageEnforce);
        // render_limit / chat_limit stay the NON-PRO free cap as a non-null Int
        // (freemium 1/day vs legacy 3/day). Kept non-null so live pre-1.2.0
        // clients — whose Snapshot decodes these as required Int — never break;
        // a pro user's UI ignores them via is_pro.
        const freeCaps = capabilities(effectiveTier('none', usageEnforce));
        // Quota resets at the next UTC midnight — the exact day boundary the
        // claim_usage_slot RPC (and countTodayUsage) count renders from
        // (date_trunc('day', now() at utc)). The client renders a live countdown
        // to this instant. Infinity (pro) can't survive JSON, so send null and
        // let is_pro drive the "unlimited" UI.
        const resetsAt = new Date(new Date(utcDayStart()).getTime() + 86_400_000).toISOString();
        const renderLimit = Number.isFinite(freeCaps.renderLimit) ? freeCaps.renderLimit : null;
        return sendJson(res, 200, {
          is_pro: !!ent.isPro,
          tier: effTier,
          pro_until: proUntil,
          renders_today: renders,
          chats_today: chats,
          render_limit: freeCaps.renderLimit,
          chat_limit: freeCaps.chatLimit,
          // Freemium usage-meter contract (1.3.0+ client): used / limit / reset.
          used: renders,
          limit: renderLimit,
          resets_at: resetsAt,
          // Routing cert (staged, 1.3.2/218 client). INERT env-driven flags — the
          // backend flips these the moment the routing pipeline can process 5-min
          // videos; the client then raises the picker ceiling 180→300 and moves
          // content classification server-side. Defaults keep today's world.
          // Older clients ignore both fields.
          max_upload_seconds: Number(process.env.MAX_UPLOAD_SECONDS) || 180,
          content_routing_enabled: String(process.env.CONTENT_ROUTING_ENABLED || '').trim() === '1',
          // §5 progressive-playback kill switch (client CONSUMPTION gate). Reads
          // PROGRESSIVE_PLAYBACK_ENABLED, accepts "1"/"true"; off → client never shows
          // the live preview even if a manifest arrives.
          progressive_playback_enabled: progressivePlaybackEnabled(),
          // §4 sample-clip demo (env-driven, inert until SAMPLE_DEMO_ENABLED=1).
          // The first-run hero offers "Watch Promptly edit this" only when this is
          // on AND a clip is configured. Two flag-selectable modes:
          //   'live'   → client dispatches SAMPLE_DEMO_SOURCE_URL through the real
          //              pipeline with demo:true (quota-exempt). A real render each
          //              tap — honest "watch it work", but one GPU render per view.
          //   'cached' → client plays the PRE-RENDERED SAMPLE_DEMO_RESULT_URL (the
          //              same clip rendered once, hosted). Instant, ~zero marginal
          //              cost, never fails. Honest framing (an example Promptly
          //              made), NEVER a faked live-progress ramp.
          sample_demo_enabled: String(process.env.SAMPLE_DEMO_ENABLED || '').trim() === '1',
          sample_demo_mode: (process.env.SAMPLE_DEMO_MODE || 'cached').trim().toLowerCase() === 'live' ? 'live' : 'cached',
          sample_demo_source_url: process.env.SAMPLE_DEMO_SOURCE_URL || null,
          sample_demo_proxy_url: process.env.SAMPLE_DEMO_PROXY_URL || null,
          sample_demo_vibe: process.env.SAMPLE_DEMO_VIBE || null,
          sample_demo_result_url: process.env.SAMPLE_DEMO_RESULT_URL || null,
          sample_demo_thumbnail_url: process.env.SAMPLE_DEMO_THUMBNAIL_URL || null,
        });
      } catch (error) {
        const status = error?.statusCode || 500;
        return sendJson(res, status, { error: error?.message || 'usage_unavailable' });
      }
    })();
    return;
  }

  // ── Account deletion ──
  // Apple's App Store Review Guideline 5.1.1(v) requires apps that
  // create accounts to also offer in-app account deletion. This is the
  // server endpoint the iOS app's AccountView Delete button calls.
  //
  // Flow:
  //   1. Authenticate the caller via their Supabase JWT.
  //   2. Collect S3 keys for every rendered video + thumbnail this user
  //      owns so we can clean up storage after the DB rows are gone.
  //   3. Delete the user's rows from video_jobs, chats, usage_events,
  //      profiles. We do this explicitly rather than relying on cascade
  //      because the migrations protect video_jobs and chats from
  //      cascade-on-user-delete (so a casual misclick doesn't nuke
  //      paying customer content). Account-delete is the intentional
  //      path that DOES wipe everything.
  //   4. Delete the auth.users row via Supabase admin API. After this
  //      the JWT is invalid and the iOS app signs the user out.
  //   5. Best-effort delete the S3 objects. Failures here are logged
  //      but don't block account deletion — orphan files cost ~$0.01/GB/mo
  //      and can be cleaned up later by a lifecycle policy.
  //
  // Idempotent: a re-run with an already-deleted auth user returns
  // success because there's nothing left to clean up.
  if (parsed.pathname === '/api/account/delete' && req.method === 'POST') {
    (async () => {
      try {
        if (!supabaseAdmin) return sendJson(res, 500, { error: 'supabase_not_configured' });
        const authUser = await requireSupabaseUser(req);
        const userId = authUser.id;
        console.log('[account] delete requested for user', userId);

        // 1. Collect S3 keys to clean up post-deletion.
        const { data: jobs, error: jobsErr } = await supabaseAdmin
          .from('video_jobs')
          .select('id, video_url, rendered_video_url, thumbnail_url, hls_manifest_url')
          .eq('user_id', userId);
        if (jobsErr) {
          console.error('[account] could not list jobs', jobsErr);
        }
        const s3Keys = [];
        for (const job of jobs || []) {
          for (const urlStr of [job.video_url, job.rendered_video_url, job.thumbnail_url, job.hls_manifest_url]) {
            if (!urlStr) continue;
            try {
              const u = new URL(urlStr);
              // Strip leading slash to get the S3 key. Works for both
              // direct S3 URLs (bucket.s3.region.amazonaws.com/key) and
              // CloudFront URLs (cdn.example.com/key).
              const key = u.pathname.replace(/^\/+/, '');
              if (key) s3Keys.push(key);
            } catch {
              // Malformed URL — skip.
            }
          }
        }
        console.log('[account] will delete', s3Keys.length, 'S3 objects after DB rows');

        // 2. Delete DB rows explicitly. Order matters only for the
        //    profiles row (its FK has CASCADE so it would go automatically
        //    on auth user delete, but we delete it first to keep the
        //    state machine readable).
        const deleteResults = await Promise.allSettled([
          supabaseAdmin.from('video_jobs').delete().eq('user_id', userId),
          supabaseAdmin.from('chats').delete().eq('user_id', userId),
          supabaseAdmin.from('usage_events').delete().eq('user_id', userId),
          supabaseAdmin.from('profiles').delete().eq('id', userId),
        ]);
        for (const r of deleteResults) {
          if (r.status === 'rejected' || r.value?.error) {
            console.error('[account] DB row delete failure (continuing):', r.value?.error || r.reason);
          }
        }

        // 3. Delete the auth user. This makes the JWT invalid; the iOS
        //    app will sign out automatically on next API call.
        const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
        if (authErr) {
          console.error('[account] auth user delete failed', authErr);
          // Already-deleted users return 404 here — treat as success.
          const msg = String(authErr.message || authErr).toLowerCase();
          if (!msg.includes('not found') && !msg.includes('not_found')) {
            return sendJson(res, 500, { error: 'auth_delete_failed', detail: authErr.message });
          }
        }

        // 4. Best-effort S3 cleanup. Run after DB delete so a half-finished
        //    state never leaves "user can sign in but their files are gone."
        const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
        const s3svc = require('./services/s3');
        if (s3svc.s3Client && s3svc.S3_BUCKET) {
          let s3DeleteCount = 0;
          for (const key of s3Keys) {
            try {
              await s3svc.s3Client.send(new DeleteObjectCommand({
                Bucket: s3svc.S3_BUCKET,
                Key: key,
              }));
              s3DeleteCount++;
            } catch (err) {
              // Orphan files are cheap; logging is enough.
              console.warn('[account] S3 delete failed for', key, err.message || err);
            }
          }
          console.log('[account] deleted', s3DeleteCount, 'of', s3Keys.length, 'S3 objects');
        }

        console.log('[account] delete complete for', userId);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        const status = err?.statusCode || 500;
        console.error('[account] delete error', err);
        return sendJson(res, status, { error: err?.message || 'delete_failed' });
      }
    })();
    return;
  }

  // ── Email test + domain check (service-role guarded) ──
  // Confirms Resend is configured in THIS environment (the key lives only in
  // server env), verifies the sending domain, and delivers the 3 lifecycle
  // templates to a given address. Guarded by the service-role key, which is a
  // server-only secret — no new attack surface beyond what that key already grants.
  if (parsed.pathname === '/api/admin/email-test' && req.method === 'POST') {
    (async () => {
      try {
        const svc = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
        if (!svc || String(req.headers.authorization || '') !== `Bearer ${svc}`) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        const body = await readJsonBody(req).catch(() => ({}));
        const to = String((body && body.to) || '').trim();
        if (!to) return sendJson(res, 400, { error: 'to_required' });
        const email = require('./lib/email');
        const configured = email.resendConfigured();
        const domain = await email.verifyDomain('usepromptly.app');
        // A caller-supplied stamp keys the idempotency ledger — pass the SAME
        // stamp twice to prove a retry does NOT double-send; omit it for a fresh
        // (always-delivering) run.
        const stamp = String((body && body.stamp) || Date.now());
        const results = configured ? await email.sendTestSuite(supabaseAdmin, to, stamp) : null;
        return sendJson(res, 200, { configured, env_var_needed: configured ? null : 'RESEND_API_KEY', domain, results });
      } catch (e) {
        return sendJson(res, 500, { error: e && e.message });
      }
    })();
    return;
  }

  // ── RevenueCat webhook ──
  // RevenueCat → here on every subscription lifecycle event (INITIAL_PURCHASE,
  // RENEWAL, CANCELLATION, EXPIRATION, BILLING_ISSUE, TRIAL_STARTED, etc.).
  // We translate to two profile fields:
  //   - tier      'pro' when the entitlement is active, else 'free'
  //   - pro_until ISO timestamp from event.expiration_at_ms; null when free
  // Server's isUserPro() check looks at both, so a cancelled-but-still-in-period
  // subscription stays Pro until expiration_at_ms passes.
  //
  // Security: RevenueCat signs every webhook with the bearer token configured
  // in their dashboard (Authorization: Bearer <REVENUECAT_WEBHOOK_AUTH>).
  // We reject unsigned or mis-signed calls. Set REVENUECAT_WEBHOOK_AUTH in
  // Render env to match what you paste into RevenueCat's webhook config.
  if (parsed.pathname === '/api/revenuecat/webhook' && req.method === 'POST') {
    (async () => {
      try {
        // RECEIVED counter (lane/delivery 2026-08-10): one durable row for EVERY
        // webhook hit, INCLUDING auth failures and misconfig — before this, a
        // 401ing webhook was invisible outside Render logs and "has RC ever
        // called us?" was unanswerable from the DB. Fire-and-forget.
        const rcReceived = (props) => {
          if (!supabaseAdmin) return;
          supabaseAdmin.from('analytics_events').insert({
            event: 'rc_webhook_received', platform: 'server', app_version: 'rc-webhook',
            props,
          }).then(() => {}).catch(() => {});
        };
        const expected = process.env.REVENUECAT_WEBHOOK_AUTH || '';
        if (!expected) {
          console.warn('[RevenueCat] webhook called but REVENUECAT_WEBHOOK_AUTH not set');
          rcReceived({ outcome: 'not_configured' });
          return sendJson(res, 503, { error: 'webhook_not_configured' });
        }
        // Accept the secret whether RevenueCat's dashboard sends it bare or as
        // "Bearer <secret>" (and ignore stray whitespace) — a prefix mismatch
        // was 401ing every webhook and silently breaking billing sync. The
        // secret VALUE still has to match, so this grants nothing extra.
        if (!revenuecatWebhookAuthMatches(req.headers.authorization, expected)) {
          console.warn('[RevenueCat] webhook auth mismatch');
          rcReceived({ outcome: 'auth_mismatch' });
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        if (!supabaseAdmin) {
          return sendJson(res, 500, { error: 'supabase_not_configured' });
        }
        const body = await readJsonBody(req);
        const event = body?.event;
        if (!event) { rcReceived({ outcome: 'event_missing' }); return sendJson(res, 400, { error: 'event_missing' }); }
        rcReceived({
          outcome: 'received',
          rc_type: String(event.type || '').toUpperCase().slice(0, 40) || null,
          app_user_id: String(event.app_user_id || '').slice(0, 64) || null,
        });

        const type = String(event.type || '').toUpperCase();
        // app_user_id is whatever we set in Purchases.shared.logIn(...) on
        // iOS — we use the Supabase user.id, so this maps 1:1 to profiles.id.
        const appUserId = String(event.app_user_id || '').trim();
        if (!appUserId) {
          console.warn('[RevenueCat] event missing app_user_id', { type });
          return sendJson(res, 400, { error: 'app_user_id_missing' });
        }
        const productId = event.product_id ? String(event.product_id) : null;
        const periodType = event.period_type ? String(event.period_type).toLowerCase() : null;
        // RevenueCat tags every subscriber event with its store environment
        // ('SANDBOX' | 'PRODUCTION'). We grant Pro IDENTICALLY either way — a
        // sandbox/TestFlight tester MUST get Pro to test — this is used ONLY to
        // keep sandbox out of revenue reporting, never to deny access. Written
        // as DERIVED profile state (below): every applied event rewrites it, so
        // a later PRODUCTION event supersedes an earlier SANDBOX one.
        const environment = event.environment ? String(event.environment).toUpperCase() : null;
        // When this event actually occurred (RevenueCat clock). Used as an
        // ordering/idempotency guard so a late or duplicate stale event can't
        // overwrite a fresher one — see applyTo below.
        const eventMs = Number(event.event_timestamp_ms || 0);
        const expirationMs = Number(event.expiration_at_ms || 0);
        const expirationIso = expirationMs > 0 ? new Date(expirationMs).toISOString() : null;

        // Events that activate Pro. RevenueCat fires INITIAL_PURCHASE on
        // first-time purchase OR free trial start (period_type === 'TRIAL').
        const grantsPro = new Set([
          'INITIAL_PURCHASE',
          'RENEWAL',
          'PRODUCT_CHANGE',
          'UNCANCELLATION',
          'NON_RENEWING_PURCHASE',
        ]);
        // Events that revoke Pro IMMEDIATELY (vs CANCELLATION which lets
        // them stay Pro through expiration_at_ms).
        //
        // SUBSCRIBER_ALIAS is deliberately NOT here. It fires when RevenueCat
        // links two app_user_ids for the SAME person (e.g. an anonymous id
        // aliased to a signed-in user) — treating it as a revoke would strip
        // Pro from a paying customer at the exact moment they sign in. It
        // falls through to the ack branch instead.
        // NOTE: BILLING_ISSUE is intentionally NOT here — a failed renewal
        // payment doesn't mean the user lost access yet (Apple offers a billing
        // grace period). It's handled in its own branch below so we keep Pro
        // through the grace window instead of yanking it instantly.
        const revokesProNow = new Set([
          'EXPIRATION',
          'SUBSCRIPTION_PAUSED',
          'REFUND',
        ]);

        let update = null;
        if (grantsPro.has(type)) {
          update = {
            tier: 'pro',
            pro_until: expirationIso,
            rc_app_user_id: appUserId,
            rc_product_id: productId,
            rc_period_type: periodType,
          };
        } else if (type === 'CANCELLATION') {
          // User cancelled but keeps access until expiration_at_ms. No change
          // to tier — isUserPro flips to false naturally when pro_until passes.
          // Guard: only move pro_until if we actually got a valid expiration;
          // a missing/zero expiration must NOT null it out (that would revoke a
          // still-paid period the instant the cancellation is logged).
          if (!expirationIso) {
            return sendJson(res, 200, { ok: true, ignored: 'CANCELLATION_no_expiration' });
          }
          update = { pro_until: expirationIso, rc_app_user_id: appUserId };
        } else if (type === 'BILLING_ISSUE') {
          // A renewal payment failed, but the user is still entitled during
          // Apple's billing grace period. Keep Pro through
          // grace_period_expiration_at_ms (or expiration_at_ms) when that's in
          // the future; only fully revoke once no entitlement remains. A
          // successful retry fires RENEWAL and extends pro_until normally.
          const graceMs = Number(event.grace_period_expiration_at_ms || 0);
          const keepUntilMs = Math.max(graceMs, expirationMs);
          if (keepUntilMs > Date.now()) {
            update = { pro_until: new Date(keepUntilMs).toISOString(), rc_period_type: periodType };
          } else {
            update = {
              tier: 'free',
              pro_until: null,
              rc_app_user_id: appUserId,
              rc_product_id: productId,
              rc_period_type: periodType,
            };
          }
        } else if (revokesProNow.has(type)) {
          update = {
            tier: 'free',
            pro_until: null,
            rc_app_user_id: appUserId,
            rc_product_id: productId,
            rc_period_type: periodType,
          };
        } else if (type === 'TRANSFER') {
          // A subscription moved between app_user_ids (e.g. an anonymous
          // purchase later aliased to a signed-in user). The entitlement now
          // belongs to `transferred_to`. There's no expiration on a TRANSFER
          // event, so we reconcile each recipient straight from RC's REST API
          // to grant Pro with the correct pro_until. Requires
          // REVENUECAT_SECRET_KEY; without it we ack (the user's next /sync
          // call reconciles instead) rather than make RC retry forever.
          const toIds = Array.isArray(event.transferred_to) ? event.transferred_to : [];
          let granted = 0;
          for (const rawId of toIds) {
            const tid = String(rawId || '').trim();
            if (!tid || tid.startsWith('$RCAnonymousID')) continue;
            try {
              const r = await reconcileEntitlementFromRevenueCat(tid);
              if (r.isPro) granted++;
            } catch (e) {
              if (e.statusCode === 503) {
                console.warn('[RevenueCat] TRANSFER but REVENUECAT_SECRET_KEY not set; acking');
                return sendJson(res, 200, { ok: true, ignored: 'TRANSFER_no_secret' });
              }
              console.error('[RevenueCat] TRANSFER reconcile failed', { tid, error: e.message });
            }
          }
          // SOURCE RECONCILE (Zac 2026-08-04): the sub moved AWAY from these ids.
          // reconcile is grant-only, so lingering Pro on the source would persist
          // until pro_until lapsed — a small leak (mostly anon sources, but real→
          // real transfers exist). Re-check each source against RC; if RC confirms
          // it no longer holds the entitlement, revoke ONLY the profile still keyed
          // to that exact id (never touch one that re-subscribed under a new id).
          const fromIds = Array.isArray(event.transferred_from) ? event.transferred_from : [];
          let revoked = 0;
          for (const rawId of fromIds) {
            const fid = String(rawId || '').trim();
            if (!fid || fid.startsWith('$RCAnonymousID')) continue;
            try {
              const r = await reconcileEntitlementFromRevenueCat(fid); // authoritative; grants if still Pro
              if (!r.isPro) {
                const { data: rev } = await supabaseAdmin.from('profiles')
                  .update({ tier: 'free', pro_until: null })
                  .eq('id', fid).eq('rc_app_user_id', fid)
                  .select('id');
                if (Array.isArray(rev) && rev.length) revoked++;
              }
            } catch (e) {
              if (e.statusCode === 503) break; // no RC secret — ack; /sync reconciles
              console.error('[RevenueCat] TRANSFER from-reconcile failed', { fid, error: e.message });
            }
          }
          console.log('[RevenueCat] TRANSFER reconciled', { granted, of: toIds.length, revoked });
          return sendJson(res, 200, { ok: true, transferred: granted, revoked });
        } else {
          // TEST, SUBSCRIBER_ALIAS, etc — log and ack so RevenueCat doesn't retry.
          console.log('[RevenueCat] unhandled event type, acking', { type, appUserId });
          return sendJson(res, 200, { ok: true, ignored: type });
        }

        // Apply the update. We `.select('id')` so we can tell a real write
        // apart from a silent zero-row no-op: Supabase/PostgREST returns NO
        // error when `.eq('id', x)` matches nothing. Without this check a
        // webhook aimed at an id with no profile — app_user_id still a
        // `$RCAnonymousID` because logIn() hadn't aliased yet, or the row is
        // missing — would log "applied" and 200 while the user never becomes
        // Pro. That's the worst failure for a paid flow: silent, logs lying.
        // ORDERING/IDEMPOTENCY GUARD (billing gap #2). Stamp the event time and
        // apply ONLY when this event is newer than the last one processed for
        // the row (rc_last_event_ms null or < eventMs). A late/duplicate stale
        // event (e.g. a delayed BILLING_ISSUE arriving after a RENEWAL) then
        // matches zero rows and is ignored instead of clobbering fresher state.
        // The conditional lives in the WHERE clause, so concurrent deliveries
        // are resolved atomically at the DB — the newest event always wins
        // regardless of arrival order. Events with no timestamp (eventMs===0)
        // fall back to an unguarded write (can't order what has no clock).
        // Returns 'applied' | 'stale' | 'nomatch'.
        const applyTo = async (id) => {
          const useOrdering = eventMs > 0;
          // Two OPTIONAL columns ride alongside the core `update`:
          //   rc_last_event_ms — the ordering/idempotency stamp (20260701)
          //   rc_environment   — the sandbox tag, DERIVED state written on EVERY
          //     applied event (grant OR revoke) so a later PRODUCTION event
          //     supersedes an earlier SANDBOX one, and a tester's own account
          //     counts again after they test. Only written when present, so a
          //     malformed event never nulls a known value.
          // migration-guarded[rc_environment]: kept out of the core `update` so
          // the missing-column fallback below drops back to a write that only
          // touches guaranteed-existing columns.
          const extras = {};
          if (environment) extras.rc_environment = environment;
          if (useOrdering) extras.rc_last_event_ms = eventMs;
          const payload = { ...update, ...extras };
          let q = supabaseAdmin.from('profiles').update(payload).eq('id', id);
          if (useOrdering) q = q.or(`rc_last_event_ms.is.null,rc_last_event_ms.lt.${eventMs}`);
          let { data, error } = await q.select('id');
          // Tolerate an optional column not existing yet (rc_last_event_ms from
          // 20260701, or rc_environment): fall back to a plain core update so the
          // webhook never 500s on a missing column. Each activates automatically
          // once its migration is applied.
          if (error && rcOrderingColumnMissing(error)) {
            ({ data, error } = await supabaseAdmin.from('profiles').update(update).eq('id', id).select('id'));
            if (error) throw error;
            return (Array.isArray(data) && data.length > 0) ? 'applied' : 'nomatch';
          }
          if (error) throw error;
          if (Array.isArray(data) && data.length > 0) return 'applied';
          if (!useOrdering) return 'nomatch';
          // Zero rows under the guard: either no such profile, or it exists but
          // this event is stale. Disambiguate — but honor the SAME ordering
          // predicate the UPDATE used, so a row inserted between the UPDATE and
          // this read (the anonymous-purchase→alias race) with a null/older
          // stamp is NOT mislabeled 'stale' (which would 200-ack + drop the
          // event forever). Only a row whose stamp is genuinely >= this event
          // is 'stale'; anything else is 'nomatch' → 500 → RC retries → applies.
          const { data: exists } = await supabaseAdmin
            .from('profiles').select('id, rc_last_event_ms').eq('id', id).limit(1);
          const row = Array.isArray(exists) ? exists[0] : null;
          if (row && row.rc_last_event_ms != null && Number(row.rc_last_event_ms) >= eventMs) return 'stale';
          return 'nomatch';
        };

        let matchedId = null;
        let staleForExisting = false;
        try {
          const r0 = await applyTo(appUserId);
          if (r0 === 'applied') {
            matchedId = appUserId;
          } else if (r0 === 'stale') {
            staleForExisting = true;
          } else {
            // app_user_id matched no profile. Fall back to this subscriber's
            // other known identities before giving up — covers the
            // anonymous-purchase-then-login alias case. RevenueCat includes
            // every id it knows for the subscriber in `aliases`.
            const candidates = []
              .concat(Array.isArray(event.aliases) ? event.aliases : [])
              .concat(event.original_app_user_id || [])
              .map((x) => String(x || '').trim())
              .filter((x) => x && x !== appUserId && !x.startsWith('$RCAnonymousID'));
            for (const cand of candidates) {
              const rc = await applyTo(cand);
              if (rc === 'applied') { matchedId = cand; break; }
              if (rc === 'stale') { staleForExisting = true; break; }
            }
          }
        } catch (error) {
          console.error('[RevenueCat] profile update failed', { type, appUserId, error: error.message });
          return sendJson(res, 500, { error: 'profile_update_failed' });
        }

        // A profile exists but this event is older than one we already applied:
        // safe no-op. Ack so RevenueCat stops retrying a stale event.
        if (!matchedId && staleForExisting) {
          console.log('[RevenueCat] ignored stale/out-of-order event', { type, appUserId, eventMs });
          return sendJson(res, 200, { ok: true, ignored: 'stale_event' });
        }

        if (!matchedId) {
          // No profile matched any known id for this subscriber. Return 500
          // (NOT 200) so RevenueCat retries: this makes the problem visible
          // in logs + RC's dashboard, and buys time for a just-completed
          // logIn() alias to land. A truly orphaned purchase (user never
          // signed in) exhausts retries and surfaces in RC instead of
          // silently stranding a paying customer.
          console.error('[RevenueCat] no profile matched subscriber; asking RC to retry', {
            type, appUserId, aliases: event.aliases || null,
          });
          return sendJson(res, 500, { error: 'no_profile_matched' });
        }

        console.log('[RevenueCat] applied', { type, appUserId: matchedId, ...update });

        // ── Lifecycle emails ───────────────────────────────────────────────
        // Fire ONLY on an APPLIED event: the rc_last_event_ms ordering guard
        // above makes each event apply at most once, so a RevenueCat retry
        // reaches here only the first time — and the email ledger keys on
        // event.id for a second layer of idempotency. Fail-soft: an email error
        // never delays or fails the RC ack.
        try {
          const rcEventId = event.id ? String(event.id) : null;
          if (type === 'INITIAL_PURCHASE' && periodType !== 'trial') {
            require('./lib/email').sendPurchaseEmail(supabaseAdmin, { userId: matchedId, eventId: rcEventId, productId })
              .catch((e) => console.warn('[email] purchase trigger failed:', e && e.message));
          } else if (type === 'BILLING_ISSUE') {
            require('./lib/email').sendBillingEmail(supabaseAdmin, { userId: matchedId, eventId: rcEventId })
              .catch((e) => console.warn('[email] billing trigger failed:', e && e.message));
          }
        } catch (e) { console.warn('[email] RC lifecycle trigger threw (fail-soft):', e && e.message); }

        // ── Transaction-truth mirror (analytics backbone) ──────────────────
        // The webhook is the ONLY place trial/paid/renewal/expiration truth
        // exists (audit #4/#14: the client's trial_start is config-inferred and
        // its purchase path has silent terminal outcomes). Mirror every APPLIED
        // event into both sinks — analytics_events (SQL / [REPORT]) and PostHog
        // (dashboards) — keyed by the Supabase user id, the same distinct_id
        // the client identify()s as, so funnels join across the seam. Fire-and-
        // forget: never delays or fails the RC ack.
        try {
          const mirrorName =
            type === 'INITIAL_PURCHASE' ? (periodType === 'trial' ? 'trial_start' : 'purchase_result')
            : type === 'RENEWAL' ? 'subscription_renewal'
            : type === 'EXPIRATION' ? 'subscription_expiration'
            : type === 'CANCELLATION' ? 'subscription_cancellation'
            : type === 'BILLING_ISSUE' ? 'billing_issue'
            : null;
          if (mirrorName) {
            const mirrorProps = {
              source: 'rc_webhook',
              rc_type: type,
              product_id: productId,
              period_type: periodType,
              // Per-event, IMMUTABLE sandbox tag — the durable record ('SANDBOX'
              // | 'PRODUCTION' | null). Event-based reporting (funnel PAYWALL
              // LEG, bleed-meter commerce, PostHog) drops props.environment ===
              // 'SANDBOX' so a sandbox purchase never counts as a real conversion.
              environment,
              ...(mirrorName === 'purchase_result' ? { outcome: 'success_paid' } : {}),
            };
            supabaseAdmin.from('analytics_events').insert({
              event: mirrorName,
              anon_user_id: matchedId,
              user_id: matchedId,
              platform: 'server',
              app_version: 'rc-webhook',
              props: mirrorProps,
            }).then(({ error }) => {
              if (error) console.warn('[RevenueCat] analytics mirror insert failed:', error.message);
            });
            phCapture(matchedId, mirrorName, mirrorProps);
          }
        } catch (e) {
          console.warn('[RevenueCat] mirror failed (non-fatal):', e && e.message);
        }

        return sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error('[RevenueCat] webhook error', err);
        return sendJson(res, 500, { error: err?.message || 'webhook_error' });
      }
    })();
    return;
  }

  // ── RevenueCat reconciliation (client-triggered, synchronous) ──
  // The webhook is the primary activation path, but it's asynchronous and can
  // lag or fail. The iOS app calls this immediately after a successful
  // purchase/restore so Pro activates synchronously instead of depending on a
  // webhook landing: we verify the entitlement straight from RevenueCat's
  // REST API (source of truth) and grant tier='pro' on the spot.
  //
  // Grant-only — see reconcileEntitlementFromRevenueCat(). Authenticated as
  // the calling user, and we reconcile THAT user's own id only, so it can't
  // be used to flip anyone else's account.
  if (parsed.pathname === '/api/revenuecat/sync' && req.method === 'POST') {
    (async () => {
      try {
        const u = await requireSupabaseUser(req);
        const result = await reconcileEntitlementFromRevenueCat(u.id);
        // SCOPED REVOKE (lane/delivery 2026-08-10) — the grant-only asymmetry
        // meant a lapsed subscriber's tier column stayed 'pro' forever unless
        // the EXPIRATION webhook landed. Revoke here ONLY under the narrowest
        // definitive predicate, all four required:
        //   • RC found the CUSTOMER but no active pro (RC_NOT_ACTIVE — never
        //     NO_RC_CUSTOMER, which the current project-id misconfig produces
        //     for everyone, and never a transient/config error, which throws)
        //   • the profile's Pro is RC-SOURCED (rc_app_user_id set), never comped
        //   • pro_until is null or already past — the entitlement window the
        //     user PAID for is over, so this can never strip a paid period, and
        //     RC's eventually-consistent read lagging a renewal keeps pro_until
        //     in the future → skipped.
        // isUserPro() already denies on a past pro_until, so this is state
        // hygiene (tier column + analytics truth), not an access change.
        if (result && result.isPro === false && result.reason === 'RC_NOT_ACTIVE' && supabaseAdmin) {
          try {
            const { data: revoked } = await supabaseAdmin.from('profiles')
              .update({ tier: 'free' })
              .eq('id', u.id)
              .eq('tier', 'pro')
              .not('rc_app_user_id', 'is', null)
              .not('comp_pro', 'is', true)
              .or(`pro_until.is.null,pro_until.lt.${new Date().toISOString().replace(/\+.*$/, 'Z')}`)
              .select('id');
            if (Array.isArray(revoked) && revoked.length) {
              console.log('[RevenueCat] /sync revoked lapsed pro tier', { userId: u.id });
            }
          } catch (e) {
            console.warn('[RevenueCat] /sync revoke check failed (non-fatal)', { userId: u.id, error: e?.message });
          }
        }
        // Log the reconcile OUTCOME so RC-side failures (esp. a bad/expired/wrong
        // REVENUECAT_SECRET_KEY → 403 on the v2 REST API) are COUNTABLE in
        // analytics, not just buried in Render logs. This is how we prove the
        // entitlement self-heal is (or isn't) working after a key change.
        if (supabaseAdmin) {
          supabaseAdmin.from('analytics_events').insert({
            event: 'reconcile_result', anon_user_id: u.id, user_id: u.id,
            platform: 'server', app_version: 'rc-sync',
            props: { ok: true, is_pro: !!result.isPro, reason: result.reason || null },
          }).then(({ error }) => { if (error) console.warn('[RevenueCat] reconcile log failed:', error.message); });
        }
        return sendJson(res, 200, {
          is_pro: !!result.isPro,
          pro_until: result.proUntil || null,
          reason: result.reason,
        });
      } catch (error) {
        const status = error?.statusCode || 500;
        // Pull the RC HTTP status out of the thrown `revenuecat_http_403` shape.
        const rcMatch = /revenuecat_http_(\d+)/.exec(error?.message || '');
        const rcStatus = rcMatch ? Number(rcMatch[1]) : null;
        if (supabaseAdmin && status !== 503) {
          supabaseAdmin.from('analytics_events').insert({
            event: 'reconcile_result', platform: 'server', app_version: 'rc-sync',
            props: { ok: false, status, rc_status: rcStatus, error: String(error?.message || '').slice(0, 120) },
          }).then(({ error: e }) => { if (e) console.warn('[RevenueCat] reconcile log failed:', e.message); });
        }
        if (status === 503) {
          // Secret key not configured — client silently falls back to
          // webhook-only activation. Not an error worth alerting on.
          console.warn('[RevenueCat] /sync called but REVENUECAT_SECRET_KEY not set');
        } else {
          console.error('[RevenueCat] /sync failed', { status, rc_status: rcStatus, error: error?.message });
        }
        return sendJson(res, status, { error: error?.message || 'sync_failed' });
      }
    })();
    return;
  }

  // just does the normal S3 download. Zero regression vs the old flow.
  if (parsed.pathname === '/api/prewarm' && req.method === 'POST') {
    (async () => {
      try {
        const prewarmUser = await requireSupabaseUser(req);
        // 🚨 SPEND FREEZE (2026-08-01) — GPU prewarm DISABLED by default. Each
        // prewarm downloads + transcribes on a paid Modal container, and the iOS
        // client fires warmupRenderContainer() at editor-open, composer-focus AND
        // dispatch — including on the ~63% who never render — so it burns paid GPU
        // OUTSIDE any user job (a runtime×rate model can't see it). Frozen until the
        // Modal-view spend gap is explained. Re-enable with PREWARM_ENABLED=1. This
        // is a NO-OP to the client: prewarm is a best-effort latency hedge it never
        // depends on (real renders just start cold). Counts frozen attempts so the
        // warmup-fire rate is finally measurable.
        if (process.env.PREWARM_ENABLED !== '1') {
          serverFunnel(prewarmUser.id, 'prewarm_frozen', {}); // measure the warmup-attempt rate (the waste)
          return sendJson(res, 202, { status: 'skipped', reason: 'prewarm_frozen' });
        }
        // Cap GPU prewarm dispatches per user — each one downloads + transcribes
        // on a paid Modal container. Generous for real use (one per intended
        // render) but stops a loop from spraying GPU spend.
        if (!checkRateLimit(res, 'prewarm', prewarmUser.id, 20, 900)) return;
        // Prewarm door (wall N+1): each prewarm spends paid GPU, so an enforced
        // `.none` is denied. Knob OFF (default) short-circuits — today's behavior.
        if (wallEnabled() || clientFreemium(req.headers)) {
          const dec = await leanWallDecision(prewarmUser.id, req);
          if (!dec.allow) return sendUploadDenial(res, dec, 'prewarm', prewarmUser.id);
        }
        const body = await readJsonBody(req);
        const videoUrl = String(body?.video_url || body?.videoUrl || '').trim();
        if (!videoUrl) return sendJson(res, 400, { error: 'video_url is required' });
        // SSRF guard — the Modal worker downloads this URL.
        if (!isSafeRemoteMediaUrl(videoUrl)) return sendJson(res, 400, { error: 'invalid_video_url' });

        // Derive the prewarm endpoint URL from the main run-job URL unless
        // overridden. Modal URLs follow the pattern:
        //   https://{org}--{app}-{class}-{method}.modal.run
        // so run_job → prewarm is a substring swap.
        const modalRunUrl = process.env.MODAL_ENDPOINT_URL || '';
        const modalPrewarmUrl = process.env.MODAL_PREWARM_URL
          || modalRunUrl.replace(/-run-job(\.|$)/, '-prewarm$1');

        if (!modalPrewarmUrl) {
          console.warn('[prewarm] no MODAL_PREWARM_URL and no MODAL_ENDPOINT_URL to derive from — skipping');
          return sendJson(res, 202, { status: 'skipped', reason: 'prewarm endpoint not configured' });
        }

        // Fire-and-forget — but register the promise so /api/video-jobs can
        // await it briefly when the real render dispatch arrives and pass the
        // confirmation as a hint to the Modal worker (for race detection).
        const prewarmStart = Date.now();
        const prewarmPromise = fetch(modalPrewarmUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ video_url: videoUrl, ...workerAuthField() }),
        }).then(async (r) => {
          const text = await r.text().catch(() => '');
          let parsed = {};
          try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 300) }; }
          const durationMs = Date.now() - prewarmStart;
          console.log(JSON.stringify({
            event: 'prewarm.result',
            status: parsed.status || `http_${r.status}`,
            cache_key: parsed.cache_key || null,
            cached: parsed.status === 'cached',
            transcript_cached: Boolean(parsed.transcript_cached),
            size_mb: parsed.size_mb || null,
            download_time: parsed.download_time || null,
            duration_ms: durationMs,
            video_url: videoUrl.slice(0, 100),
          }));
          return parsed;
        }).catch((err) => {
          const durationMs = Date.now() - prewarmStart;
          console.warn(JSON.stringify({
            event: 'prewarm.error',
            message: err.message,
            duration_ms: durationMs,
            video_url: videoUrl.slice(0, 100),
          }));
          return { error: err.message };
        });

        registerPrewarm(videoUrl, prewarmPromise);

        return sendJson(res, 202, { status: 'dispatched' });
      } catch (error) {
        console.error('[prewarm] route error:', error?.message);
        return sendJson(res, error?.statusCode || 500, { error: error?.message || 'prewarm failed' });
      }
    })();
    return;
  }

  // Cancel an in-progress render — owner-only, idempotent. Sets status=cancelled
  // (the worker polls /api/render-cancelled and aborts before the GPU render) and
  // refunds one of today's daily render slots. A finished render is a no-op
  // (completion wins, no refund).
  const cancelJobMatch = parsed.pathname && parsed.pathname.match(/^\/api\/video-jobs\/([^/]+)\/cancel$/i);
  if (cancelJobMatch && req.method === 'POST') {
    (async () => {
      try {
        if (!supabaseAdmin) return sendJson(res, 500, { error: 'supabase_not_configured' });
        const authUser = await requireSupabaseUser(req);
        const jobId = decodeURIComponent(cancelJobMatch[1] || '').trim();
        if (!jobId) return sendJson(res, 400, { error: 'jobId required' });

        // Owner-only: load the caller's own job (a wrong user_id -> not found).
        const { data: job, error: readErr } = await supabaseAdmin
          .from('video_jobs').select('id, user_id, status')
          .eq('id', jobId).eq('user_id', authUser.id).maybeSingle();
        if (readErr) return sendJson(res, 500, { error: 'job_read_failed' });
        if (!job) return sendJson(res, 404, { error: 'not_found' });
        if (!isJobCancellable(job)) return sendJson(res, 200, { ok: true, noop: true });

        // Atomic first-terminal-wins: cancel ONLY if the row isn't already
        // terminal. Closes the TOCTOU between the read above and this write — if
        // the worker's render completed (or failed) in that window, the cancel
        // matches 0 rows, the completion stands, and we do NOT refund a finished
        // render or resurrect it. (Mirror of the worker's write-once terminal.)
        const { data: cancelled, error: updErr } = await supabaseAdmin
          .from('video_jobs')
          .update({ status: 'canceled', updated_at: new Date().toISOString() })
          .eq('id', jobId).eq('user_id', authUser.id)
          .not('status', 'in', TERMINAL_JOB_STATUSES_SQL)
          .select('id');
        if (updErr) return sendJson(res, 500, { error: 'cancel_failed' });
        if (!Array.isArray(cancelled) || cancelled.length === 0) {
          return sendJson(res, 200, { ok: true, noop: true });
        }

        // Refund one of today's render usage events (best-effort; a cancel that
        // can't refund still succeeds). usage_events isn't job-linked, so we
        // remove the most recent 'render' event for this user today.
        try {
          const { data: ev } = await supabaseAdmin
            .from('usage_events').select('id')
            .eq('user_id', authUser.id).eq('kind', 'render')
            .gte('created_at', utcDayStart())
            .order('created_at', { ascending: false }).limit(1);
          if (Array.isArray(ev) && ev[0] && ev[0].id != null) {
            await supabaseAdmin.from('usage_events').delete().eq('id', ev[0].id);
          }
        } catch (refundErr) {
          console.warn('[cancel] refund skipped:', refundErr.message);
        }

        // Tell any live SSE client the render is canceled + terminal.
        pushProgressToSSE(jobId, {
          status: 'canceled', progress: 0, step: 'canceled',
          message: 'Render canceled', videoUrl: null, thumbnailUrl: null,
          final: true, error: null,
        });
        console.log('[cancel] job cancelled', { jobId, userId: authUser.id });
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        return sendJson(res, error?.statusCode || 500, { error: error?.message || 'cancel_error' });
      }
    })();
    return;
  }

  // Worker-facing: has this render been cancelled? Polled by the GPU worker
  // before the recipe + before the render so it can abort. Fail-OPEN (cancelled
  // false on any error) — a check failure must never abort a legitimate render.
  // Mirrors the modal-callback trust model (unguessable job uuid + optional
  // shared secret).
  if (parsed.pathname === '/api/render-cancelled' && req.method === 'GET') {
    (async () => {
      try {
        if (!modalCallbackAuthed(req)) return sendJson(res, 401, { error: 'unauthorized' });
        if (!supabaseAdmin) return sendJson(res, 200, { cancelled: false });
        const jobId = String(parsed.query.job_id || '').trim();
        if (!jobId) return sendJson(res, 400, { error: 'job_id required' });
        const { data } = await supabaseAdmin
          .from('video_jobs').select('status').eq('id', jobId).maybeSingle();
        // Response KEY stays `cancelled` (worker's is_cancelled reads that bool);
        // the STATUS compare is canonical 'canceled'.
        return sendJson(res, 200, { cancelled: data?.status === 'canceled' });
      } catch (e) {
        return sendJson(res, 200, { cancelled: false });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/video-jobs' && req.method === 'POST') {
    (async () => {
      try {
        console.log('\n📝 POST /api/video-jobs REQUEST RECEIVED');
        console.log('  Time:', new Date().toISOString());
        console.log('  Method:', req.method);
        console.log('  URL:', req.url);
        // Never log the raw headers — they carry the caller's live Supabase JWT
        // (Authorization) and any cookies. Redact before logging.
        console.log('  Headers:', { ...req.headers, authorization: '[redacted]', cookie: '[redacted]' });
        if (!supabaseAdmin) {
          return sendJson(res, 500, { error: 'supabase_not_configured' });
        }
        const authUser = await requireSupabaseUser(req);
        console.log('  ✅ Auth user:', authUser.id);

        // MAINTENANCE GATE (known outage). While the render service is knowingly
        // down (Modal spend cap → KNOWN_OUTAGE_UNTIL set), refuse HONESTLY here —
        // BEFORE the rate-limit tick, any daily-quota claim, any job row, and any
        // Modal dispatch. Result: no failed render (which would cost a permanent
        // App Store review at the worst possible moment — 1.3.3 is live + the
        // surge is on), no quota consumed, and no queued job (a 4-day backlog
        // firing at once on Aug 1 would just re-cap the workspace). 503 + the
        // structured error_code/user_message shape is exactly what the client
        // renders as a friendly inline bubble (402 would wrongly trigger the
        // paywall; a bare error would read as "your video failed"). Auto-clears
        // unconditionally at KNOWN_OUTAGE_UNTIL.
        // OWNER CANARY EXEMPTION: the owner is NOT gated, so they can run a real
        // render to confirm renders are actually back (a completed owner render =
        // the true "renders are back" signal) BEFORE opening the gate for everyone.
        // Solves the chicken-egg — while the gate blocks all traffic, nothing can
        // complete, so we'd otherwise be opening blind at KNOWN_OUTAGE_UNTIL (which
        // is OUR expiry, NOT Modal's billing turn — the two may not coincide).
        if (isKnownOutageActive() && String(authUser.id) !== SUBMISSION_OWNER_USER_ID) {
          console.log('  ⏸️  video-jobs refused — KNOWN_OUTAGE active (no quota, no dispatch, no job)');
          return sendJson(res, 503, {
            error_code: 'render_paused',
            user_message: maintenanceUserMessage(),
            retryable: false,
          });
        }

        // Rate limit: 10 video jobs per 15 minutes per user. Generous for
        // legitimate use (re-edits, multiple variants) but catches a
        // runaway client before it floods Modal.
        if (!checkRateLimit(res, 'video-job-create', authUser.id, 10, 900)) return;

        const body = await readJsonBody(req);
        // Don't dump the whole body — video_url / proxy_video_url are presigned
        // storage URLs (bearer-capability tokens in the query string). Log only
        // the non-sensitive shape.
        console.log('  Request body keys:', body && typeof body === 'object' ? Object.keys(body) : typeof body);
        const videoUrl = String(body?.video_url || body?.videoUrl || '').trim();
        const vibeInput = String(body?.vibe_input || body?.vibeInput || '').trim();
        // Optional low-res proxy. When the client extracts a 640x480
        // proxy on-device and uploads it ahead of the high-res source,
        // pass the proxy URL here so the worker can run Gemini visual
        // analysis on the small file while the source is still in
        // flight. Quality of the FINAL render is unchanged — Gemini
        // analyzes video at thumbnail resolution internally regardless.
        const proxyVideoUrl = String(body?.proxy_video_url || body?.proxyVideoUrl || '').trim();
        // Log presigned URLs without their query string (the ?...signature is a
        // capability token). stripQuery is a no-op on plain paths.
        const stripQuery = (u) => (u ? String(u).split('?')[0] : u);
        console.log('  Video URL:', stripQuery(videoUrl));
        console.log('  Proxy URL:', stripQuery(proxyVideoUrl) || '(none)');
        console.log('  Vibe:', vibeInput);

        // SSRF guard: the worker downloads these URLs. Block internal/metadata
        // targets before dispatch. Legit uploaded sources are public https.
        if (videoUrl && !isSafeRemoteMediaUrl(videoUrl)) {
          return sendJson(res, 400, { error: 'invalid_video_url' });
        }
        if (proxyVideoUrl && !isSafeRemoteMediaUrl(proxyVideoUrl)) {
          return sendJson(res, 400, { error: 'invalid_proxy_url' });
        }

        // §4 sample-clip demo. The exemption (no daily-quota decrement, no
        // concurrency block) is honored ONLY when the source is the server's
        // configured official sample clip — the anti-abuse keystone: a user
        // cannot pass their OWN footage as a "demo" to dodge the free-render cap.
        // Any demo:true on a non-sample source falls through as a normal, charged
        // render. Gated on SAMPLE_DEMO_ENABLED so it's inert until the clip is live.
        const demoConfiguredSource = String(process.env.SAMPLE_DEMO_SOURCE_URL || '').trim();
        const demoEnabled = String(process.env.SAMPLE_DEMO_ENABLED || '').trim() === '1';
        const isDemo = body?.demo === true && demoEnabled && !!demoConfiguredSource && videoUrl === demoConfiguredSource;
        if (body?.demo === true && !isDemo) {
          console.log('  [demo] demo:true NOT honored (enabled=%s sourceMatch=%s) — treating as a normal charged render',
            demoEnabled, videoUrl === demoConfiguredSource);
        }

        const entitlement = await assertProEntitled(authUser.id, { forceRcCheck: wallForceRcCheck(req) });
        console.log('  [paywall] isPro=%s reason=%s plan=%s userId=%s',
          entitlement.isPro, entitlement.reason, entitlement.plan, authUser.id);

        // Wall tier (N+1). Knob OFF (default) → effectiveTier makes this
        // byte-for-byte today: paid/active-trial → unlimited, none → 3/day free.
        // Knob ON → paid unlimited, trial 3/day + 1 concurrent, none → the wall.
        // tierFromEntitlement (NOT entitlementTier on the bare row): the decision
        // may carry no row (RC self-heal), and isPro must win over a stale row —
        // otherwise a paying user reads as 'none' and knob-off caps them at 3/day.
        const wallTier = tierFromEntitlement(entitlement);
        const wallEnforce = resolveEnforce({
          headers: req.headers,
          accountCreatedAt: (entitlement.row || {}).created_at,
        });
        const wallCaps = capabilities(effectiveTier(wallTier, wallEnforce));
        if (!wallCaps.appUsable) {
          console.log('  [wall] 403 wall_required userId=%s tier=%s', authUser.id, wallTier);
          return sendJson(res, 403, { error: 'wall_required', route: 'wall', message: wallRequiredMessage() });
        }

        // Gate probe (deploy-sanity invariant): runs the EXACT entitlement →
        // tier → caps wiring above and returns the decision WITHOUT creating a
        // job or spending GPU. The seam-bug class (a known-Pro account reading
        // trial caps because a layer between two green layers broke) is asserted
        // against this on every deploy — scripts/deploy-sanity.js. Authenticated;
        // leaks only the caller's own caps.
        if (body?.gate_probe === true) {
          return sendJson(res, 200, {
            probe: true,
            tier: wallTier,
            enforced: wallEnforce,
            app_usable: wallCaps.appUsable,
            render_limit: wallCaps.renderLimit === Infinity ? 'unlimited' : wallCaps.renderLimit,
            concurrency_cap: wallCaps.uploadMax,
            chat_limit: wallCaps.chatLimit === Infinity ? 'unlimited' : wallCaps.chatLimit,
            reedit: wallCaps.reedit,
          });
        }

        // Concurrency gate — server-side enforcement of the same 1-free /
        // 10-pro cap the iOS picker enforces. Without this, an alternate
        // client (curl, scripts, sideloaded build) could fire up to
        // (daily_cap = 3) renders in parallel for a free user, or
        // (rate_limit = 10) for a Pro user, with no per-user concurrency
        // gate. Counts queued + processing rows; failed/completed/cancelled
        // don't count against the cap.
        // Reserve atomically. withKeyLock serializes THIS user's concurrent
        // render reservations in-process, and claimDailyUsage claims the daily
        // slot under a DB advisory lock — together closing the TOCTOU where a
        // burst of parallel requests each passed the concurrency (1 free / 10
        // pro) or daily (3 free) cap before any write landed (GPU double-spend).
        // The lock wraps only the check+reserve+insert; the Modal dispatch runs
        // outside it. Returns { job } on success or { status, body } to reject.
        // Idempotency key (stuck-jobs directive): a client-minted job UUID.
        // Optional — legacy clients omit it and get server-generated ids.
        const rawClientJobId = String(body?.client_job_id || '').trim().toLowerCase();
        const clientJobId =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(rawClientJobId)
            ? rawClientJobId : null;

        const reservation = await withKeyLock(`render:${authUser.id}`, async () => {
          // Idempotent replay fast-path: if the client's UUID already has a
          // row, this is a double-submit (retry mash / network replay). Return
          // the existing job — no new charge, no new concurrency slot, and the
          // caller skips re-dispatch (the first submit already dispatched).
          if (clientJobId && supabaseAdmin) {
            const { data: existing } = await supabaseAdmin
              .from('video_jobs')
              .select('*')
              .eq('id', clientJobId)
              .eq('user_id', authUser.id)
              .maybeSingle();
            if (existing) {
              console.log('  [idempotency] replay for client_job_id=%s status=%s', clientJobId, existing.status);
              return { job: existing, replayed: true };
            }
          }
          if (supabaseAdmin && !isDemo) {
            // SPEND GUARD (Zac 2026-08-03): per-account daily render cap (50) +
            // two-tier global breaker (alert 1500 / halt 3000, raised 2026-08-04 for
            // the surge; env-overridable), DB-counted, fail-open.
            // Inside the lock + AFTER the idempotency replay above, so retries never
            // count. Blocks with 429 + a user-facing message; pages the owner.
            const _guard = await checkSpendGuards({
              supabaseAdmin,
              userId: authUser.id,
              alert: (msg) => sendOwnerAlert({
                ownerUserId: SUBMISSION_OWNER_USER_ID,
                title: '🚨 [Promptly] spend guard',
                body: String(msg).slice(0, 180),
                threadId: 'spend-guard',
                supabaseAdmin,
              }).catch(() => {}),
            });
            if (!_guard.allow) {
              console.warn('  [spend-guard] blocked render userId=%s code=%s', authUser.id, _guard.code);
              return { status: 429, body: { error: _guard.code, message: _guard.message } };
            }
            // REFUND-FARMING CONTROL: bound designed-rejection attempts BY DESIGN
            // (not the coincidental 50/day spend cap). User-fault codes only, so an
            // infra-failure streak never blocks a legitimate user. Fail-open.
            const _rej = await checkRejectionAttemptCap({
              supabaseAdmin,
              userId: authUser.id,
              alert: (msg) => sendOwnerAlert({
                ownerUserId: SUBMISSION_OWNER_USER_ID,
                title: '🚨 [Promptly] refund guard',
                body: String(msg).slice(0, 180),
                threadId: 'refund-guard',
                supabaseAdmin,
              }).catch(() => {}),
            });
            if (!_rej.allow) {
              console.warn('  [refund-guard] blocked userId=%s code=%s', authUser.id, _rej.code);
              return { status: 429, body: { error: _rej.code, message: _rej.message } };
            }
            let pendingCount;
            try {
              // Same account-global in-flight definition the upload doors use.
              pendingCount = await inFlightJobCount(authUser.id);
            } catch (pendingErr) {
              console.error('  [paywall] pending-count failed, refusing action',
                { userId: authUser.id, error: pendingErr.message });
              return { status: 503, body: { error: 'pending_check_failed' } };
            }
            // Concurrency cap == the tier's parallel/upload cap: 10 paid / 1 trial.
            // Pre-flip this is exactly today's `isPro ? 10 : 1`.
            const concurrencyCap = wallCaps.uploadMax;
            const proConcurrency = concurrencyCap >= 10;
            if ((pendingCount || 0) >= concurrencyCap) {
              console.log('  [paywall] 402 concurrency_limit_reached userId=%s pending=%d cap=%d',
                authUser.id, pendingCount, concurrencyCap);
              return { status: 402, body: {
                error: 'concurrency_limit_reached',
                kind: proConcurrency ? 'concurrency_pro' : 'concurrency_free',
                limit: concurrencyCap,
                message: proConcurrency
                  ? `You can have up to ${concurrencyCap} renders in flight at once.`
                  : 'Free accounts can render 1 video at a time. Upgrade to Pro for 10 in parallel.',
              } };
            }
          }

          // ── DEAD SOURCE KEY: reject at CREATION, ABOVE the charge ───────
          // A key that has ALREADY failed HEAD can never succeed — retrying it
          // buys another 600s wait and another refund. Our first paying
          // subscriber created three jobs against one such key over 6.5 hours
          // and was refunded three times. Rejected here, above the charge
          // block, so no credit is claimed and none has to be unwound. The copy
          // names the only action that works: a fresh pick mints a fresh key.
          {
            const _dead = await findDeadSourceJob(supabaseAdmin, authUser.id, videoUrl);
            if (_dead) {
              console.log('  [source] REJECT at creation userId=%s — this exact source URL '
                + 'already failed to upload (job %s); a retry would poll a key that does not exist',
                authUser.id, String(_dead.id).slice(0, 8));
              return { status: 409, body: {
                error: 'source_missing',
                kind: 'upload',
                route: 'repick',
                error_code: 'UPLOAD_NEVER_STARTED',
                message: sourceMissingMessage(),
              } };
            }
          }

          if (isDemo) {
            // §4 demo: quota-exempt (source-matched above) — NO usage_events write,
            // so it never touches the render meter or the free-render cap. Capped
            // per user per day so live-render mode can't be hammered into GPU spend;
            // counts this user's demo rows created since UTC midnight. Cached mode
            // (recommended) has no GPU cost, but the cap is cheap defense either way.
            const demoCap = Number(process.env.SAMPLE_DEMO_DAILY_CAP) || 5;
            const { count: demoToday, error: demoCountErr } = await supabaseAdmin
              .from('video_jobs')
              .select('*', { count: 'exact', head: true })
              .eq('user_id', authUser.id)
              .eq('demo', true)
              .gte('created_at', utcDayStart());
            if (demoCountErr) {
              // On a count outage, refuse the demo (never free-render on failure).
              return { status: 503, body: { error: 'demo_check_failed' } };
            }
            if ((demoToday || 0) >= demoCap) {
              console.log('  [demo] 402 demo_limit_reached userId=%s used=%d cap=%d', authUser.id, demoToday, demoCap);
              return { status: 402, body: {
                error: 'demo_limit_reached', kind: 'demo',
                message: 'Come back tomorrow to watch the demo again.',
              } };
            }
          } else if (wallCaps.renderLimit === Infinity) {
            // Unlimited (paid — and, pre-flip, any active-trial that was isPro):
            // no daily cap, but still record the render for tracking.
            await logUsageEvent(authUser.id, 'render');
          } else {
            // Capped tier (trial, or the free tier pre-flip). Atomic check-and-
            // increment of the daily render cap — enforces the limit AND records
            // the usage; on outage it throws 503 and we abort rather than free-render.
            const claim = await claimDailyUsage(authUser.id, 'render', wallCaps.renderLimit);
            if (!claim.ok) {
              console.log('  [paywall] 402 daily_limit_reached for userId=%s', authUser.id);
              return { status: 402, body: {
                error: 'daily_limit_reached',
                kind: 'render',
                route: 'paywall',
                limit: wallCaps.renderLimit,
                message: `You've used your ${wallCaps.renderLimit} free renders today. Upgrade to Pro for unlimited.`,
              } };
            }
          }

          const created = await createQueuedVideoJob({
            userId: authUser.id,
            videoUrl,
            vibeInput,
            clientJobId,
            demo: isDemo,
            appVersion: clientAppVersion(req),
            sourceType: body?.source_type,
            sourceDuration: body?.source_duration,
          });
          if (created.__replayed) {
            // Cross-instance race: another request inserted this UUID between
            // our fast-path check and the insert. Unwind the charge we just
            // claimed (one job, one charge) — delete the render event we
            // logged milliseconds ago — and treat as a replay. A DEMO logs no
            // render charge, so it has nothing to unwind — skipping the delete is
            // load-bearing: otherwise it would wrongly erase a REAL render event.
            if (!isDemo) {
              try {
                const { data: ev } = await supabaseAdmin
                  .from('usage_events').select('id')
                  .eq('user_id', authUser.id).eq('kind', 'render')
                  .gte('created_at', new Date(Date.now() - 10_000).toISOString())
                  .order('created_at', { ascending: false }).limit(1);
                if (Array.isArray(ev) && ev[0]) {
                  await supabaseAdmin.from('usage_events').delete().eq('id', ev[0].id);
                }
              } catch (e) {
                console.warn('  [idempotency] replay charge-unwind failed (non-fatal):', e?.message);
              }
            }
            return { job: created, replayed: true };
          }
          return { job: created };
        });

        if (reservation.status) return sendJson(res, reservation.status, reservation.body);
        const job = reservation.job;
        if (reservation.replayed) {
          // Double-submit resolved to the original job. The first submit owns
          // the dispatch — do NOT re-dispatch (that would double-render).
          return sendJson(res, 200, {
            success: true,
            job_id: job.id,
            status: job.status || 'queued',
            replayed: true,
          });
        }
        console.log('  ✅ Job created:', job.id);

        // Premium pipeline (Lumen) gate — DEFENSE IN DEPTH. The client only
        // sends premium_pipeline_enabled:true for an entitled Pro user, but
        // the server is the real lock: a free/unverified user can NEVER route
        // premium here no matter what the client (or a hand-rolled curl) sends.
        // The worker double-gates again (route_premium = is_premium AND flag).
        // LUMEN_READY master gate (Zac 2026-07-26): Pro defaults to STANDARD.
        // Even isPro + client-asked-premium routes standard UNLESS the backend
        // PREMIUM_PIPELINE_ENABLED env is set — flipped only once Lumen clears
        // Zac's eye. Designed scenes have never emitted (0/473 in 30d), so this
        // costs Pro nothing today (premium output ≡ standard) and removes the
        // risk of shipping an unreviewed Lumen scene to a paying user.
        // [§2.1] LUMEN ACCESS — entitlement-driven, NEVER client-picker-dependent.
        // The old chain required `body.premium_pipeline_enabled === true`, so a
        // Pro user who never opened the model picker silently got standard. That
        // client dependency is one of the three gates that produced 0/2,074 and
        // §2.1's ruling removes it: absence of the field is NOT a decline, only
        // an explicit `false` is. Quota + budget are what make always-on-for-Pro
        // affordable at ~$1/render.
        const lumenAccess = require('./lib/lumen-access');
        // Reads the row ITSELF rather than via getFeatureUsageCount, which
        // returns 0 for "table missing" — indistinguishable from a genuine
        // zero, and here that conflation hands out unlimited ~$1 renders.
        const lumenUsedThisMonth = await lumenAccess.readMonthlyUsage(
          supabaseAdmin, authUser.id);
        const lumenVerdict = lumenAccess.decide({
          isPro: entitlement.isPro === true,
          clientDeclined: body?.premium_pipeline_enabled === false,
          usedThisMonth: lumenUsedThisMonth,
          spentTodayUsd: null,                  // wired with the cost meter
        });
        const premiumPipeline = lumenVerdict.premium;
        console.log('  [model] premium_pipeline=%s reason=%s quota=%s used=%s (isPro=%s masterFlag=%s) job=%s',
          premiumPipeline, lumenVerdict.reason, lumenVerdict.quota,
          lumenUsedThisMonth === null ? 'UNKNOWN' : lumenUsedThisMonth,
          entitlement.isPro, premiumPipelineEnabled(), job.id);
        if (premiumPipeline) {
          incrementFeatureUsage(supabaseAdmin, authUser.id, lumenAccess.monthKey())
            .catch((e) => console.error('  [model] lumen usage increment failed:', e?.message));
        }

        // NO_SPEECH pre-dispatch gate — reject a 0-word (speechless) clip here,
        // BEFORE 20-40s of GPU, using the prewarm's cached word_count. Fail-open:
        // unknown word_count dispatches exactly as today. Fresh full-render path
        // only (re-edit/resume reuse cached transcripts — no fresh prewarm).
        //
        // W1-FIX #1 (census 2026-07-25, job 8cdfef9b — a brand-new user's
        // only-ever job killed here in 121ms): when CONTENT_ROUTING_ENABLED=1
        // a 0-word clip is a ROUTE, not a rejection — the worker's zero-reject
        // routing delivers these as minimal/hype edits (organic proof: 26-46s
        // completions). Gating would pre-empt the routing that serves them, so
        // the gate runs ONLY while routing is off. This one conditional was the
        // entire post-flip error-budget miss (6/7 → the worker side was 6/6).
        const routingLive = String(process.env.CONTENT_ROUTING_ENABLED || '').trim() === '1';
        const speechGate = routingLive
          ? { gated: false }
          : await preDispatchNoSpeechGate({
              jobId: job.id, videoUrl, userId: authUser.id, pushProgressToSSE,
            });
        if (speechGate.gated) {
          // A speechless clip was rejected BEFORE any GPU work — it must NOT cost
          // the user their daily render. The slot was claimed upfront at dispatch
          // (claimDailyUsage above), so refund it INLINE here; the interval sweep
          // (lib/refund-leg.js) is only an idempotent backstop. Best-effort: a
          // refund error must never turn a clean reject into a 500.
          try {
            const { refundJobCharge } = require('./lib/refund-leg');
            await refundJobCharge(supabaseAdmin, job);
          } catch (e) {
            console.warn('  [no-speech-gate] inline quota refund failed (sweep backstop):', e?.message || e);
          }
          return sendJson(res, 200, {
            success: true, job_id: job.id, status: 'failed',
            error_code: 'NO_SPEECH', user_message: NO_SPEECH_COPY,
          });
        }

        await dispatchJobToModal({
          pushProgressToSSE,
          jobId: job.id,
          videoUrl,
          proxyVideoUrl: proxyVideoUrl || null,
          vibe: vibeInput,
          userId: authUser.id,
          premiumPipeline,
          // §5 progressive: forward the client's per-dispatch capability, AND-gated by
          // the kill switch so a preview is never PUBLISHED (never billed) while the
          // switch is off — even for a 1.3.3 client that advertised it. The 1.3.2
          // majority (no flag) never pays a preview encode regardless. Flows via the
          // Modal payload, exactly like premium_pipeline_enabled.
          supportsProgressive: body?.supports_progressive === true && progressivePlaybackEnabled(),
          prewarmHintResult: speechGate.hint, // reuse the resolved hint (no double await)
        });
        console.log('  ✅ Modal dispatch started for job:', job.id);

        return sendJson(res, 200, {
          success: true,
          job_id: job.id,
          status: job.status || 'queued',
        });
      } catch (error) {
        console.error('  ❌ Error in POST /api/video-jobs:', error);
        console.error('  Stack:', error.stack);
        const status = error?.statusCode || 500;
        console.error('[VideoEditor][VideoJobsCreate] error:', error);
        // TERMINALIZE A ROW WE ALREADY FLIPPED (2026-08-04). dispatchJobToModal
        // sets status='processing' / current_step='queued' / step_message=
        // 'Getting started...' BEFORE it spawns (dispatch-to-modal.js ~874),
        // 156 lines ahead of the Modal fetch. A throw anywhere in that window
        // lands HERE, which returned an HTTP error to the client and left the
        // row in `processing` with NO terminal and NO modal_call_id — the
        // reaper then killed it as a stall up to 50 minutes later.
        //
        // THAT IS WHY THESE WENT UNCAUGHT WHILE DISPATCH_UNREACHABLE DID NOT:
        // that class is written by dispatch's OWN guarded region, so a throw
        // before control reaches it bypasses the terminal entirely. Measured:
        // 14 of 14 stalls in 24h had current_step='queued', progress=0,
        // modal_call_id NULL and empty stage_timings — the worker never ran and
        // nothing said so. This is the "43-minute Getting started…" case.
        //
        // Fail LOUDLY into the class that already exists rather than inventing
        // one. Best-effort and last: the client response must not depend on it,
        // and markJobFailed is itself guarded against overwriting a terminal.
        try {
          if (job && job.id) {
            await markJobFailed(job.id, {
              errorCode: 'DISPATCH_UNREACHABLE',
              userMessage: 'We couldn’t start your render — please try again.',
              userId: authUser && authUser.id,
              pushProgressToSSE,
            });
            console.error(`[dispatch] ORPHANED ROW TERMINALIZED job=${job.id} — threw after the processing flip, before the spawn`);
          }
        } catch (e2) {
          console.error('  ❌ could not terminalize orphaned job:', e2?.message || e2);
        }
        return sendJson(res, status, { error: clientSafeMessage(error) });
      }
    })();
    return;
  }

  // ── Re-edit: create a derivative job from an existing completed edit ──
  // Body: { original_job_id: string, change_request: string }
  // Behavior:
  //   • Verifies caller owns the original job and it completed successfully.
  //   • If the original job has a persisted edit_recipe, runs in "tweak" mode
  //     (Gemini plan-diff → surgical render preserving everything not explicitly
  //     changed). If plan-diff classifies as reinterpret, worker auto-fuses the
  //     old vibe with the change_request and re-renders from source.
  //   • If the original is a legacy job missing edit_recipe, falls back to
  //     "reinterpret" mode: worker treats change_request as fresh creative
  //     direction combined with the old vibe, full pipeline from source.
  //   • Free-tier users consume one of their 5 edits per re-edit.
  if (parsed.pathname === '/api/video-jobs/re-edit' && req.method === 'POST') {
    (async () => {
      try {
        if (!supabaseAdmin) return sendJson(res, 500, { error: 'supabase_not_configured' });
        const authUser = await requireSupabaseUser(req);
        // MAINTENANCE GATE (known outage) — a re-edit / ask-back resume also
        // dispatches to Modal, so refuse it honestly too, before any quota or
        // dispatch. Owner is exempt (canary — see the create path).
        if (isKnownOutageActive() && String(authUser.id) !== SUBMISSION_OWNER_USER_ID) {
          console.log('  ⏸️  re-edit refused — KNOWN_OUTAGE active');
          return sendJson(res, 503, {
            error_code: 'render_paused',
            user_message: maintenanceUserMessage(),
            retryable: false,
          });
        }
        // Same budget as create — re-edits are equally expensive.
        if (!checkRateLimit(res, 'video-job-reedit', authUser.id, 10, 900)) return;
        const body = await readJsonBody(req);
        const originalJobId = String(body?.original_job_id || body?.originalJobId || '').trim();
        const changeRequest = String(body?.change_request || body?.changeRequest || '').trim();
        if (!originalJobId) return sendJson(res, 400, { error: 'original_job_id is required' });

        // ── Phase D ask-back: an ANSWER submission (carries ask_id) resumes the
        // SAME parked job in place, rather than creating a fresh re-edit. Guard,
        // validate, clear the ask, flip to processing, and re-dispatch a resume.
        if (isAnswerSubmission(body)) {
          const askId = String(body.ask_id || body.askId || '').trim();
          const validated = validateAnswer(body);
          if (!validated.ok) return sendJson(res, 400, { error: validated.error });

          // Cross-user asset guard: an answer may only reference the caller's
          // OWN uploads. Upload keys are `sources/${userId}/…`, so any other
          // key is forged/borrowed → reject (prevents folding another user's
          // S3 object into this render).
          const ownPrefix = `sources/${authUser.id}/`;
          for (const k of [validated.value.image_key, validated.value.clip_key]) {
            if (k && !k.startsWith(ownPrefix)) {
              console.log(`[ask-answer] rejected foreign asset key job=${originalJobId}`);
              return sendJson(res, 400, { error: 'invalid_asset_key' });
            }
          }

          // Load the parked job WITH its ask so the guard can match ask_id.
          const { data: parked, error: parkedErr } = await supabaseAdmin
            .from('video_jobs')
            .select('id, user_id, status, ask, video_url, vibe_input')
            .eq('id', originalJobId)
            .single();
          if (parkedErr && parkedErr.code !== 'PGRST116') {
            console.error('[ask-answer] load failed:', parkedErr);
            return sendJson(res, 500, { error: 'Failed to load job' });
          }

          // THE guard. A reject here is a SAFE no-op the client treats as
          // "already resumed / completed" — covers double-answer,
          // answer-after-timeout, stale ask, and wrong user.
          const gate = canAcceptAnswer({ job: parked, userId: authUser.id, askId });
          if (!gate.ok) {
            const code = gate.reason === 'forbidden' ? 403
              : gate.reason === 'not_found' ? 404
              : 409; // not_awaiting_input / ask_id_mismatch — stale, safe no-op
            console.log(`[ask-answer] rejected job=${originalJobId} reason=${gate.reason}`);
            return sendJson(res, code, { error: gate.reason, noop: true });
          }

          // Pro gate — parity with the change-request re-edit path (ask-back is
          // Lumen, a Pro model). Defense in depth even though the ask only ever
          // reaches Pro users. forceRcCheck so a wall-capable granted-pro is
          // rescued post-flip rather than false-402'd.
          const entitlement = await assertProEntitled(authUser.id, { forceRcCheck: wallForceRcCheck(req) });
          if (!entitlement.isPro) {
            return sendJson(res, 402, {
              error: 'pro_required', kind: 'reedit',
              message: 'Re-edit is a Pro feature. Upgrade to make changes to finished edits.',
            });
          }

          // A picked choice must be one the parked ask actually offered.
          if (validated.value.choice) {
            const offered = Array.isArray(parked.ask?.choices)
              ? parked.ask.choices.map((c) => (typeof c === 'string' ? c : (c?.value ?? c?.id))).filter(Boolean).map(String)
              : [];
            if (offered.length && !offered.includes(String(validated.value.choice))) {
              return sendJson(res, 400, { error: 'invalid_choice' });
            }
          }

          // Snapshot the parked ask so we can roll back if the resume dispatch
          // fails after we've optimistically flipped the row to processing.
          const parkedAsk = parked.ask;

          // Clear the ask + flip to processing under an OPTIMISTIC LOCK
          // (.eq('status','needs_input')) so exactly one concurrent answer wins.
          // Supabase doesn't error on 0 matched rows, so we .select() and check:
          // an empty result means another request already resumed → safe no-op.
          //
          // INVARIANT: every transition INTO 'processing' MUST stamp started_at
          // atomically. The reaper's execution wall (job-reaper.js) treats a
          // processing row whose started_at is > EXEC_WALL old as a confirmed
          // timeout death. An ask can sit in needs_input for minutes-to-hours, so
          // without re-stamping, this flip would leave started_at at the ORIGINAL
          // dispatch instant and the wall would false-reap (and refund) a healthy
          // resume mid-flight. Stamping it here makes the wall track THIS execution.
          const { data: locked, error: updErr } = await supabaseAdmin
            .from('video_jobs')
            .update({ status: 'processing', ask: null, started_at: new Date().toISOString(), current_step: 'resuming', step_message: 'Folding in your answer…' })
            .eq('id', originalJobId)
            .eq('user_id', authUser.id)
            .eq('status', 'needs_input')
            .select('id');
          if (updErr) {
            console.error('[ask-answer] update failed:', updErr);
            return sendJson(res, 500, { error: 'Failed to resume job' });
          }
          if (!locked || locked.length === 0) {
            console.log(`[ask-answer] lost race job=${originalJobId} — already resumed`);
            return sendJson(res, 409, { error: 'not_awaiting_input', noop: true });
          }

          console.log(`[ask-answer] resuming job=${originalJobId} ask=${askId} skip=${validated.value.skip}`);
          try {
            await dispatchJobToModal({
              pushProgressToSSE,
              jobId: originalJobId,
              videoUrl: parked.video_url || '',
              vibe: parked.vibe_input || '',
              userId: authUser.id,
              mode: 'resume_ask',
              resumeAsk: true,
              askId,
              answer: validated.value,
              parentJobId: originalJobId,
            });
          } catch (dispatchErr) {
            // The row is already flipped to processing but no worker is running.
            // Roll it back to needs_input with the ORIGINAL ask so the client's
            // retry (which didn't get a 200, so it stayed on the ask) is accepted
            // again and nothing is stranded on an infinite spinner.
            console.error('[ask-answer] resume dispatch failed, rolling back:', dispatchErr);
            await supabaseAdmin
              .from('video_jobs')
              .update({ status: 'needs_input', ask: parkedAsk, current_step: null, step_message: null })
              .eq('id', originalJobId)
              .eq('user_id', authUser.id)
              .eq('status', 'processing');
            return sendJson(res, 503, { error: 'resume_dispatch_failed', retryable: true });
          }

          return sendJson(res, 200, { success: true, job_id: originalJobId, status: 'processing', resumed: true });
        }

        if (!changeRequest) return sendJson(res, 400, { error: 'change_request is required' });

        // Load the original job — must exist, belong to this user, and have a source URL
        const { data: orig, error: origErr } = await supabaseAdmin
          .from('video_jobs')
          .select('id, user_id, status, video_url, vibe_input, edit_recipe, transcript, analysis_data, resolved_broll, trend_snapshot')
          .eq('id', originalJobId)
          .single();
        if (origErr || !orig) {
          return sendJson(res, 404, { error: 'Original edit not found' });
        }
        if (orig.user_id !== authUser.id) {
          return sendJson(res, 403, { error: 'Not authorized to re-edit this video' });
        }
        if (!orig.video_url) {
          return sendJson(res, 400, { error: 'Original job has no source video — cannot re-edit' });
        }
        if (orig.status !== 'completed') {
          return sendJson(res, 400, { error: 'Only completed edits can be re-edited' });
        }

        // Re-edit door (wall N+1): paid-only capability. Knob OFF (default) →
        // byte-for-byte today: any Pro entitlement (incl. active trial) passes,
        // free gets the 402 so the paywall sheet pops with the right "Re-edit
        // is a Pro feature" copy. Knob ON → enforced `.none` gets the wall
        // (403), and a limited TRIAL gets the 402 paywall (re-edit stays paid).
        const entitlement = await assertProEntitled(authUser.id, { forceRcCheck: wallForceRcCheck(req) });
        const reeditTier = tierFromEntitlement(entitlement);
        const reeditEnforce = resolveEnforce({
          headers: req.headers,
          accountCreatedAt: (entitlement.row || {}).created_at,
        });
        const reeditCaps = capabilities(effectiveTier(reeditTier, reeditEnforce));
        if (!reeditCaps.appUsable) {
          console.log('  [wall] 403 wall_required (re-edit) userId=%s tier=%s', authUser.id, reeditTier);
          return sendJson(res, 403, { error: 'wall_required', route: 'wall', message: wallRequiredMessage() });
        }
        if (!reeditCaps.reedit) {
          return sendJson(res, 402, {
            error: 'pro_required',
            kind: 'reedit',
            route: 'paywall',
            message: 'Re-edit is a Pro feature. Upgrade to make changes to finished edits.',
          });
        }

        // Mode resolution: tweak requires a saved edit_recipe; otherwise reinterpret.
        const hasSavedPlan = orig.edit_recipe && typeof orig.edit_recipe === 'object';
        const mode = hasSavedPlan ? 'tweak' : 'reinterpret';
        console.log(`[re-edit] originalJobId=${originalJobId} mode=${mode} changeRequest="${changeRequest.slice(0, 120)}"`);

        // Create the derivative job. vibe_input stays as the ORIGINAL vibe for the
        // dispatch call; the worker's plan-diff fuses it with change_request for
        // reinterpret, or uses it as the "prior vibe" grounding for tweak.
        const newJob = await createQueuedVideoJob({
          userId: authUser.id,
          videoUrl: orig.video_url,
          vibeInput: orig.vibe_input || 'Re-edit',
          appVersion: clientAppVersion(req),
        });
        console.log(`[re-edit] New job ${newJob.id} created (parent=${originalJobId})`);

        await dispatchJobToModal({
          pushProgressToSSE,
          jobId: newJob.id,
          videoUrl: orig.video_url,
          vibe: orig.vibe_input || '',
          userId: authUser.id,
          // Re-edit payload
          mode,
          editPlan: hasSavedPlan ? orig.edit_recipe : null,
          transcript: orig.transcript || null,
          analysisData: orig.analysis_data || null,
          resolvedBroll: Array.isArray(orig.resolved_broll) ? orig.resolved_broll : null,
          trendSnapshot: orig.trend_snapshot || null,
          changeRequest,
          oldVibe: orig.vibe_input || '',
          parentJobId: originalJobId,
        });

        return sendJson(res, 200, {
          success: true,
          job_id: newJob.id,
          status: newJob.status || 'queued',
          mode,
          parent_job_id: originalJobId,
        });
      } catch (error) {
        console.error('[re-edit] Error:', error);
        const status = error?.statusCode || 500;
        return sendJson(res, status, { error: error?.message || 'Re-edit failed' });
      }
    })();
    return;
  }

  const videoJobsStatusMatch = parsed.pathname && parsed.pathname.match(/^\/api\/video-jobs\/([^/]+)$/i);
  if (videoJobsStatusMatch && req.method === 'GET') {
    (async () => {
      console.log('\n🔍 GET /api/video-jobs/:jobId REQUEST');
      console.log('  URL:', req.url);
      console.log('  Job ID:', videoJobsStatusMatch[1]);
      try {
        if (!supabaseAdmin) {
          return sendJson(res, 500, { error: 'supabase_not_configured' });
        }
        const authUser = await requireSupabaseUser(req);
        const jobId = decodeURIComponent(videoJobsStatusMatch[1] || '').trim();
        console.log('  User ID:', authUser.id);
        if (!jobId) return sendJson(res, 400, { error: 'jobId is required' });

        // Runaway-poll guard. A client (on ANY shipped build) that polls a job it
        // will never own — job_never_existed or identity_mismatch — otherwise hits
        // the DB ~1.3x/sec forever (38,070 such 404s in one 24h window). Once a
        // (user,job) has 404'd enough to be confirmed dead, short-circuit every
        // later poll WITHOUT a query. The client ignores 429, so this bites with no
        // release; the 429 + Retry-After is a correct signal for any future build.
        const guardKey = `${authUser.id}:${jobId}`;
        const guardNow = Date.now();
        const guarded = _jobStatusGuard.check(guardKey, guardNow);
        if (guarded.shortCircuit) {
          res.setHeader('Retry-After', '30');
          return sendJson(res, 429, {
            error: 'Job not found',
            cause: guarded.cause,
            retry_after_seconds: 30,
          });
        }

        const { data, error } = await supabaseAdmin
          .from('video_jobs')
          .select('id, user_id, status, progress, current_step, step_message, ask, rendered_video_url, hls_manifest_url, thumbnail_url, result_url, error_message, created_at, completed_at, updated_at')
          .eq('id', jobId)
          .eq('user_id', authUser.id)
          .order('updated_at', { ascending: false })
          .maybeSingle();

        if (error) {
          console.error('  ❌ Database error:', error);
          return sendJson(res, 500, { error: 'Failed to fetch job status' });
        }
        if (!data) {
          // Split the cause ONCE: does the id exist under ANY user_id? A row under a
          // different user is an identity_mismatch (a real, different bug); no row at
          // all is job_never_existed (upload/create never landed). Bounded — the DB
          // 404 path runs at most `shortCircuitAfter` times per id before short-circuit.
          let cause = 'job_never_existed';
          try {
            const probe = await supabaseAdmin
              .from('video_jobs')
              .select('user_id')
              .eq('id', jobId)
              .limit(1)
              .maybeSingle();
            if (probe.data && probe.data.user_id && String(probe.data.user_id) !== String(authUser.id)) {
              cause = 'identity_mismatch';
            }
          } catch (_) { /* probe is best-effort; default cause stands */ }

          const rec = _jobStatusGuard.record404(guardKey, cause, guardNow);
          console.warn(`  ❌ Job not found [cause=${cause} count=${rec.count}]`);

          // Persist the cause EXACTLY once per (user,job) so the 404 volume is
          // attributable by cause. Server-side insert bypasses the /api/events
          // client allowlist — the same path the api_outcome ledger uses.
          // Fire-and-forget; never blocks or fails the response.
          if (rec.emitFirst && supabaseAdmin) {
            supabaseAdmin
              .from('analytics_events')
              .insert({ event: 'jobstatus_404', props: { cause, job_id: jobId, user_id: authUser.id, route: '/api/video-jobs/:id' } })
              .then(() => {}, () => {});
          }

          res.setHeader('Retry-After', '30');
          return sendJson(res, rec.shortCircuit ? 429 : 404, {
            error: 'Job not found',
            cause,
            retry_after_seconds: 30,
          });
        }
        _jobStatusGuard.clear(guardKey);
        console.log('  ✅ Job found, status:', data.status);

        // Prevent any caching of job status
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');

        return sendJson(res, 200, {
          id: data.id,
          status: data.status,
          progress: Number(data.progress || 0),
          current_step: data.current_step || '',
          step_message: data.step_message || '',
          ask: data.ask || null,
          rendered_video_url: data.rendered_video_url || data.result_url || null,
          hls_manifest_url: data.hls_manifest_url || null,
          thumbnail_url: data.thumbnail_url || null,
          result_url: data.result_url || null,
          error: data.error_message || null,
          error_message: data.error_message || null,
          created_at: data.created_at || null,
          completed_at: data.completed_at || null,
        });
      } catch (error) {
        console.error('  ❌ Error:', error);
        const status = error?.statusCode || 500;
        console.error('[VideoEditor][VideoJobsStatus] error:', error);
        return sendJson(res, status, { error: clientSafeMessage(error) });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/video-jobs' && req.method === 'GET') {
    (async () => {
      try {
        if (!supabaseAdmin) {
          return sendJson(res, 500, { error: 'supabase_not_configured' });
        }
        const authUser = await requireSupabaseUser(req);
        const requestedUserId = String(parsed.query?.user_id || '').trim();
        if (requestedUserId && requestedUserId !== authUser.id) {
          return sendJson(res, 403, { error: 'Forbidden' });
        }
        const { data, error } = await supabaseAdmin
          .from('video_jobs')
          .select('id, status, progress, current_step, result_url, error_message, created_at, completed_at, updated_at')
          .eq('user_id', authUser.id)
          .order('created_at', { ascending: false })
          .limit(100);

        if (error) return sendJson(res, 500, { error: 'Failed to fetch jobs' });
        return sendJson(res, 200, {
          jobs: (data || []).map((job) => ({
            id: job.id,
            status: job.status,
            progress: Number(job.progress || 0),
            current_step: job.current_step || job.status,
            result_url: job.result_url || null,
            error_message: job.error_message || null,
            created_at: job.created_at || null,
            completed_at: job.completed_at || null,
          })),
        });
      } catch (error) {
        const status = error?.statusCode || 500;
        console.error('[VideoEditor][VideoJobsList] error:', error);
        return sendJson(res, status, { error: clientSafeMessage(error) });
      }
    })();
    return;
  }

  const videoJobMatch = parsed.pathname && parsed.pathname.match(/^\/api\/jobs\/([^/]+)$/i);
  if (videoJobMatch && req.method === 'GET') {
    (async () => {
      try {
        if (!supabaseAdmin) {
          return sendJson(res, 500, { error: 'supabase_not_configured' });
        }

        // Authenticate + scope to the caller's own jobs (edit_jobs has a
        // user_id column). Previously any UUID could read another user's job
        // status + rendered_video_url.
        const authUser = await requireSupabaseUser(req);

        const jobId = decodeURIComponent(videoJobMatch[1] || '').trim();
        if (!jobId) return sendJson(res, 400, { error: 'jobId is required' });

        const { data, error } = await supabaseAdmin
          .from('edit_jobs')
          .select('id, status, progress, rendered_video_url, error, updated_at, completed_at')
          .eq('id', jobId)
          .eq('user_id', authUser.id)
          .maybeSingle();

        if (error) {
          console.error('[VideoEditor][JobStatus] Database error:', error);
          return sendJson(res, 500, { error: 'Failed to fetch job status' });
        }
        if (!data) {
          return sendJson(res, 404, { error: 'Job not found' });
        }

        return sendJson(res, 200, data);
      } catch (error) {
        const status = error?.statusCode || 500;
        console.error('[VideoEditor][JobStatus] error:', error);
        return sendJson(res, status, { error: clientSafeMessage(error) });
      }
    })();
    return;
  }

  // POST /api/video-jobs/:jobId/refresh-urls
  // Returns fresh signed video + thumbnail URLs for an existing job.
  // AWS SigV4 caps signed URLs at 7 days, so any chat older than a week
  // has dead URLs without this. Client calls this when AsyncImage /
  // AVPlayer hits a 403/expired error and re-tries with the fresh URL.
  const refreshUrlsMatch = parsed.pathname && parsed.pathname.match(/^\/api\/video-jobs\/([^/]+)\/refresh-urls$/i);
  if (refreshUrlsMatch && req.method === 'POST') {
    (async () => {
      try {
        if (!supabaseAdmin) return sendJson(res, 500, { error: 'supabase_not_configured' });
        const authUser = await requireSupabaseUser(req);
        // Cheap endpoint but easy to abuse — cap at 60/min per user.
        if (!checkRateLimit(res, 'refresh-urls', authUser.id, 60, 60)) return;
        const jobId = decodeURIComponent(refreshUrlsMatch[1] || '').trim();
        if (!jobId) return sendJson(res, 400, { error: 'jobId is required' });

        const { data: job, error } = await supabaseAdmin
          .from('video_jobs')
          .select('id, user_id, rendered_video_url, thumbnail_url')
          .eq('id', jobId)
          .maybeSingle();

        if (error) {
          console.error('[refresh-urls] DB error:', error);
          return sendJson(res, 500, { error: 'Failed to load job' });
        }
        if (!job) return sendJson(res, 404, { error: 'Job not found' });
        if (job.user_id !== authUser.id) return sendJson(res, 403, { error: 'Forbidden' });

        // Extract the underlying S3 key from a signed URL by stripping
        // hostname and query string. Falls back to null for non-S3 URLs
        // (e.g. legacy Supabase Storage URLs from old renders) — those
        // get returned as-is since Supabase signed URLs run for 1 year.
        const extractS3Key = (urlStr) => {
          if (!urlStr) return null;
          try {
            const u = new URL(urlStr);
            // Only refresh URLs that point at OUR S3 bucket (any endpoint
            // pattern: regional, accelerate, CloudFront).
            const isOurBucket =
              u.hostname.includes(s3.S3_BUCKET) ||
              (process.env.CLOUDFRONT_DOMAIN && u.hostname.endsWith(process.env.CLOUDFRONT_DOMAIN));
            if (!isOurBucket) return null;
            return u.pathname.replace(/^\/+/, '') || null;
          } catch {
            return null;
          }
        };

        const videoKey = extractS3Key(job.rendered_video_url);
        const thumbKey = extractS3Key(job.thumbnail_url);

        let videoUrl = job.rendered_video_url || null;
        let thumbnailUrl = job.thumbnail_url || null;

        if (videoKey) {
          videoUrl = await s3.createPresignedGetUrl(videoKey, 60 * 60 * 24 * 7);
        }
        if (thumbKey) {
          thumbnailUrl = await s3.createPresignedGetUrl(thumbKey, 60 * 60 * 24 * 7);
        }

        return sendJson(res, 200, { videoUrl, thumbnailUrl });
      } catch (error) {
        const status = error?.statusCode || 500;
        console.error('[refresh-urls] error:', error?.message);
        return sendJson(res, status, { error: clientSafeMessage(error) });
      }
    })();
    return;
  }

  // ── Export gate — server-enforced monetization wall (shipped DARK ahead of 225) ──
  // The conversion data says the 3/day render cap engages only 0.5% of users, so
  // EXPORT becomes the real revenue wall. It is enforced SERVER-SIDE from the same
  // authoritative DB/RC path renders use (assertProEntitled) — NEVER a client flag
  // — and delivers only a SHORT-TTL SIGNED url, never a public one. Shipped dark:
  //   • gate_probe:true → the entitlement DECISION only (no mint/meter). Always
  //     answers, independent of the flag, so deploy-sanity can prove both
  //     directions (free→402, pro→200) on every roll.
  //   • real call → inert 501 until EXPORT_GATE_ENABLED=1 AND 225 wires the client
  //     + a private clean-asset. Nothing changes for anyone until then.
  // ALIAS (lane/delivery 2026-08-11): /api/jobs/:id/export → the SAME gate.
  // The client-shape route lands on the identical entitlement + quota + private-
  // asset logic; only the job_id source differs (path vs body). NOTE for the
  // client half (reports/EXPORT_CLIENT_HALF.md): the SHIPPED app falls back to
  // the public save on ANY export failure, so this server gate alone cannot
  // fully wall exports — the fallback removal rides the owner's final iOS build.
  const _exportAliasMatch = req.method === 'POST'
    ? parsed.pathname.match(/^\/api\/jobs\/([0-9a-f-]{8,64})\/export$/i)
    : null;
  if ((parsed.pathname === '/api/export' && req.method === 'POST') || _exportAliasMatch) {
    (async () => {
      const jobIdFromPath = _exportAliasMatch ? _exportAliasMatch[1] : null;
      let authUser;
      try { authUser = await requireSupabaseUser(req); }
      catch { return sendJson(res, 401, { error: 'unauthorized' }); }
      if (!checkRateLimit(res, 'export', authUser.id, 60, 60)) return;
      const body = await readJsonBody(req).catch(() => ({}));

      // SERVER-SIDE entitlement — the same authoritative decision the render gate
      // uses. A client 'isPro'/'tier' field NEVER influences this.
      let decision;
      try { decision = await assertProEntitled(authUser.id); }
      catch (e) { console.error('[export] entitlement check failed:', e?.message); decision = { isPro: false, reason: 'entitlement_error' }; }
      const allowed = decision.isPro === true; // 225 may widen with a metered free-export allowance

      // Dry-run (deploy-sanity + client preview): decision only, no side effects.
      if (body && body.gate_probe === true) {
        return sendJson(res, allowed ? 200 : 402, { allowed, tier: allowed ? 'paid' : 'free', reason: decision.reason });
      }

      // DARK: real exports inert until the flag flips + the private asset exists.
      if (String(process.env.EXPORT_GATE_ENABLED || '') !== '1') {
        return sendJson(res, 501, { error: 'export_not_enabled' });
      }

      // Load the job + the ERRORS-owned private key. KEY CONTRACT: clean master at
      // exports/{job_id}/clean.mp4, recorded on result.clean_export_key (nullable).
      const jobId = String(jobIdFromPath || (body && body.job_id) || '').trim();
      if (!jobId) return sendJson(res, 400, { error: 'job_id required' });
      const { data: job, error } = await supabaseAdmin.from('video_jobs')
        .select('id, user_id, result').eq('id', jobId).maybeSingle();
      if (error) return sendJson(res, 500, { error: 'load_failed' });
      if (!job || job.user_id !== authUser.id) return sendJson(res, 404, { error: 'not_found' });

      const cleanKey = job.result && job.result.clean_export_key;
      // NULL key → 404 FIRST, BEFORE the paywall: an old job has no private asset,
      // so the client falls back to the public save. A 402 must NEVER be returned
      // for a missing key (that would show "upgrade" instead of the fallback).
      if (!cleanKey) return sendJson(res, 404, { error: 'no_private_asset' });

      // WALL (Zac 2026-08-04): Pro = unlimited; a free user gets ONE free export,
      // then 402. Under the ERRORS model there is NO degraded public asset, so the
      // public≠clean check is trivially satisfied and cannot be the wall — THE
      // COUNTER IS THE WALL. Fail-CLOSED on a count error (never give the product
      // away on a DB blip). NOTE: getFeatureUsageCount→increment is not atomic;
      // arming MUST switch to an atomic claim (claim_usage_slot-style) to close the
      // parallel-double-free-export race — tracked in the export spec.
      const FREE_EXPORT_LIMIT = parseInt(process.env.FREE_EXPORT_LIMIT || '1', 10);
      if (!allowed) {
        let used;
        try { used = await getFeatureUsageCount(supabaseAdmin, authUser.id, 'export'); }
        catch (e) { console.error('[export] usage-count failed — fail CLOSED (revenue wall):', e?.message); used = FREE_EXPORT_LIMIT; }
        if (used >= FREE_EXPORT_LIMIT) {
          return sendJson(res, 402, { error: 'upgrade_required', free_exports_used: used, free_export_limit: FREE_EXPORT_LIMIT });
        }
      }

      // Allowed (Pro unlimited, or free within quota): mint + record the export.
      // WATERMARK-AT-EXPORT v1 (dark behind EXPORT_WATERMARK_ENABLED=1): the
      // FREE-quota export ships watermarked; Pro ships the clean master. A
      // watermark failure falls back to the clean asset LOUDLY — a paying-
      // funnel free export must never 500 on an overlay pass. Policy variants
      // (watermark-instead-of-402 beyond quota) are documented in
      // reports/EXPORT_CLIENT_HALF.md and deliberately NOT built into v1.
      let mintKey = cleanKey;
      let watermarked = false;
      if (!allowed && String(process.env.EXPORT_WATERMARK_ENABLED || '') === '1') {
        try {
          const { ensureWatermarkedExport } = require('./lib/export-watermark');
          mintKey = await ensureWatermarkedExport({ s3, jobId, cleanKey });
          watermarked = true;
        } catch (e) {
          console.error(`[export] WATERMARK FAILED job=${jobId} — serving clean fallback (defect, count me):`, e?.message);
          supabaseAdmin.from('analytics_events').insert({
            event: 'export_watermark_failed', platform: 'server',
            props: { job_id: jobId, error: String(e?.message || '').slice(0, 160) },
          }).then(() => {}).catch(() => {});
          mintKey = cleanKey;
        }
      }
      const url = await s3.createPresignedGetUrl(mintKey, 300);
      try { await incrementFeatureUsage(supabaseAdmin, authUser.id, 'export'); }
      catch (e) { console.error('[export] usage-increment failed (non-fatal):', e?.message); }
      return sendJson(res, 200, { url, expires_in: 300, watermarked });
    })();
    return;
  }

  // Register an APNs device token for the current user. Idempotent —
  // upserts on the unique token column. Bumps last_seen_at on every call so
  // we can prune long-dead tokens with a cron job later if needed.
  if (parsed.pathname === '/api/devices/register' && req.method === 'POST') {
    (async () => {
      try {
        if (!supabaseAdmin) return sendJson(res, 500, { error: 'supabase_not_configured' });
        const authUser = await requireSupabaseUser(req);
        if (!checkRateLimit(res, 'devices-register', authUser.id, 30, 60)) return;

        const body = await readJsonBody(req);
        const token = (body?.token || '').trim();
        const platform = (body?.platform || 'ios').trim();
        const bundleId = (body?.bundle_id || '').trim();
        const appVersion = body?.app_version ? String(body.app_version).slice(0, 32) : null;

        if (!token || token.length < 32 || token.length > 256) {
          return sendJson(res, 400, { error: 'invalid_token' });
        }
        if (platform !== 'ios') return sendJson(res, 400, { error: 'invalid_platform' });
        if (!bundleId) return sendJson(res, 400, { error: 'bundle_id_required' });

        const { error } = await supabaseAdmin
          .from('device_tokens')
          .upsert({
            user_id: authUser.id,
            token,
            platform,
            bundle_id: bundleId,
            app_version: appVersion,
            last_seen_at: new Date().toISOString(),
          }, { onConflict: 'token' });

        if (error) {
          console.error('[devices-register] DB error:', error);
          return sendJson(res, 500, { error: 'register_failed' });
        }
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        const status = error?.statusCode || 500;
        console.error('[devices-register] error:', error?.message);
        return sendJson(res, status, { error: clientSafeMessage(error) });
      }
    })();
    return;
  }

  // Unregister a token (called on sign-out). Best-effort.
  if (parsed.pathname === '/api/devices/unregister' && req.method === 'POST') {
    (async () => {
      try {
        if (!supabaseAdmin) return sendJson(res, 500, { error: 'supabase_not_configured' });
        const authUser = await requireSupabaseUser(req);
        const body = await readJsonBody(req);
        const token = (body?.token || '').trim();
        if (!token) return sendJson(res, 400, { error: 'token_required' });
        await supabaseAdmin
          .from('device_tokens')
          .delete()
          .eq('user_id', authUser.id)
          .eq('token', token);
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        const status = error?.statusCode || 500;
        return sendJson(res, status, { error: clientSafeMessage(error) });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/cron/process-jobs' && req.method === 'GET') {
    (async () => {
      try {
        if (!supabaseAdmin) {
          return sendJson(res, 500, { error: 'supabase_not_configured' });
        }

        const authHeader = req.headers.authorization;
        if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
          return sendJson(res, 401, { error: 'Unauthorized' });
        }

        const { data: jobs, error } = await supabaseAdmin
          .from('edit_jobs')
          .select('*')
          .eq('status', 'queued')
          .order('created_at', { ascending: true })
          .limit(3);

        if (error) throw new Error(`Failed to fetch queued jobs: ${error.message}`);

        if (!jobs || jobs.length === 0) {
          return sendJson(res, 200, { message: 'No queued jobs', processed: 0, results: [] });
        }

        const { processEditJob } = require('./lib/video-processor/process-job');

        const results = await Promise.all(
          jobs.map(async (job) => {
            try {
              console.log(`[VideoEditor][Cron] Processing job ${job.id}...`);
              const finalVideoUrl = await processEditJob(job);
              console.log(`[VideoEditor][Cron] Job ${job.id} complete`);
              return { jobId: job.id, success: true, videoUrl: finalVideoUrl };
            } catch (jobError) {
              console.error(`[VideoEditor][Cron] Job ${job.id} failed:`, jobError?.message || jobError);
              return { jobId: job.id, success: false, error: jobError?.message || 'Unknown error' };
            }
          })
        );

        return sendJson(res, 200, {
          message: 'Cron job completed',
          processed: jobs.length,
          results,
        });
      } catch (error) {
        const status = error?.statusCode || 500;
        console.error('[VideoEditor][Cron] Fatal error:', error);
        return sendJson(res, status, { error: error?.message || 'Internal cron error' });
      }
    })();
    return;
  }

  // Serve favicon from SVG asset to avoid 404s
  if (parsed.pathname === '/favicon.ico') {
    const fav = path.join(__dirname, 'assets', 'promptly-mark-white.png');
    try {
      if (fs.existsSync(fav)) {
        return serveFile(fav, res);
      }
    } catch {}
    // If not found, return 204 No Content instead of 404
    res.writeHead(204);
    return res.end();
  }

  // Serve apple touch icon path if requested by iOS (fallback to SVG)
  if (parsed.pathname === '/apple-touch-icon.png') {
    const apple = path.join(__dirname, 'assets', 'promptly-mark-white.png');
    try {
      if (fs.existsSync(apple)) {
        return serveFile(apple, res);
      }
    } catch {}
    res.writeHead(204);
    return res.end();
  }

  // Optional canonical host redirect to enforce a single domain (e.g., promptlyapp.com)
  const pathLower = typeof parsed.pathname === 'string' ? parsed.pathname.toLowerCase() : '';
  const isApiRequest = pathLower.startsWith('/api/') || req.method !== 'GET';
  if (CANONICAL_HOST && !isApiRequest) {
    const reqHost = (req.headers && req.headers.host) ? String(req.headers.host) : '';
    // Strip port if present for comparison
    const normalize = (h) => String(h || '').replace(/:\d+$/, '');
    if (reqHost && normalize(reqHost).toLowerCase() !== normalize(CANONICAL_HOST).toLowerCase()) {
      const location = `https://${CANONICAL_HOST}${parsed.path || parsed.pathname || '/'}`;
      res.writeHead(301, { Location: location });
      return res.end();
    }
  }
  if (req.method === 'GET') {
    if (parsed.pathname === '/js/landing.js') {
      const landingScript = path.join(__dirname, 'js', 'landing.js');
      if (fs.existsSync(landingScript)) {
        return serveFile(landingScript, res);
      }
    }
    // The in-app-browser escape module (vanilla, no deps).
    if (parsed.pathname === '/js/inapp-browser-escape.js') {
      const f = path.join(__dirname, 'js', 'inapp-browser-escape.js');
      if (fs.existsSync(f)) return serveFile(f, res);
    }
    // Acquisition landing — the destination for Instagram/TikTok bio links.
    // Meta/TikTok in-app browsers swallow taps on apps.apple.com, and NO script
    // can run on a direct store link, so the bio link must point HERE, where the
    // escape module breaks out to Safari (or shows instructions) and the UA-split
    // + breakout funnel get measured. Repoint bio links → https://usepromptly.app/get
    if (parsed.pathname === '/get' || parsed.pathname === '/download' || parsed.pathname === '/app') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderGetLanding());
    }
    // Editor and calendar removed — mobile-only app. Redirect to landing.
    if (parsed.pathname === '/editor' || parsed.pathname === '/calendar' || parsed.pathname === '/calendar.html' || parsed.pathname === '/library.html') {
      res.writeHead(302, { 'Location': '/' });
      return res.end();
    }

    // Public result page — the completion-email deep link lands HERE, on the
    // SPECIFIC job's rendered video (never a generic app open). The
    // rendered_video_url is already a public, unsigned CloudFront URL that the
    // app ShareLinks openly, and the jobId is already in that CDN path, so this
    // page exposes nothing the video URL doesn't — no PII, no job metadata, no
    // status/error, no auth. Only a COMPLETED job renders the player; anything
    // else (missing / processing / failed) gets one neutral page, so the route
    // never confirms a job's existence or state.
    const resultPageMatch = parsed.pathname && parsed.pathname.match(/^\/v\/([a-zA-Z0-9-]{8,})$/);
    if (resultPageMatch) {
      const jobId = resultPageMatch[1];
      (async () => {
        let ready = null;
        try {
          if (supabaseAdmin) {
            const { data } = await supabaseAdmin.from('video_jobs')
              .select('status, rendered_video_url')
              .eq('id', jobId).maybeSingle();
            if (data && data.status === 'completed' && data.rendered_video_url) {
              // Poster deliberately omitted: thumbnail_url is a presigned S3 URL
              // that expires within days, so on an email opened later it would rot
              // to a broken image. The rendered video's first frame
              // (preload=metadata) serves as the preview instead.
              //
              // MINT PER LOAD (2026-08-23, posture step 4). This page is
              // SERVER-RENDERED on every request and sent with
              // Cache-Control: no-store, so it can hand out a short-lived grant
              // and still work forever — the durable thing we share is the
              // opaque /v/{jobId} link, not the asset URL. That is what makes
              // restricting renders/ possible without touching the viral path:
              // the share link keeps working, the permanent hotlink stops.
              //
              // 6 hours, not 7 days: long enough that a page left open in a tab
              // still downloads, short enough that a scraped <video src> is not
              // a durable public link. Re-minted free on the next load.
              let shareUrl = data.rendered_video_url;
              try {
                const _s3 = require('./services/s3');
                const _k = require('./lib/source-presence').sourceKeyFromUrl(data.rendered_video_url);
                if (_k) shareUrl = await _s3.createPresignedGetUrl(_k, 6 * 3600);
              } catch (e) {
                // Fail OPEN to the stored url. While renders/ is public that
                // still plays; once it is restricted this line is the failure
                // that matters, so it is logged rather than swallowed.
                console.error(`[result-page] share presign FAILED for ${jobId}: ${e && e.message}`
                  + ' — falling back to the stored url (works only while renders/ is public)');
              }
              ready = { videoUrl: shareUrl };
            }
          }
        } catch (e) { console.warn('[result-page] lookup failed:', e && e.message); }
        res.writeHead(ready ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(renderResultPage(ready));
      })();
      return;
    }
  }

  // Calendar + Brand Brain features removed: hard-disable legacy endpoints.
  const removedFeaturePath = String(parsed.pathname || '');
  if (
    removedFeaturePath === '/api/generate-calendar' ||
    removedFeaturePath === '/api/brand-brain/settings' ||
    removedFeaturePath.startsWith('/api/calendar') ||
    // Brand Brain is retired; /api/brand/ingest + /api/brand/profile were
    // orphaned (no live caller) and unauthenticated — they trusted a
    // client-supplied userId, allowing cross-user writes/reads via the
    // service-role client and unbounded OpenAI-embedding spend. Kill them here.
    removedFeaturePath.startsWith('/api/brand/') ||
    /^\/api\/calendars\/[^/]+$/i.test(removedFeaturePath)
  ) {
    res.writeHead(410, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        error: 'feature_removed',
        message: 'Content Calendar and Brand Brain features have been removed.',
      })
    );
  }

  // Helper: serve static file with optional gzip if client supports
  function stripCspMeta(html) {
    return html.replace(/<meta[^>]*http-equiv=["']content-security-policy["'][^>]*>/gi, '');
  }

  function injectNonceIntoInlineScripts(html, nonce) {
    return html.replace(/<script\b([^>]*)>/gi, (match, attrs) => {
      if (/\snonce\s*=/i.test(attrs)) return match;
      if (/\ssrc\s*=/i.test(attrs)) return match;
      return `<script nonce="${nonce}"${attrs}>`;
    });
  }

  function scanInlineScriptsWithoutNonce(html) {
    const regex = /<script\b(?![^>]*\bnonce\s*=)(?![^>]*\bsrc\s*=)[^>]*>/ig;
    let count = 0;
    let snippet = null;
    let match;
    while ((match = regex.exec(html)) !== null) {
      count += 1;
      if (!snippet) {
        const start = Math.max(0, match.index - 100);
        const end = Math.min(html.length, match.index + match[0].length + 100);
        snippet = html.slice(start, end);
      }
    }
    return { count, snippet };
  }

  function hasInlineHandlers(html) {
    return /\son[a-z]+\s*=\s*["']/i.test(html);
  }

  function serveFile(filePath, res) {
    try {
      const ext = path.extname(filePath).toLowerCase();
      const typeMap = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon'
      };
      let raw = fs.readFileSync(filePath);
      const accept = req.headers['accept-encoding'] || '';
      // Only compress text-like content
      const isText = /\.(html|css|js|json|txt)$/i.test(filePath);
      const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
      const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
      const isHttps = proto === 'https' || req.socket?.encrypted === true;
      const isProdHost = host === 'usepromptly.app' || host === 'www.usepromptly.app';
      const isProdRequest = isProdHost && isHttps;
      if (ext === '.html' && !isProdRequest) {
        console.info('Contentsquare disabled on dev host');
      }
      if (ext === '.html') {
        const snippet = '<script src="https://t.contentsquare.net/uxa/9aea871ffd8c7.js"></script>';
        let html = raw.toString('utf8');
        html = stripCspMeta(html);
        if (!isProdRequest) {
          if (html.includes(snippet)) {
            const newline = html.includes('\r\n') ? '\r\n' : '\n';
            const lines = html.split(/\r?\n/);
            html = lines.filter((line) => line.trim() !== snippet).join(newline);
          }
        } else if (!html.includes(snippet)) {
          const lower = html.toLowerCase();
          const headIndex = lower.indexOf('</head>');
          if (headIndex !== -1) {
            const newline = html.includes('\r\n') ? '\r\n' : '\n';
            const before = html.slice(0, headIndex);
            const after = html.slice(headIndex);
            const lastNl = before.lastIndexOf('\n');
            let indent = '';
            if (lastNl !== -1) {
              const line = before.slice(lastNl + 1);
              indent = line.match(/^\s*/)?.[0] || '';
            }
            html = `${before}${newline}${indent}${snippet}${newline}${after}`;
          }
        }
        html = injectNonceIntoInlineScripts(html, cspNonce);
        if (!isProdRequest) {
          const base = path.basename(filePath).toLowerCase();
          if (base === 'terms.html' && !TERMS_CSP_LOGGED) {
            const inlineScan = scanInlineScriptsWithoutNonce(html);
            const inlineHandlers = hasInlineHandlers(html);
            if (inlineScan.count > 0 || inlineHandlers) {
              console.info('[CSP][NonceCheck]', {
                file: base,
                nonce: cspNonce,
                missingNonceCount: inlineScan.count,
                inlineHandlers,
                snippet: inlineScan.count > 0 ? inlineScan.snippet : null,
              });
              TERMS_CSP_LOGGED = true;
            }
          }
        }
        raw = Buffer.from(html, 'utf8');
      }
      // Override content-type for JSON-LD schema files to satisfy validators
      try {
        const base = path.basename(filePath);
        const isSchemaJson = filePath.includes(path.join('assets', path.sep)) && /^schema-.*\.json$/i.test(base);
        if (isSchemaJson) {
          res.setHeader('Content-Type', 'application/ld+json; charset=utf-8');
        }
      } catch {}
      if (isText && accept.includes('gzip')) {
        try {
          const zlib = require('zlib');
          const gz = zlib.gzipSync(raw);
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Vary', 'Accept-Encoding');
          if (!res.getHeader('Content-Type')) {
            res.setHeader('Content-Type', typeMap[ext] || 'application/octet-stream');
          }
          res.writeHead(200);
          return res.end(gz);
        } catch (e) {
          // Fallback to raw
        }
      }
      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', typeMap[ext] || 'application/octet-stream');
      }
      res.writeHead(200);
      return res.end(raw);
    } catch (e) {
      res.writeHead(404);
      return res.end('Not found');
    }
  }

  // Handle clean URLs (e.g., /success -> /success.html)
  let safePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  let filePath = path.join(__dirname, path.normalize(safePath));

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Forbidden' }));
  }

    fs.stat(filePath, (err, stats) => {
      // If file not found and no extension, try adding .html
      if (err && !path.extname(safePath)) {
        safePath = safePath + '.html';
        filePath = path.join(__dirname, path.normalize(safePath));
        
        if (!filePath.startsWith(__dirname)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Forbidden' }));
        }
        
        fs.stat(filePath, (err2, stats2) => {
          if (err2 || !stats2.isFile()) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Not found' }));
          }
          serveFile(filePath, res);
        });
        return;
      }
      
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Not found' }));
      }

      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.html') {
        res.setHeader('Cache-Control', 'no-store');
        return serveFile(filePath, res);
      }
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css',
        '.js': 'text/javascript',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.ico': 'image/x-icon',
      };

      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const headers = { 'Content-Type': contentType };
      if (ext === '.js' || ext === '.css') headers['Cache-Control'] = 'public, max-age=300';
      else headers['Cache-Control'] = 'public, max-age=86400';
      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(res);
    });
  } catch (err) {
    const requestId = generateRequestId('handler');
    logServerError('http_request_error', err, {
      method: req.method,
      path: req.url,
      requestId,
    });
    respondWithServerError(res, err, { requestId });
  }
});

function serveFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';
  const headers = { 'Content-Type': contentType };
  if (ext === '.html') headers['Cache-Control'] = 'no-store';
  else if (ext === '.js' || ext === '.css') headers['Cache-Control'] = 'public, max-age=300';
  else headers['Cache-Control'] = 'public, max-age=86400';
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

const PORT = process.env.PORT || 8000;

if (require.main === module) {
  // (Removed: legacy `./worker` background-process boot. The worker
  // module doesn't exist in this codebase — video jobs are dispatched
  // straight to Modal via dispatch-to-modal.js. The require was
  // throwing on every startup and the catch was swallowing the error,
  // producing harmless but noisy log output.)

  // FAIL-CLOSED BOOT GATE (worker-auth): a guard that disables itself when
  // misconfigured is the silent-inert pattern. Both worker-auth secrets must be
  // present to start. Missing → crash loudly at boot (a loud outage), never run
  // open. This is ALSO the runtime drift-guard: a "preserve current values"
  // sweep that drops either secret fails the next boot instead of reopening the
  // door. Deploy note: set both secrets in Render env BEFORE deploying this.
  for (const k of ['MODAL_CALLBACK_SECRET', 'MODAL_RUN_SECRET']) {
    if (!process.env[k]) {
      console.error(`[boot] FATAL: ${k} not set — refusing to start (fail-closed worker auth).`);
      process.exit(1);
    }
  }

  server.listen(PORT, () => console.log(`Promptly server running on http://localhost:${PORT}`));

  // Generalized refund leg (Wave 1): worker marks (INTEGRITY_TRIP /
  // designed_rejection:true on result), app refunds — single-writer law.
  // Interval sweep, structurally idempotent (see lib/refund-leg.js), with an
  // in-flight guard so a slow pass never overlaps the next tick. Retires the
  // manual same-day refund protocol: the refund promise becomes true by code.
  if (supabaseAdmin) {
    const { sweepRefundLeg } = require('./lib/refund-leg');
    let refundLegBusy = false;
    const runRefundLeg = async () => {
      if (refundLegBusy) return;
      refundLegBusy = true;
      try {
        await sweepRefundLeg(supabaseAdmin);
      } catch (err) {
        console.error('[refund-leg] sweep crashed:', err?.message || err);
      } finally {
        refundLegBusy = false;
      }
    };
    setTimeout(runRefundLeg, 15 * 1000); // boot pass
    setInterval(runRefundLeg, 60 * 1000);

    // Missed-push backstop (W1-FIX, job ba1a9f58): worker-direct terminals
    // (SPAWN_MODE writes failed rows straight to the DB) never hit the server
    // push chokepoints — deliver their pushes here. Claim-gated exactly-once;
    // 15-min recency window = structurally zero backlog.
    const { sweepMissedLifecyclePushes } = require('./lib/lifecycle-push');
    let missedPushBusy = false;
    const runMissedPushSweep = async () => {
      if (missedPushBusy) return;
      missedPushBusy = true;
      try {
        await sweepMissedLifecyclePushes(supabaseAdmin);
      } catch (err) {
        console.error('[lifecycle-push] missed-sweep crashed:', err?.message || err);
      } finally {
        missedPushBusy = false;
      }
    };
    setTimeout(runMissedPushSweep, 30 * 1000);
    setInterval(runMissedPushSweep, 60 * 1000);

    // Job reaper (stuck-jobs directive): no job rests non-terminal past its
    // lease — terminalize + refund (claim-gated) + SSE the failure so live
    // spinners die. Census 2026-07-10 found zero server zombies; this keeps
    // it that way by construction. 2-min cadence is plenty for 10/20-min leases.
    const { sweepJobReaper } = require('./lib/job-reaper');
    let reaperBusy = false;
    const runReaper = async () => {
      if (reaperBusy) return;
      reaperBusy = true;
      try {
        await sweepJobReaper(supabaseAdmin, { pushProgressToSSE });
      } catch (err) {
        console.error('[reaper] sweep crashed:', err?.message || err);
      } finally {
        reaperBusy = false;
      }
    };
    setTimeout(runReaper, 30 * 1000); // boot pass
    setInterval(runReaper, 120 * 1000);

    // Orphan re-dispatch (Zac 2026-08-04): RECOVER never-dispatched jobs — rows with
    // modal_call_id NULL past ~11min (a server restart mid-dispatch, or the per-job
    // spawn-2xx-yet-null cause). Only the ~24% whose upload actually completed (source
    // present on S3) are re-dispatched (idempotent on job_id) so the user gets their
    // video; the 76% whose upload never landed get one honest UPLOAD terminal instead
    // of a 600s re-wait for bytes that will never arrive. dispatchJobToModal is
    // injected (imported at top). This is the primary handler for the never-dispatch
    // class; the reaper's queued_stall is now only a >30-min backstop for when this
    // cron is down.
    const { sweepOrphanRedispatch } = require('./lib/orphan-redispatch');
    let redispatchBusy = false;
    const runOrphanRedispatch = async () => {
      if (redispatchBusy) return;
      redispatchBusy = true;
      try {
        await sweepOrphanRedispatch(supabaseAdmin, { pushProgressToSSE, dispatchJobToModal });
      } catch (err) {
        console.error('[redispatch] sweep crashed:', err?.message || err);
      } finally {
        redispatchBusy = false;
      }
    };
    setTimeout(runOrphanRedispatch, 90 * 1000); // boot pass, offset from the reaper
    setInterval(runOrphanRedispatch, 180 * 1000); // every 3 min

    // Completion reconciler (2026-08-02): a rendered video MUST reach its owner.
    // The result -> delivery-column projection runs in dispatchJobToModal's
    // completion tail, which is only reached when an in-process await resolves —
    // and that await lives in a plain Map (modal-webhook.js:1). A deploy or
    // restart drops every in-flight entry while the WORKER's durable write has
    // already marked the job completed, leaving status='completed' with every
    // delivery column NULL. 10 users since 07-26 had a finished video they never
    // received; 9 of them had no double-loss event at all, so the fallback never
    // even fired for them.
    //
    // No tail logic can fix that — the recovery has to be external and stateless.
    // Same 2-min cadence as the reaper; loud on every occurrence, because a
    // silent self-heal is exactly how this stayed invisible for six days.
    const { reconcileCompletions } = require('./lib/completion-reconcile');
    let reconcileBusy = false;
    const runCompletionReconcile = async () => {
      if (reconcileBusy) return;
      reconcileBusy = true;
      try {
        await reconcileCompletions(supabaseAdmin);
      } catch (err) {
        console.error('[completion-reconcile] sweep crashed:', err?.message || err);
      } finally {
        reconcileBusy = false;
      }
    };
    setTimeout(runCompletionReconcile, 45 * 1000); // boot pass, offset from the reaper
    setInterval(runCompletionReconcile, 120 * 1000);

    // Chat-attach backstop (SERVER_CHAT_ATTACH_SPEC §3). 498 completed videos
    // across 441 users are in NO chat — 140 in the last 7 days — because the
    // message that references a render is a client-owned debounced PATCH that a
    // backgrounded session drops. The inline attach in the completion tail is
    // the immediate path; this is the guarantee, for exactly the reason
    // completion-reconcile exists one block up: the tail lives behind an
    // in-process await that no deploy survives, and this service auto-deploys
    // main. Deliberately cheap — a 3h lookback and a 60-row cap, because once
    // the inline path is landing, the expected repairs per pass are ZERO.
    // Loud when it isn't zero; a silent self-heal is how the undelivered-
    // completion class hid for six days.
    const { sweepChatAttach } = require('./lib/chat-attach');
    let chatAttachBusy = false;
    const runChatAttachSweep = async () => {
      if (chatAttachBusy) return;
      chatAttachBusy = true;
      try {
        await sweepChatAttach(supabaseAdmin);
      } catch (err) {
        console.error('[chat-attach] sweep crashed:', err?.message || err);
      } finally {
        chatAttachBusy = false;
      }
    };
    setTimeout(runChatAttachSweep, 75 * 1000); // boot pass, offset from the others
    setInterval(runChatAttachSweep, 10 * 60 * 1000);

    // API outcome ledger (2026-08-03): every non-2xx, by route and by USER, into
    // analytics_events once a minute. Before this, the 34 non-job routes had no
    // retained record of any kind — no APM, no log sink, stdout only — so there
    // was no 30-day non-2xx rate to read for ANY of them. See
    // lib/api-outcome-ledger.js.
    apiLedger.start(supabaseAdmin);

    // Bleed meter (daily [REPORT] cost digest): once/day at a fixed UTC hour,
    // push the founder a 5-line summary of what the pipeline produced in the
    // last 24h and roughly what it cost — a silent cost runaway becomes visible
    // within a day instead of at the next Modal invoice. Report-only; excludes
    // internal + test-prefixed jobs. Hourly tick, self-dedupes to once/day.
    const { maybeRunBleedMeter } = require('./lib/bleed-meter');
    let bleedBusy = false;
    const runBleedMeter = async () => {
      if (bleedBusy) return;
      bleedBusy = true;
      try {
        await maybeRunBleedMeter(supabaseAdmin);
      } catch (err) {
        console.error('[bleed-meter] tick crashed:', err?.message || err);
      } finally {
        bleedBusy = false;
      }
    };
    setTimeout(runBleedMeter, 90 * 1000); // boot pass (fires if past report hour)
    setInterval(runBleedMeter, 60 * 60 * 1000); // hourly

    // Completion-rate watchdog (2026-07-31 incident follow-up). The dispatch
    // alert catches "the request failed"; it does NOT catch "dispatch succeeded
    // and nothing ever completes" — worker accepts + dies, silent stall, jobs
    // stuck forever (same silent-outage class, different seam). Of the jobs old
    // enough to have finished (dispatched 8–30 min ago), if ≥N reached the worker
    // (processing/completed) and ZERO completed, page. Excludes dispatch-failed
    // (→ the dispatch alert) and worker-rejected (→ status=failed), so it fires
    // ONLY on the accept-but-never-finish signature. Debounced; implicitly clears
    // when any completion appears in the window.
    let watchdogBusy = false, watchdogAlertedAt = 0;
    const runCompletionWatchdog = async () => {
      if (watchdogBusy) return;
      watchdogBusy = true;
      try {
        const now = Date.now();
        const winStart = new Date(now - 30 * 60 * 1000).toISOString();
        const matureBefore = new Date(now - 8 * 60 * 1000).toISOString();
        const { data } = await supabaseAdmin
          .from('video_jobs')
          .select('id, user_id, status')
          .gte('created_at', winStart)
          .lte('created_at', matureBefore)
          .in('status', ['processing', 'completed'])
          .limit(500);
        const rows = Array.isArray(data) ? data : [];
        const dispatchedOk = rows.length;
        const completed = rows.filter((r) => r.status === 'completed').length;
        if (dispatchedOk >= 4 && completed === 0 && now - watchdogAlertedAt > 30 * 60 * 1000) {
          watchdogAlertedAt = now;
          const body = `${dispatchedOk} jobs dispatched OK 8–30min ago, ZERO completed — pipeline accepts but nothing finishes (worker stall / silent downstream failure)`;
          console.error(`[ALERT] COMPLETION-RATE WATCHDOG — ${body}`);
          await sendOwnerAlert({
            ownerUserId: SUBMISSION_OWNER_USER_ID,
            title: '🚨 [Promptly] RENDERS NOT COMPLETING — pipeline stalled',
            body, threadId: 'completion-watchdog', supabaseAdmin,
          });
          // Last known-good completion (only queried when we're already firing).
          const { data: lastDone } = await supabaseAdmin
            .from('video_jobs')
            .select('updated_at')
            .eq('status', 'completed')
            .order('updated_at', { ascending: false })
            .limit(1);
          // ALSO wake an investigating agent (gated + hard-capped; dormant until
          // AGENT_ALERT_WEBHOOK_URL is set). The stuck jobs' ids/users let the
          // agent inspect the exact stall without a query round-trip.
          await postAgentAlert({
            error_class: 'COMPLETION_STALL',
            count: dispatchedOk,
            window_min: 30,
            job_ids: rows.filter((r) => r.status === 'processing').map((r) => r.id).slice(0, 10),
            user_ids: [...new Set(rows.map((r) => r.user_id).filter(Boolean))].slice(0, 10),
            last_good_ts: (Array.isArray(lastDone) && lastDone[0] && lastDone[0].updated_at) || null,
            hint: 'Jobs reach the worker (status=processing) but none complete — worker accepted + stalled, or a silent downstream failure. Check the worker logs / Modal function health for these job_ids.',
          });
        }
      } catch (err) {
        console.error('[watchdog] completion check crashed:', err?.message || err);
      } finally {
        watchdogBusy = false;
      }
    };
    setTimeout(runCompletionWatchdog, 120 * 1000); // boot pass
    setInterval(runCompletionWatchdog, 5 * 60 * 1000); // every 5 min
  }

  // Flush any pending PostHog server events before the process exits (Render
  // sends SIGTERM on deploy/scale-down). No-op while the sink is dark.
  process.on('SIGTERM', () => { phShutdown().finally(() => process.exit(0)); });

  process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err?.message || err);
    if (err?.stack) console.error(err.stack);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled rejection:', reason);
    if (reason && reason.stack) console.error(reason.stack);
  });
}

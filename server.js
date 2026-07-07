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
  proEntitlementFromV2ActiveList,
  PRO_ENTITLEMENT_ID,
  revenuecatWebhookAuthMatches,
} = require('./lib/entitlement');
const { ENABLE_DESIGN_LAB } = require('./config/flags');
const { triggerPreAnalysis } = require('./lib/video-processor/pre-analyze');
const s3 = require('./services/s3');
const { dispatchJobToModal, registerPrewarm } = require('./lib/video-processor/dispatch-to-modal');
const { settlePendingModalJob } = require('./lib/video-processor/modal-webhook');
const { sendRenderCompleteNotification } = require('./services/pushNotifier');
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

async function assertProEntitled(userId) {
  if (!supabaseAdmin) {
    const err = new Error('supabase_not_configured');
    err.statusCode = 500;
    throw err;
  }
  const entitlement = await fetchSubscriptionEntitlement(userId);
  const decision = resolveEntitlementDecision(entitlement);
  if (decision.isPro) {
    return { ...decision, sourceTable: entitlement.sourceTable };
  }

  // SELF-HEAL — the guarantee that a paying user is NEVER denied, even if the
  // webhook was missed, delayed, or (as happened) silently 401'd. The DB says
  // "not Pro", but RevenueCat is the source of truth. If this user has any
  // subscription history, verify against RC (grant-only — it can only upgrade,
  // never wrongly revoke) before returning a denial. Throttled per user so a
  // genuinely-free ex-subscriber can't hammer RC, and skipped entirely for
  // never-subscribed users so the common free/Pro paths stay a single DB read.
  if (_hasSubscriptionHistory(entitlement.row) && _selfHealDue(userId)) {
    try {
      const healed = await reconcileEntitlementFromRevenueCat(userId);
      if (healed && healed.isPro) {
        // Definitive POSITIVE: we granted + persisted pro_until, so the next
        // read short-circuits before self-heal. Full-window throttle is fine.
        _markSelfHeal(userId, false);
        console.log('[entitlement] self-heal granted Pro from RevenueCat', { userId });
        return { isPro: true, reason: 'RC_SELF_HEAL', plan: decision.plan, status: 'active', sourceTable: entitlement.sourceTable };
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
  return { ...decision, sourceTable: entitlement.sourceTable };
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
// True when a Supabase error is "column rc_last_event_ms doesn't exist" — i.e.
// migration 20260701_rc_event_ordering hasn't been applied yet. Lets the webhook
// + reconcile fall back to a plain write so they never 500 on the missing
// column; the ordering guard activates automatically once the column exists.
function rcOrderingColumnMissing(error) {
  if (!error) return false;
  if (error.code === 'PGRST204' || error.code === '42703') return true;
  const blob = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`;
  return /rc_last_event_ms/i.test(blob);
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
  // 404 = RC has never seen this customer (no purchase under this identity).
  if (rcRes.status === 404) {
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
  const secret = process.env.MODAL_CALLBACK_SECRET || '';
  if (!secret) return true;
  const got = String((req.headers && req.headers['x-modal-secret']) || '').trim();
  if (!got || got.length !== secret.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(secret));
  } catch {
    return false;
  }
}

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

const server = http.createServer((req, res) => {
  try {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  const parsed = url.parse(req.url, true);

  // Render health checks should be constant-time and avoid any extra work.
  if (req.method === 'GET' && parsed.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('OK');
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
        .select('status, progress, current_step, step_message, rendered_video_url, thumbnail_url, error_message')
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
                thumbnailUrl: data.thumbnail_url || null,
                error: data.error_message || null,
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
          .select('status, user_id, vibe_input, hls_manifest_url')
          .eq('id', job_id)
          .maybeSingle();
        const wasAlreadyCompleted = prevState?.status === 'completed';

        const updateData = {
          status,
          progress: Number(pct || 0),
          current_step: step || '',
          step_message: message || '',
          updated_at: new Date().toISOString(),
        };
        if (completionVideoUrl) updateData.rendered_video_url = completionVideoUrl;

        // First-terminal-wins: this fast-path progress write must never land on
        // a terminal row — it would respell the worker's status (dropping its
        // write-once result/phase) or resurrect a cancelled render. The SSE
        // push below still fires regardless, so the client stays live.
        await supabaseAdmin
          .from('video_jobs')
          .update(updateData)
          .eq('id', job_id)
          .not('status', 'in', TERMINAL_JOB_STATUSES_SQL);

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
            thumbnailUrl: null,
            final: false,
            error: null,
          });
          // Fire the APNs push so users who navigated away during the
          // render get pulled back in. Fire-and-forget: notification
          // failure must never affect the render success path — the
          // SSE event already told any foreground client the video is
          // ready. iOS taps on the notification deep-link into the
          // Library tab via the "render-complete" type handler.
          //
          // Deduplication: only push when the job was NOT already in
          // the 'completed' state before this request. If the worker
          // retries /api/modal-progress with step === 'complete' for a
          // job it already finished (network blip, idempotency safety
          // net, etc), we skip the duplicate push. Without this guard
          // the user would see two "Your video is ready ✨" alerts
          // back-to-back, which reads as buggy.
          if (!wasAlreadyCompleted && prevState?.user_id && finalVideoUrl) {
            sendRenderCompleteNotification({
              userId: prevState.user_id,
              jobId: job_id,
              videoUrl: finalVideoUrl,
              hlsManifestUrl: prevState.hls_manifest_url || null,
              vibe: prevState.vibe_input || null,
              supabaseAdmin,
            }).catch((err) => {
              console.error('[push] render-complete dispatch failed:', err.message);
            });
          } else if (wasAlreadyCompleted) {
            console.log(`[push] skipping duplicate render-complete for job=${job_id} (already completed)`);
          }
        } else {
          pushProgressToSSE(job_id, {
            status,
            progress: Number(pct || 0),
            step: step || '',
            message: message || '',
            videoUrl: completionVideoUrl,
            error: null,
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
        settlePendingModalJob({ id, status, output, error });
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error('[modal] Webhook handler failed:', err.message);
        return sendJson(res, 200, { ok: false });
      }
    })();
    return;
  }

  async function createQueuedVideoJob({ userId, videoUrl, vibeInput }) {
    if (!videoUrl) throw Object.assign(new Error('Video URL is required'), { statusCode: 400 });
    if (!vibeInput) throw Object.assign(new Error('Vibe input is required'), { statusCode: 400 });
    if (!userId) throw Object.assign(new Error('User ID is required'), { statusCode: 400 });

    const { data, error } = await supabaseAdmin
      .from('video_jobs')
      .insert({
        user_id: userId,
        video_url: videoUrl,
        vibe_input: vibeInput,
        status: 'queued',
        progress: 0,
        current_step: 'Queued',
      })
      .select()
      .single();

    if (error) {
      throw Object.assign(new Error(error.message || 'Failed to create job'), { statusCode: 500 });
    }
    return data;
  }


  // ── Daily usage tracking (RevenueCat-era gating) ──
  // Both counters use the usage_events table and a UTC midnight cutoff.
  // Cheap: composite index on (user_id, kind, created_at DESC).
  //
  // Free tier:
  //   - 3 renders / day  (kind='render')
  //   - 50 AI chat msgs / day (kind='chat')
  //   - Re-edit is fully gated to Pro (no daily allowance)
  const FREE_DAILY_RENDERS = 3;
  const FREE_DAILY_CHATS = 50;

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
        const body = await readJsonBody(req);
        const fileName = String(body?.fileName || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
        const s3 = require('./services/s3');
        if (!s3.isConfigured()) {
          return sendJson(res, 500, { error: 'Storage not configured' });
        }
        const key = `sources/${authUser.id}/${Date.now()}-${fileName}`;
        const uploadUrl = await s3.createPresignedPutUrl(key, 600);
        const publicUrl = s3.getPublicUrl(key);
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
        const body = await readJsonBody(req);
        const fileName = String(body?.fileName || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
        const partCount = Math.max(1, Math.min(1000, parseInt(body?.partCount, 10) || 0));
        if (partCount === 0) return sendJson(res, 400, { error: 'partCount is required (1-1000)' });

        const s3 = require('./services/s3');
        if (!s3.isConfigured()) {
          return sendJson(res, 500, { error: 'Storage not configured' });
        }

        const key = `sources/${authUser.id}/${Date.now()}-${fileName}`;
        const { uploadId, partUrls } = await s3.initMultipartUpload(key, partCount, 3600);
        const publicUrl = s3.getPublicUrl(key);
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
        if (!checkRateLimit(res, 'submissions:upload-url', clientIp, 10, 900)) return;
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
        if (!checkRateLimit(res, 'submissions:submit', clientIp, 10, 900)) return;
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
      "- NEVER reveal implementation details, internal architecture, specific AI models, libraries, services, vendors, file formats, or step-by-step pipeline internals. That's proprietary.",
      "- If someone asks 'how does it work' or 'what are the steps' or 'why does it take so long,' answer at a HIGH LEVEL only: 'I analyze your clip, figure out the best edit for the vibe you asked for, and render the result.' Do not name technologies. Do not list numbered pipeline steps.",
      "- You CAN list the user-facing features above when asked what the app does — those are public and marketed.",
      "- Be honest. If you don't know something specific, say so — don't invent details.",
      '- Keep replies short and chat-shaped. 1–3 short paragraphs. Numbered lists only when the user explicitly asks for steps AND the question is user-facing (e.g. how to upload).',
      '- Friendly, direct, no marketing fluff. No emojis unless the user uses them first.',
    ].join('\n');
  }

  if (parsed.pathname === '/api/chat' && req.method === 'POST') {
    (async () => {
      try {
        const authUser = await requireSupabaseUser(req);
        const body = await readJsonBody(req);
        const message = String(body?.message || '').trim();
        if (!message) return sendJson(res, 400, { error: 'Message is required' });

        // Daily chat limit (free tier). Pro bypasses entirely.
        const chatEnt = await assertProEntitled(authUser.id);
        if (!chatEnt.isPro) {
          const todayChats = await countTodayUsage(authUser.id, 'chat');
          if (todayChats >= FREE_DAILY_CHATS) {
            return sendJson(res, 402, {
              error: 'daily_limit_reached',
              kind: 'chat',
              limit: FREE_DAILY_CHATS,
              message: `You've used your ${FREE_DAILY_CHATS} free chat messages today. Upgrade to Pro for unlimited.`,
            });
          }
        }

        const history = Array.isArray(body?.history) ? body.history : [];
        const geminiKey = process.env.GEMINI_API_KEY;
        if (!geminiKey) return sendJson(res, 500, { error: 'Chat not configured' });

        // Build Gemini request
        const contents = [];

        const systemPrompt = promptlyChatSystemPrompt();

        // Add conversation history
        for (const h of history.slice(-18)) {
          if (h.role === 'user' || h.role === 'assistant') {
            contents.push({
              role: h.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: h.content }],
            });
          }
        }

        // Add current message
        contents.push({ role: 'user', parts: [{ text: message }] });

        // Flash model for the chat path. The pro/preview model burns
        // 5-15s on simple replies — fine for the analysis pipeline,
        // unacceptable for an in-app chat where the value of an AI reply
        // is its instant feel. 2.5-flash returns in ~500-1500ms with
        // identical helpfulness for short mobile-chat answers.
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: systemPrompt }] },
              contents,
              generationConfig: {
                // 1024 leaves headroom for "explain the pipeline" style
                // questions without clipping mid-sentence. The system
                // prompt holds replies short by default.
                maxOutputTokens: 1024,
                temperature: 0.8,
                // Disable thinking — it adds 1-3s of latency for
                // negligible quality gain on chit-chat. Flash defaults
                // to a small thinking budget; explicitly zero it out.
                thinkingConfig: { thinkingBudget: 0 },
              },
            }),
          }
        );

        if (!geminiRes.ok) {
          const errText = await geminiRes.text().catch(() => '');
          console.error('[Chat] Gemini error:', geminiRes.status, errText);
          return sendJson(res, 502, { error: 'AI service error' });
        }

        const geminiData = await geminiRes.json();
        const reply = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

        // Log usage AFTER a successful AI hit. Counts AI-reaching messages
        // only — burning a chat message that errored out shouldn't deplete
        // the user's daily quota.
        await logUsageEvent(authUser.id, 'chat');

        return sendJson(res, 200, { reply });
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
        if (!message) return sendJson(res, 400, { error: 'Message is required' });

        // Daily chat limit (free tier). Pro bypasses entirely.
        const streamEnt = await assertProEntitled(streamUser.id);
        if (!streamEnt.isPro) {
          const todayChats = await countTodayUsage(streamUser.id, 'chat');
          if (todayChats >= FREE_DAILY_CHATS) {
            return sendJson(res, 402, {
              error: 'daily_limit_reached',
              kind: 'chat',
              limit: FREE_DAILY_CHATS,
              message: `You've used your ${FREE_DAILY_CHATS} free chat messages today. Upgrade to Pro for unlimited.`,
            });
          }
        }

        const history = Array.isArray(body?.history) ? body.history : [];
        const geminiKey = process.env.GEMINI_API_KEY;
        if (!geminiKey) return sendJson(res, 500, { error: 'Chat not configured' });

        // Build Gemini contents (same shape as /api/chat).
        const systemPrompt = promptlyChatSystemPrompt();
        const contents = [];
        for (const h of history.slice(-18)) {
          if (h.role === 'user' || h.role === 'assistant') {
            contents.push({
              role: h.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: h.content }],
            });
          }
        }
        contents.push({ role: 'user', parts: [{ text: message }] });

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
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${geminiKey}`;
        const geminiRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: {
              // Streaming can afford a generous cap — tokens flow as
              // they generate, so a long answer doesn't feel slow. The
              // system prompt still anchors replies to chat-shaped.
              maxOutputTokens: 2048,
              temperature: 0.8,
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        });

        if (!geminiRes.ok || !geminiRes.body) {
          const errText = await geminiRes.text().catch(() => '');
          console.error('[ChatStream] Gemini error:', geminiRes.status, errText);
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
        const reader = geminiRes.body.getReader();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
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
              const token = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
              if (token) {
                res.write(`data: ${JSON.stringify({ token })}\n\n`);
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
        if (supabaseAdmin) {
          const { data } = await supabaseAdmin
            .from('profiles')
            .select('pro_until')
            .eq('id', u.id)
            .maybeSingle();
          proUntil = data?.pro_until || null;
        }
        return sendJson(res, 200, {
          is_pro: !!ent.isPro,
          pro_until: proUntil,
          renders_today: renders,
          chats_today: chats,
          render_limit: FREE_DAILY_RENDERS,
          chat_limit: FREE_DAILY_CHATS,
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
        const expected = process.env.REVENUECAT_WEBHOOK_AUTH || '';
        if (!expected) {
          console.warn('[RevenueCat] webhook called but REVENUECAT_WEBHOOK_AUTH not set');
          return sendJson(res, 503, { error: 'webhook_not_configured' });
        }
        // Accept the secret whether RevenueCat's dashboard sends it bare or as
        // "Bearer <secret>" (and ignore stray whitespace) — a prefix mismatch
        // was 401ing every webhook and silently breaking billing sync. The
        // secret VALUE still has to match, so this grants nothing extra.
        if (!revenuecatWebhookAuthMatches(req.headers.authorization, expected)) {
          console.warn('[RevenueCat] webhook auth mismatch');
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        if (!supabaseAdmin) {
          return sendJson(res, 500, { error: 'supabase_not_configured' });
        }
        const body = await readJsonBody(req);
        const event = body?.event;
        if (!event) return sendJson(res, 400, { error: 'event_missing' });

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
          console.log('[RevenueCat] TRANSFER reconciled', { granted, of: toIds.length });
          return sendJson(res, 200, { ok: true, transferred: granted });
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
          const payload = useOrdering ? { ...update, rc_last_event_ms: eventMs } : update;
          let q = supabaseAdmin.from('profiles').update(payload).eq('id', id);
          if (useOrdering) q = q.or(`rc_last_event_ms.is.null,rc_last_event_ms.lt.${eventMs}`);
          let { data, error } = await q.select('id');
          // Tolerate the ordering column not existing yet (migration 20260701 not
          // applied): fall back to a plain, unguarded update so the webhook never
          // 500s on a missing column. Ordering activates once the column exists.
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
        return sendJson(res, 200, {
          is_pro: !!result.isPro,
          pro_until: result.proUntil || null,
          reason: result.reason,
        });
      } catch (error) {
        const status = error?.statusCode || 500;
        if (status === 503) {
          // Secret key not configured — client silently falls back to
          // webhook-only activation. Not an error worth alerting on.
          console.warn('[RevenueCat] /sync called but REVENUECAT_SECRET_KEY not set');
        } else {
          console.error('[RevenueCat] /sync failed', { status, error: error?.message });
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
        // Cap GPU prewarm dispatches per user — each one downloads + transcribes
        // on a paid Modal container. Generous for real use (one per intended
        // render) but stops a loop from spraying GPU spend.
        if (!checkRateLimit(res, 'prewarm', prewarmUser.id, 20, 900)) return;
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
          body: JSON.stringify({ video_url: videoUrl }),
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

        const entitlement = await assertProEntitled(authUser.id);
        console.log('  [paywall] isPro=%s reason=%s plan=%s userId=%s',
          entitlement.isPro, entitlement.reason, entitlement.plan, authUser.id);

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
        const reservation = await withKeyLock(`render:${authUser.id}`, async () => {
          if (supabaseAdmin) {
            const { count: pendingCount, error: pendingErr } = await supabaseAdmin
              .from('video_jobs')
              .select('*', { count: 'exact', head: true })
              .eq('user_id', authUser.id)
              .in('status', ['queued', 'processing']);
            if (pendingErr) {
              console.error('  [paywall] pending-count failed, refusing action',
                { userId: authUser.id, error: pendingErr.message });
              return { status: 503, body: { error: 'pending_check_failed' } };
            }
            const concurrencyCap = entitlement.isPro ? 10 : 1;
            if ((pendingCount || 0) >= concurrencyCap) {
              console.log('  [paywall] 402 concurrency_limit_reached userId=%s pending=%d cap=%d',
                authUser.id, pendingCount, concurrencyCap);
              return { status: 402, body: {
                error: 'concurrency_limit_reached',
                kind: entitlement.isPro ? 'concurrency_pro' : 'concurrency_free',
                limit: concurrencyCap,
                message: entitlement.isPro
                  ? `You can have up to ${concurrencyCap} renders in flight at once.`
                  : 'Free accounts can render 1 video at a time. Upgrade to Pro for 10 in parallel.',
              } };
            }
          }

          if (!entitlement.isPro) {
            // Atomic check-and-increment of the free daily render cap. This both
            // enforces the limit and records the usage event; if it fails
            // (outage) it throws 503 and we abort rather than free-render.
            const claim = await claimDailyUsage(authUser.id, 'render', FREE_DAILY_RENDERS);
            if (!claim.ok) {
              console.log('  [paywall] 402 daily_limit_reached for userId=%s', authUser.id);
              return { status: 402, body: {
                error: 'daily_limit_reached',
                kind: 'render',
                limit: FREE_DAILY_RENDERS,
                message: `You've used your ${FREE_DAILY_RENDERS} free renders today. Upgrade to Pro for unlimited.`,
              } };
            }
          } else {
            // Pro: no daily cap, but still record the render for tracking.
            await logUsageEvent(authUser.id, 'render');
          }

          const created = await createQueuedVideoJob({
            userId: authUser.id,
            videoUrl,
            vibeInput,
          });
          return { job: created };
        });

        if (reservation.status) return sendJson(res, reservation.status, reservation.body);
        const job = reservation.job;
        console.log('  ✅ Job created:', job.id);

        // Premium pipeline (Lumen) gate — DEFENSE IN DEPTH. The client only
        // sends premium_pipeline_enabled:true for an entitled Pro user, but
        // the server is the real lock: a free/unverified user can NEVER route
        // premium here no matter what the client (or a hand-rolled curl) sends.
        // The worker double-gates again (route_premium = is_premium AND flag).
        const premiumPipeline = entitlement.isPro === true && body?.premium_pipeline_enabled === true;
        console.log('  [model] premium_pipeline=%s (isPro=%s clientAsked=%s) job=%s',
          premiumPipeline, entitlement.isPro, body?.premium_pipeline_enabled === true, job.id);

        await dispatchJobToModal({
          pushProgressToSSE,
          jobId: job.id,
          videoUrl,
          proxyVideoUrl: proxyVideoUrl || null,
          vibe: vibeInput,
          userId: authUser.id,
          premiumPipeline,
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
          // reaches Pro users.
          const entitlement = await assertProEntitled(authUser.id);
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
          const { data: locked, error: updErr } = await supabaseAdmin
            .from('video_jobs')
            .update({ status: 'processing', ask: null, current_step: 'resuming', step_message: 'Folding in your answer…' })
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

        // Re-edit is a Pro-only feature. Free users cannot use this endpoint
        // at all — return 402 with a payload the client recognizes so the
        // paywall sheet pops with the right "Re-edit is a Pro feature" copy.
        const entitlement = await assertProEntitled(authUser.id);
        if (!entitlement.isPro) {
          return sendJson(res, 402, {
            error: 'pro_required',
            kind: 'reedit',
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

        const { data, error } = await supabaseAdmin
          .from('video_jobs')
          .select('id, user_id, status, progress, current_step, step_message, ask, rendered_video_url, thumbnail_url, result_url, error_message, created_at, completed_at, updated_at')
          .eq('id', jobId)
          .eq('user_id', authUser.id)
          .order('updated_at', { ascending: false })
          .maybeSingle();

        if (error) {
          console.error('  ❌ Database error:', error);
          return sendJson(res, 500, { error: 'Failed to fetch job status' });
        }
        if (!data) {
          console.error('  ❌ Job not found');
          return sendJson(res, 404, { error: 'Job not found' });
        }
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
    // Editor and calendar removed — mobile-only app. Redirect to landing.
    if (parsed.pathname === '/editor' || parsed.pathname === '/calendar' || parsed.pathname === '/calendar.html' || parsed.pathname === '/library.html') {
      res.writeHead(302, { 'Location': '/' });
      return res.end();
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
  }

  process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err?.message || err);
    if (err?.stack) console.error(err.stack);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled rejection:', reason);
    if (reason && reason.stack) console.error(reason.stack);
  });
}

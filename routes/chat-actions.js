'use strict';

// POST /api/chat/actions — the server half of "chat that acts". DARK behind
// PROMPTLY_CHAT_ACTIONS (unset → 404, the route does not exist as far as any
// client can tell).
//
// MOUNT (one line in server.js's router, submitted through TRUTH — this file
// never touches server.js itself):
//
//   if (parsed.pathname === '/api/chat/actions' && req.method === 'POST') return require('./routes/chat-actions').handle(req, res, { requireSupabaseUser, readJsonBody, sendJson, supabaseAdmin, checkRateLimit, PORT });
//
// NO PARALLEL JOB-CREATION LOGIC — the drift law. When the model calls a
// job-creating tool, this handler SELF-FORWARDS over loopback to the same
// endpoints the composer uses (/api/video-jobs, /api/video-jobs/re-edit),
// carrying the caller's own Authorization header. Auth, the maintenance gate,
// rate limits, quotas/entitlements, and dispatch therefore hit IDENTICALLY
// whether the job came from the composer or the chat — by construction, not by
// re-implementation. A refused downstream (402 paywall / 429 / 503 outage)
// passes through verbatim so the client renders the same UX.
//
// get_job_status IS NOT FORWARDED, on purpose. Job status is
// GET /api/video-jobs/:jobId and selfForward is POST-only. The DB oracle below
// (chatRouter.statusAnswerFromJob, the SAME code the chat router uses — not a
// copy) already answers it from the row this handler has read anyway.
// Generalising selfForward to GET would be new machinery for zero new
// capability.
//
// INSTRUMENTED FROM LINE 1 (chat had zero instrumentation; this surface does
// not repeat that): chat_action_classified / chat_action_dispatched /
// chat_action_clarified / chat_action_refused via the server-side PostHog
// sink (inert until POSTHOG_API_KEY — the standing dark pattern), plus
// chat_tool_unknown (a tool name the server does not implement — the health of
// the contract, and it should be zero) and structured [chat-action] console
// markers that work with no key at all.

const http = require('http');
const chatActions = require('../lib/chat-actions');
const chatRouter = require('../lib/chat-router');
const { phCapture } = require('../lib/posthog-sink');

const SELF_FORWARD_TIMEOUT_MS = 30000;

function mark(evt, userId, props) {
  // Console marker first (always-on truth), sink second (dark until keyed).
  try {
    console.log(`[chat-action] ${evt} user=${userId || '?'} ` +
      JSON.stringify(props || {}));
  } catch (_) { /* logging never breaks the request */ }
  try { phCapture(userId || 'anonymous', evt, props || {}); } catch (_) { /* inert */ }
}

/** Loopback POST to one of our own endpoints, forwarding ONLY the caller's
 *  Authorization header. Resolves {status, body}; never rejects. */
function selfForward(port, path, authHeader, payload) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(payload || {}));
    const reqOut = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': data.length,
        ...(authHeader ? { authorization: authHeader } : {}),
      },
      timeout: SELF_FORWARD_TIMEOUT_MS,
    }, (resIn) => {
      let buf = '';
      resIn.on('data', (c) => { buf += c; });
      resIn.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch (_) { parsed = { raw: buf.slice(0, 400) }; }
        resolve({ status: resIn.statusCode || 0, body: parsed });
      });
    });
    reqOut.on('timeout', () => { reqOut.destroy(new Error('self-forward timeout')); });
    reqOut.on('error', (e) => {
      resolve({ status: 0, body: { error: 'self_forward_failed', detail: String(e && e.message) } });
    });
    reqOut.end(data);
  });
}

/** The route handler. deps are injected by the server.js mount line so this
 *  file reuses the server's own auth/JSON/ratelimit helpers — never copies. */
async function handle(req, res, deps) {
  const { requireSupabaseUser, readJsonBody, sendJson, supabaseAdmin,
          checkRateLimit, PORT } = deps || {};
  try {
    if (!chatActions.enabled()) {
      // Dark: indistinguishable from a route that doesn't exist.
      return sendJson(res, 404, { error: 'not_found' });
    }
    if (!supabaseAdmin) return sendJson(res, 500, { error: 'supabase_not_configured' });

    let authUser;
    try {
      authUser = await requireSupabaseUser(req);
    } catch (_) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }

    // Chat-scale budget — deliberately looser than job creation (30/15min vs
    // 10/15min); the job endpoints enforce their own stricter budget on the
    // forwarded leg, so an ACT burst still hits the composer's exact wall.
    if (!checkRateLimit(res, 'chat-actions', authUser.id, 30, 900)) return;

    const body = await readJsonBody(req);
    const message = String(body?.message || '').trim();
    const videoUrl = String(body?.video_url || body?.videoUrl || '').trim();
    const proxyVideoUrl = String(body?.proxy_video_url || body?.proxyVideoUrl || '').trim();

    // The user's recent jobs ground the model AND answer status. ALWAYS scoped
    // .eq('user_id', authUser.id) — that scoping is what makes a model-supplied
    // job_id checkable: an id outside this set is, by construction, not the
    // caller's. One indexed read, the same oracle pattern the chat router uses.
    let recentJobs = [];
    try {
      const { data } = await supabaseAdmin
        .from('video_jobs')
        .select('id, status, current_step, updated_at, created_at, error_message, vibe_input, video_url')
        .eq('user_id', authUser.id)
        .order('created_at', { ascending: false })
        .limit(chatActions.RECENT_JOBS_SHOWN);
      recentJobs = Array.isArray(data) ? data : [];
    } catch (e) {
      console.warn('[chat-action] recent-jobs read failed (deciding without):',
        e && e.message);
    }
    const recentJob = recentJobs[0] || null;

    const verdict = await chatActions.decideChatAction(message, {
      hasVideoAttached: Boolean(videoUrl),
      recentJobs,
      // The assistant answers in the USER's language. Validated against the
      // twelve by the shared helper — never an unvalidated string, because this
      // is interpolated into a system prompt.
      replyLanguage: require('../lib/reply-language').parseReplyLanguage(body),
    });
    const calledTool = verdict.turn && verdict.turn.kind === 'tool_call'
      ? verdict.turn.name : null;
    mark('chat_action_classified', authUser.id, {
      kind: verdict.kind,
      reason: verdict.reason,
      tool: calledTool,
      has_video: Boolean(videoUrl),
      recent_jobs: recentJobs.length,
    });

    if (verdict.unknownTool) {
      // The contract's own health metric. Never silently converse on it — a
      // non-zero value means the declarations and the handler have drifted.
      mark('chat_tool_unknown', authUser.id, { tool: verdict.unknownTool });
    }

    if (verdict.kind === 'refuse') {
      // A model-supplied job_id that is not the caller's. Should be zero
      // forever; non-zero is either a prompt-injection attempt or a context
      // bug, and both are worth seeing. NOTHING is forwarded.
      mark('chat_tool_refused', authUser.id,
        { reason: verdict.reason, job_id: verdict.requestedJobId || null });
      return sendJson(res, 200, {
        action: 'clarify',
        message: 'I couldn’t find that edit on your account — which one did you mean?',
      });
    }

    if (verdict.kind === 'converse') {
      // The client falls through to /api/chat/stream exactly as today — the
      // conversational surface stays single-owned by the existing chat path,
      // which is also why the decision turn's own text is discarded (it is
      // unstreamed, and streaming is the whole UX of that surface).
      return sendJson(res, 200, { action: 'converse' });
    }

    if (verdict.kind === 'status') {
      const answer = chatRouter.statusAnswerFromJob(verdict.job || recentJob) ||
        'I don’t see a recent edit for you yet — attach a video with a vibe and I’ll start one.';
      return sendJson(res, 200, { action: 'status', message: answer });
    }

    if (verdict.kind === 'clarify') {
      mark('chat_action_clarified', authUser.id, { reason: verdict.reason });
      return sendJson(res, 200, { action: 'clarify', message: verdict.clarifyQuestion });
    }

    const authHeader = req.headers && req.headers.authorization;

    if (verdict.kind === 'act_render') {
      // Source resolution is the SERVER's, never the model's: either the video
      // attached to this request, or a previous job's stored source the model
      // explicitly asked to re-use. There is no upload registry to resolve
      // "their most recent upload" against, so there is no third case.
      const src = verdict.videoUrl || videoUrl;
      const fwd = await selfForward(PORT, '/api/video-jobs', authHeader, {
        video_url: src,
        ...(proxyVideoUrl && !verdict.videoUrl ? { proxy_video_url: proxyVideoUrl } : {}),
        vibe_input: verdict.vibe,
      });
      if (fwd.status >= 200 && fwd.status < 300) {
        const jobId = fwd.body && (fwd.body.job_id || fwd.body.id ||
          (fwd.body.job && fwd.body.job.id));
        mark('chat_action_dispatched', authUser.id,
          { kind: 'render', job_id: jobId || null, source: verdict.source || 'attached' });
        const msg = await chatActions.composeConfirmation({
          message, verdict,
          toolResult: { ok: true, action: 'render_started', job_id: jobId || null },
        });
        return sendJson(res, 200, {
          action: 'render_dispatched',
          job_id: jobId || null,
          message: msg,
          job: fwd.body,
        });
      }
      // Quota/paywall/outage/validation refusals pass through VERBATIM — the
      // client renders the same UX as a composer refusal (the cap must hit
      // identically from the chat).
      mark('chat_action_refused', authUser.id,
        { kind: 'render', status: fwd.status });
      return sendJson(res, fwd.status || 502, fwd.body || { error: 'dispatch_failed' });
    }

    if (verdict.kind === 'act_reedit') {
      const fwd = await selfForward(PORT, '/api/video-jobs/re-edit', authHeader, {
        original_job_id: verdict.jobId,
        change_request: verdict.changeRequest,
      });
      if (fwd.status >= 200 && fwd.status < 300) {
        const jobId = fwd.body && (fwd.body.job_id || fwd.body.id ||
          (fwd.body.job && fwd.body.job.id)) || verdict.jobId;
        mark('chat_action_dispatched', authUser.id,
          { kind: 'reedit', job_id: jobId, parent_job_id: verdict.jobId });
        const msg = await chatActions.composeConfirmation({
          message, verdict,
          toolResult: { ok: true, action: 'revision_started', job_id: jobId,
                        parent_job_id: verdict.jobId },
        });
        return sendJson(res, 200, {
          action: 'reedit_dispatched',
          job_id: jobId,
          message: msg,
          job: fwd.body,
        });
      }
      mark('chat_action_refused', authUser.id,
        { kind: 'reedit', status: fwd.status });
      return sendJson(res, fwd.status || 502, fwd.body || { error: 'dispatch_failed' });
    }

    // Unreachable by construction (resolveToolCall returns a closed set) — but
    // a future kind must fail LOUDLY here, never silently converse.
    mark('chat_action_refused', authUser.id, { kind: verdict.kind, status: 500 });
    return sendJson(res, 500, { error: 'unhandled_action_kind', kind: verdict.kind });
  } catch (e) {
    console.error('[chat-action] handler error:', e);
    try { return sendJson(res, 500, { error: 'chat_actions_error' }); } catch (_) { /* headers sent */ }
  }
}

module.exports = { handle, selfForward };

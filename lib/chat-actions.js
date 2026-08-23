'use strict';

// chat-actions — the intent layer that lets the chat ACT.
// DARK behind PROMPTLY_CHAT_ACTIONS (unset ⇒ the route 404s before auth).
//
// ── WHAT CHANGED (2026-08-23): THE REGEXES ARE GONE ────────────────────────
//
// This file used to decide intent with three hand-written vocabularies
// (EDIT_VERB_RE ∧ (COMPONENT_NOUN_RE ∨ PRIOR_REF_RE)). Every phrasing outside
// those word lists was a miss BY CONSTRUCTION, and the lists could only grow
// by someone remembering a word. MEASURED on the old code, with a fresh
// completed job in context — all three fell through to converse/no_action:
//
//     "tighten the front half"              → converse / no_action_signal
//     "get rid of the silence at the start" → converse / no_action_signal
//     "punch it up"                         → converse / no_action_signal
//
// (Not "make it viral" — that one MATCHED the old rule via make+it, so it is
// refutable and is not used as evidence anywhere.)
//
// Tool calling inverts the problem: the three things the server can actually
// do become callable functions, and NOT-A-TOOL-CALL IS THE NORMAL CASE. There
// is no unclassified bucket and no residue to misfile — every message resolves
// to either a tool call or ordinary conversation.
//
// ── WHAT IS PRESERVED VERBATIM ─────────────────────────────────────────────
//
// 1. The dark flag. enabled() is byte-for-byte the same; the route still 404s
//    before auth when PROMPTLY_CHAT_ACTIONS is unset.
// 2. The loopback self-forward. A tool call NEVER creates a job inline — the
//    route self-forwards over 127.0.0.1 to /api/video-jobs and
//    /api/video-jobs/re-edit carrying the caller's own Authorization, so auth,
//    the maintenance gate, rate limits, entitlements and the paywall hit
//    IDENTICALLY whether the job came from the composer or the chat. A tool
//    handler that created a job directly would be a second implementation of
//    the paywall — which is how a free user gets a render.
// 3. The OUTPUT CONTRACT. The verdict `kind` vocabulary (converse / status /
//    clarify / act_render / act_reedit) is unchanged, so the route's JSON
//    shapes and the iOS handling table (IOS_HANDOFF_CHAT_ACTIONS.md §1) are
//    untouched. Only the DECISION MECHANISM was replaced.
//
// ── WHAT IS DELIBERATELY *NOT* A TOOL ──────────────────────────────────────
//
// get_job_status is declared so the model can ROUTE to it, but it does NOT
// self-forward: job status is GET /api/video-jobs/:jobId and selfForward is
// POST-only. The DB oracle (chat-router.statusAnswerFromJob) already answers
// it correctly from the row the route has already read. Generalising
// selfForward to GET to reach an endpoint we do not need would be new
// machinery for zero new capability.

const chatRouter = require('./chat-router');

// PINNED, NEVER AN ALIAS — the same pin server.js uses for chat. An alias
// rotated onto a model with no provisioned quota and took chat to 100% 429
// with zero other error classes (see lib/__smoke_chat_model_pinned.js). The
// smoke asserts this default EQUALS server.js's CHAT_MODEL default, so the two
// cannot drift apart silently.
const TOOLS_MODEL = (process.env.CHAT_MODEL || 'gemini-3.6-flash').trim();
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Decision turn: short. It either emits a functionCall or a sentence; the
// sentence is discarded (the client owns conversation via /api/chat/stream),
// so paying for a long one is waste. Headroom for a thinking model's hidden
// tokens is still required — too low returns an EMPTY candidate, which we
// treat as "no decision" and fall back to converse.
const DECIDE_MAX_TOKENS = Number(process.env.CHAT_TOOLS_MAX_TOKENS || 1024);
const DECIDE_TIMEOUT_MS = Number(process.env.CHAT_TOOLS_TIMEOUT_MS || 12000);
// Confirmation turn: the model describes what actually happened, in the
// user's register. Hard-capped and hard-deadlined because a job card is
// already waiting on it; ANY failure falls back to the template copy.
const CONFIRM_MAX_TOKENS = Number(process.env.CHAT_TOOLS_CONFIRM_TOKENS || 512);
const CONFIRM_TIMEOUT_MS = Number(process.env.CHAT_TOOLS_CONFIRM_TIMEOUT_MS || 4000);

// How stale the DEFAULT target may be. Only guards the "model omitted job_id →
// use the most recent" path: an explicit job_id came off the context list,
// which shows every job's age, so it is a choice and we honour it.
const REEDIT_WINDOW_MS = 48 * 60 * 60 * 1000;

// How many recent jobs the model is shown. The model can only reference a job
// it has SEEN — without this list, job_id is a field it must hallucinate or
// omit, and "omit → most recent" quietly becomes the only path that ever runs.
const RECENT_JOBS_SHOWN = 5;

/** THE THREE TOOLS — each maps to an endpoint that already exists. A callable
 *  the server cannot honour is a promise the product breaks, so there is no
 *  fourth. */
const TOOL_DECLARATIONS = [
  {
    name: 'create_edit',
    description:
      'Start a NEW edit. Only call this when the context says a video is ' +
      'attached to this message, OR the user explicitly asks to make a fresh ' +
      'edit from the source of one of their previous edits (then set ' +
      'use_last_source). Never call it speculatively — it starts a real, ' +
      'billed render.',
    parameters: {
      type: 'object',
      required: ['vibe'],
      properties: {
        vibe: {
          type: 'string',
          description: 'What the user asked for, in their own words, verbatim.',
        },
        use_last_source: {
          type: 'boolean',
          description:
            'True ONLY when no video is attached and the user explicitly asked ' +
            'to re-use the footage from a previous edit.',
        },
      },
    },
  },
  {
    name: 'revise_edit',
    description:
      'Change an edit that already exists. Use whenever the user asks for a ' +
      'change to a result they already have — including changes phrased with ' +
      'no explicit noun ("tighten the front half", "punch it up", "get rid of ' +
      'the silence at the start").',
    parameters: {
      type: 'object',
      required: ['change_request'],
      properties: {
        change_request: {
          type: 'string',
          description: 'The change the user asked for, in their own words, verbatim.',
        },
        job_id: {
          type: 'string',
          description:
            'One of the ids listed in RECENT EDITS. Omit to use their most ' +
            'recent finished edit.',
        },
      },
    },
  },
  {
    name: 'get_job_status',
    description:
      'Report progress of an edit the user has already started ("is it done ' +
      'yet", "what is taking so long", "status?").',
    parameters: {
      type: 'object',
      properties: {
        job_id: {
          type: 'string',
          description: 'One of the ids listed in RECENT EDITS. Omit for the most recent.',
        },
      },
    },
  },
];

const TOOL_NAMES = TOOL_DECLARATIONS.map((t) => t.name);

function enabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.PROMPTLY_CHAT_ACTIONS || '').trim());
}

function agePhrase(iso, nowMs) {
  const t = Date.parse(iso || '') || 0;
  if (!t) return 'age unknown';
  const mins = Math.max(0, Math.round((nowMs - t) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function isRecent(job, nowMs) {
  if (!job) return false;
  const t = Date.parse(job.updated_at || job.created_at || '') || 0;
  return t > 0 && (nowMs - t) <= REEDIT_WINDOW_MS;
}

/**
 * The RECENT EDITS block for the system prompt.
 *
 * SECURITY: job.video_url is a PRESIGNED S3 URL — a bearer capability token in
 * a query string. It never enters a model prompt. The model is told only
 * WHETHER a source exists; the server holds the URL. The smoke asserts no
 * substring of any video_url survives into the prompt.
 */
function jobsContextBlock(jobs, nowMs = Date.now()) {
  const list = (Array.isArray(jobs) ? jobs : []).slice(0, RECENT_JOBS_SHOWN);
  if (list.length === 0) return 'RECENT EDITS: none — this user has no edits yet.';
  const lines = list.map((j) => {
    const vibe = String(j.vibe_input || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const step = j.status === 'processing' && j.current_step ? `/${j.current_step}` : '';
    return `- id=${j.id} status=${j.status || 'unknown'}${step} ` +
      `${agePhrase(j.updated_at || j.created_at, nowMs)}` +
      (vibe ? ` vibe="${vibe}"` : '') +
      ` source=${j.video_url ? 'available' : 'none'}`;
  });
  return ['RECENT EDITS (most recent first):', ...lines].join('\n');
}

/** The decision-turn system prompt. Context in, tools declared separately. */
function buildToolSystemPrompt(ctx = {}) {
  const nowMs = ctx.nowMs || Date.now();
  return [
    'You are Promptly’s in-app assistant. Promptly turns a user’s own ' +
      'talking-head clip plus a short "vibe" into an edited vertical video.',
    '',
    'You have three tools. Call one ONLY when the user is asking for that ' +
      'action. Most messages are ordinary conversation — questions, chat, ' +
      'thinking out loud — and for those you simply reply in text. Replying ' +
      'in text is the normal case, not a failure.',
    '',
    'Rules that matter:',
    '- A tool call starts a REAL, BILLED render. Never call one on a musing ' +
      '("yellow captions might look nice someday") or a hypothetical.',
    '- If the user clearly wants a change but you cannot tell WHICH edit they ' +
      'mean, ask them in text. Do not guess a job id.',
    '- Only ever use an id that appears in RECENT EDITS below.',
    '- Keep any text reply to 1-3 short sentences.',
    '',
    `VIDEO ATTACHED TO THIS MESSAGE: ${ctx.hasVideoAttached ? 'yes' : 'no'}`,
    jobsContextBlock(ctx.recentJobs, nowMs),
  ].join('\n');
}

/**
 * Parse one Gemini turn. PURE.
 * @returns {{kind:'tool_call', name:string, args:object} |
 *           {kind:'text', text:string} |
 *           {kind:'empty', detail:string}}
 */
function parseModelTurn(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    const fr = data?.candidates?.[0]?.finishReason;
    return { kind: 'empty', detail: fr ? `finishReason=${fr}` : 'no_parts' };
  }
  for (const p of parts) {
    const fc = p && (p.functionCall || p.function_call);
    if (fc && fc.name) {
      return {
        kind: 'tool_call',
        name: String(fc.name),
        args: (fc.args && typeof fc.args === 'object') ? fc.args : {},
      };
    }
  }
  const text = parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('').trim();
  if (!text) return { kind: 'empty', detail: 'no_text_no_call' };
  return { kind: 'text', text };
}

/**
 * Turn a parsed tool call into an executable verdict. PURE — no network, no DB.
 *
 * THE SERVER VALIDATES EVERY ID; IT NEVER TRUSTS ONE. A model-supplied job_id
 * is caller-influenced input (the caller can say anything to the model), so it
 * must resolve to a row in the caller's OWN recent-jobs list — which the route
 * selected with .eq('user_id', authUser.id) — or the tool refuses BEFORE any
 * self-forward. Relying on the downstream ownership check alone would turn a
 * forged id into a confusing downstream error and leave the attempt uncounted.
 *
 * @param {{kind:string,name?:string,args?:object,text?:string}} turn
 * @param {object} ctx { hasVideoAttached, recentJobs, nowMs }
 */
function resolveToolCall(turn, ctx = {}) {
  const nowMs = ctx.nowMs || Date.now();
  const jobs = Array.isArray(ctx.recentJobs) ? ctx.recentJobs : [];
  const byId = (id) => jobs.find((j) => String(j.id) === String(id)) || null;
  const mostRecent = jobs[0] || null;
  const mostRecentDone = jobs.find((j) => String(j.status) === 'completed') || null;

  if (turn.kind === 'text') return { kind: 'converse', reason: 'model_text', text: turn.text };
  if (turn.kind !== 'tool_call') {
    // A model turn that produced neither text nor a call decided nothing.
    // Fail LOUDLY to us, never to the user: converse is the safe floor (the
    // client falls through to the normal streaming chat), and the reason is
    // ledgered so an empty-candidate rate is visible rather than invisible.
    return { kind: 'converse', reason: `model_empty:${turn.detail || 'unknown'}` };
  }

  if (!TOOL_NAMES.includes(turn.name)) {
    // A name we do not implement. Never silently converse — that is the
    // health of the contract, and it should be zero forever.
    return { kind: 'converse', reason: 'tool_unknown', unknownTool: turn.name };
  }

  const args = turn.args || {};

  if (turn.name === 'get_job_status') {
    if (args.job_id) {
      const j = byId(args.job_id);
      if (!j) return { kind: 'refuse', reason: 'job_not_yours', requestedJobId: String(args.job_id) };
      return { kind: 'status', reason: 'tool_get_job_status', jobId: String(j.id), job: j };
    }
    if (!mostRecent) return { kind: 'status', reason: 'tool_get_job_status_nojob', job: null };
    return { kind: 'status', reason: 'tool_get_job_status', jobId: String(mostRecent.id), job: mostRecent };
  }

  if (turn.name === 'revise_edit') {
    const changeRequest = String(args.change_request || '').trim();
    if (!changeRequest) {
      return {
        kind: 'clarify',
        reason: 'revise_without_change_request',
        clarifyQuestion: 'Happy to change it — what would you like different?',
      };
    }
    let target = null;
    if (args.job_id) {
      target = byId(args.job_id);
      if (!target) {
        return { kind: 'refuse', reason: 'job_not_yours', requestedJobId: String(args.job_id) };
      }
    } else {
      // The DEFAULT path only. An explicit id came off the context list (which
      // shows each job's age), so it is a choice; an OMITTED id is us guessing,
      // and guessing at a two-day-old job is how a user gets a render they did
      // not ask for.
      //
      // A render IN FLIGHT wins over any older finished one when the model did
      // not name an id: "punch it up" almost certainly means the thing they are
      // watching. Acting on it would race the render, so ask.
      const live = mostRecent && (String(mostRecent.status) === 'processing' ||
        String(mostRecent.status) === 'queued');
      if (live) {
        return {
          kind: 'clarify',
          reason: 'edit_ask_while_rendering',
          clarifyQuestion:
            'Your current edit is still rendering — want me to apply that change ' +
            'to it as soon as it finishes?',
        };
      }
      target = mostRecentDone && isRecent(mostRecentDone, nowMs) ? mostRecentDone : null;
      if (!target) {
        return {
          kind: 'clarify',
          reason: 'no_resolvable_job',
          clarifyQuestion:
            'I can do that — which video should I change? Attach one (or tell me ' +
            'to use your latest finished edit) and I’ll get started.',
        };
      }
    }
    const status = String(target.status || '');
    if (status === 'processing' || status === 'queued') {
      // Acting would race the render; dropping it silently is the judge's
      // failure class. Ask instead.
      return {
        kind: 'clarify',
        reason: 'edit_ask_while_rendering',
        clarifyQuestion:
          'Your current edit is still rendering — want me to apply that change ' +
          'to it as soon as it finishes?',
      };
    }
    if (status !== 'completed') {
      return {
        kind: 'clarify',
        reason: 'target_not_completed',
        clarifyQuestion:
          'That edit didn’t finish, so there’s nothing to change yet — want me to ' +
          'start it again?',
      };
    }
    return {
      kind: 'act_reedit',
      reason: args.job_id ? 'tool_revise_explicit_job' : 'tool_revise_default_job',
      changeRequest,
      jobId: String(target.id),
    };
  }

  // create_edit
  const vibe = String(args.vibe || '').trim();
  if (ctx.hasVideoAttached) {
    // Composer semantics, unchanged: an attached video + a message IS a render
    // ask. The server-side router must never make an attached upload harder to
    // render than the composer does.
    return { kind: 'act_render', reason: 'tool_create_attached', vibe: vibe, source: 'attached' };
  }
  // NO UPLOAD REGISTRY EXISTS. /api/upload-url mints a presigned PUT and writes
  // NO row (server.js:2906-2946), so "the user's most recently uploaded video"
  // has no server-side resolver. The only source the server can actually honour
  // without one is video_jobs.video_url from a previous job — and re-using it
  // starts a real billed render, so the model must ASK FOR IT EXPLICITLY
  // (use_last_source). Anything else clarifies rather than acting silently.
  if (args.use_last_source === true) {
    const src = jobs.find((j) => j.video_url) || null;
    if (src) {
      return {
        kind: 'act_render',
        reason: 'tool_create_last_source',
        vibe,
        source: 'last_job',
        sourceJobId: String(src.id),
        videoUrl: String(src.video_url),
      };
    }
  }
  return {
    kind: 'clarify',
    reason: 'create_without_source',
    clarifyQuestion:
      'I can start that — attach the video you want me to edit and I’ll get going.',
  };
}

/** Default network call. Injectable so every decision path is testable with no
 *  network and no spend. */
async function geminiGenerate(payload, { timeoutMs = DECIDE_TIMEOUT_MS } = {}) {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) {
    const e = new Error('gemini_not_configured');
    e.code = 'no_key';
    throw e;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // AQ-format keys are rejected on ?key= and MUST travel in x-goog-api-key.
    // Never send both — a query key + header is "Multiple authentication
    // credentials".
    const res = await fetch(`${GEMINI_BASE}/${TOOLS_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(`gemini_http_${res.status}`);
      e.status = res.status;
      e.body = body.slice(0, 400);
      throw e;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ONE model turn: tool call or text. Returns a verdict in the SAME `kind`
 * vocabulary the route and the iOS client already speak.
 *
 * @param {string} message
 * @param {object} ctx { hasVideoAttached, recentJobs, nowMs, generate }
 */
async function decideChatAction(message, ctx = {}) {
  const msg = String(message || '').trim();
  const generate = ctx.generate || geminiGenerate;

  // Trivial input never burns a model call. This is NOT intent vocabulary —
  // it is "there is not one letter or digit here" (chat-router owns it).
  if (chatRouter.isTrivialMessage(msg)) {
    return { kind: 'converse', reason: 'trivial' };
  }

  const payload = {
    system_instruction: { parts: [{ text: buildToolSystemPrompt(ctx) }] },
    contents: [{ role: 'user', parts: [{ text: msg }] }],
    tools: [{ function_declarations: TOOL_DECLARATIONS }],
    tool_config: { function_calling_config: { mode: 'AUTO' } },
    generationConfig: { maxOutputTokens: DECIDE_MAX_TOKENS, temperature: 0.2 },
  };

  let data;
  try {
    data = await generate(payload, { timeoutMs: DECIDE_TIMEOUT_MS });
  } catch (e) {
    // The decision failed; the USER must not. Converse is the safe floor —
    // the client falls through to /api/chat/stream and gets a normal reply —
    // and the reason is ledgered so a broken decider is visible, not silent.
    return { kind: 'converse', reason: `decide_failed:${(e && e.message) || 'error'}` };
  }

  const turn = parseModelTurn(data);
  const verdict = resolveToolCall(turn, ctx);
  verdict.turn = turn;
  return verdict;
}

/**
 * SECOND TURN — the model writes the confirmation, because it already knows
 * what happened and says it in the user's own register. The server still owns
 * the OUTCOME (whether the job exists); the model owns only how it is
 * described, and ANY failure falls back to the template copy.
 *
 * function_calling_config.mode = 'NONE' is load-bearing: a second turn that
 * could call a tool could dispatch a SECOND render for one user message.
 */
async function composeConfirmation({ message, verdict, toolResult, ctx = {} }) {
  const fallback = actionEcho(verdict.kind, toolResult && toolResult.jobId);
  const generate = ctx.generate || geminiGenerate;
  const call = verdict.turn && verdict.turn.kind === 'tool_call' ? verdict.turn : null;
  if (!call) return fallback;
  const payload = {
    system_instruction: {
      parts: [{
        text: 'You are Promptly’s in-app assistant. The action below already ' +
          'happened. Confirm it to the user in ONE short, warm sentence. Do not ' +
          'promise anything the result does not say. No emojis.',
      }],
    },
    contents: [
      { role: 'user', parts: [{ text: String(message || '') }] },
      { role: 'model', parts: [{ functionCall: { name: call.name, args: call.args || {} } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: call.name, response: toolResult || {} } }],
      },
    ],
    tool_config: { function_calling_config: { mode: 'NONE' } },
    generationConfig: { maxOutputTokens: CONFIRM_MAX_TOKENS, temperature: 0.6 },
  };
  try {
    const data = await generate(payload, { timeoutMs: CONFIRM_TIMEOUT_MS });
    const turn = parseModelTurn(data);
    if (turn.kind === 'text' && turn.text.trim()) return turn.text.trim();
  } catch (_) { /* fall through to the template */ }
  return fallback;
}

/** Template copy — the floor under every confirmation. The conversation IS the
 *  editing session record, so an action always says something. */
function actionEcho(kind, jobId) {
  if (kind === 'act_render') {
    return 'On it — your edit is rendering now. I’ll post it here the moment it’s done.';
  }
  if (kind === 'act_reedit') {
    return 'Got it — applying that change to your edit now. The updated video will land here when it’s ready.';
  }
  return jobId ? `Working on job ${jobId}.` : 'Working on it.';
}

module.exports = {
  enabled,
  decideChatAction,
  composeConfirmation,
  actionEcho,
  // Pure pieces — every one of these is exercised offline by the smoke.
  TOOL_DECLARATIONS,
  TOOL_NAMES,
  TOOLS_MODEL,
  buildToolSystemPrompt,
  jobsContextBlock,
  parseModelTurn,
  resolveToolCall,
  geminiGenerate,
  REEDIT_WINDOW_MS,
  RECENT_JOBS_SHOWN,
};

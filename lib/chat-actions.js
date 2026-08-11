'use strict';

// chat-actions classifier (LANE-SEAM Step 4, 2026-08-09) — the intent layer
// that lets the chat ACT. DARK behind PROMPTLY_CHAT_ACTIONS.
//
// The product seam this closes: free text is routed chat XOR render by the
// CLIENT (EditorView.swift:2443 — decided by whether a video is attached), so
// the chat can discuss edits it is architecturally incapable of performing.
// Under the flag, the client sends free text HERE and the SERVER decides:
//
//   converse    → client falls through to /api/chat/stream exactly as today
//   status      → deterministic answer read from the job row (the existing
//                 chat-router oracle — same code, not a copy)
//   act_render  → an attached video + a non-trivial message IS a render ask
//                 (identical to today's composer semantics)
//   act_reedit  → an explicit edit imperative naming a component, with a
//                 resolvable recent completed job → change_request re-edit
//   clarify     → uncertain. NEVER silently act, NEVER silently drop — a
//                 silently-dropped ask is the exact failure the fulfillment
//                 judge counts. The clarify question names what's missing.
//
// CONSERVATIVE BY DESIGN (the owner's bar): ACT fires only on an explicit
// imperative WITH resolvable video context. Bare musing ("I wonder if yellow
// captions would look good") converses; "make the captions yellow" with a
// completed job re-edits; the same sentence with neither video nor job
// clarifies. Classification is pure + unit-tested (no network, no DB).

const chatRouter = require('./chat-router');

// The imperative edit-verb family — the SAME verbs chat-router's status
// vetoer uses (an edit instruction must never read as a status question, and
// the two lists must not drift; the smoke asserts containment).
const EDIT_VERB_RE = /\b(make|add|remove|cut|trim|zoom|slow|speed|caption|edit|put|use|give|show|create|change|swap|replace|fix|delete|turn)\b/i;

// Component nouns that anchor a re-edit to THE EXISTING VIDEO — a re-edit
// needs both an imperative and a thing-in-the-edit it points at.
const COMPONENT_NOUN_RE = /\b(captions?|subtitles?|zooms?|transitions?|b[- ]?rolls?|sfx|sounds?|music|effects?|graphics?|overlays?|texts?|titles?|cuts?|pacing|intro|outro|thumbnails?|spelling|words?|emphasis|video|edit|clip|render)\b/i;

// References to a prior artifact ("it", "that", "my video") — with a recent
// completed job these resolve; without one they clarify.
const PRIOR_REF_RE = /\b(it|that|this|the (video|edit|render|last one)|my (video|edit|render))\b/i;

// How recent a completed job must be to silently resolve "the video".
const REEDIT_WINDOW_MS = 48 * 60 * 60 * 1000;

function enabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.PROMPTLY_CHAT_ACTIONS || '').trim());
}

function isRecent(job, nowMs) {
  if (!job) return false;
  const t = Date.parse(job.updated_at || job.created_at || '') || 0;
  return t > 0 && (nowMs - t) <= REEDIT_WINDOW_MS;
}

/**
 * Classify one chat message into an action verdict. Pure.
 * @param {string} message
 * @param {object} ctx { hasVideoAttached, recentJob, nowMs }
 * @returns {{kind:string, reason:string, changeRequest?:string, vibe?:string,
 *            clarifyQuestion?:string, jobId?:string}}
 */
function classifyChatAction(message, ctx = {}) {
  const msg = String(message || '').trim();
  const nowMs = ctx.nowMs || Date.now();
  const hasVideo = Boolean(ctx.hasVideoAttached);
  const job = ctx.recentJob || null;

  // 1. Trivial input never acts and never burns a model call (same class the
  //    chat router already owns — delegate, don't re-decide).
  if (chatRouter.isTrivialMessage(msg)) {
    return { kind: 'converse', reason: 'trivial' };
  }

  // 2. An attached video IS a render ask — identical to today's composer
  //    semantics (video + text → vibe → createVideoJob). The server-side
  //    router must never make an attached upload harder to render than the
  //    composer does.
  if (hasVideo) {
    return { kind: 'act_render', reason: 'video_attached', vibe: msg };
  }

  // 3. Status questions answer deterministically from the job row.
  if (chatRouter.isStatusQuestion(msg)) {
    return { kind: 'status', reason: 'status_question' };
  }

  const imperative = EDIT_VERB_RE.test(msg);
  const component = COMPONENT_NOUN_RE.test(msg);
  const priorRef = PRIOR_REF_RE.test(msg);

  // 4. Explicit edit imperative pointed at the edit → re-edit IF a recent
  //    completed job resolves the reference. Conservative: the imperative
  //    alone is not enough — it must name a component or reference the video.
  if (imperative && (component || priorRef)) {
    if (job && String(job.status) === 'completed' && isRecent(job, nowMs)) {
      return {
        kind: 'act_reedit',
        reason: 'imperative_with_resolvable_job',
        changeRequest: msg,
        jobId: String(job.id),
      };
    }
    if (job && (String(job.status) === 'processing' || String(job.status) === 'queued')) {
      // Mid-render edit asks park as clarify — acting would race the render;
      // dropping it silently is the judge's failure class.
      return {
        kind: 'clarify',
        reason: 'edit_ask_while_rendering',
        clarifyQuestion:
          'Your current edit is still rendering — want me to apply that change ' +
          'to it as soon as it finishes?',
      };
    }
    return {
      kind: 'clarify',
      reason: 'edit_ask_without_context',
      clarifyQuestion:
        "I can do that — which video should I edit? Attach one (or tell me to " +
        'use your latest finished edit) and I’ll get started.',
    };
  }

  // 5. Everything else converses (the existing chat surface, untouched).
  return { kind: 'converse', reason: 'no_action_signal' };
}

/** The message echoed back into the conversation when an action dispatches —
 *  the conversation IS the editing session record. */
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
  classifyChatAction,
  actionEcho,
  EDIT_VERB_RE,
  COMPONENT_NOUN_RE,
  PRIOR_REF_RE,
  REEDIT_WINDOW_MS,
};

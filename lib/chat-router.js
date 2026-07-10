'use strict';

// Chat message router (stuck-jobs directive, Fix 2) — every user message gets
// a real answer, by construction. Three classes:
//   1. TRIVIAL input (a bare comma, whitespace, stray punctuation) → a warm
//      canned prompt-back. Never reaches Gemini, never burns chat quota,
//      never routes to a render.
//   2. STATUS questions while a job is around → answered deterministically
//      from the job row (stage + honest typical duration + freshness). No
//      LLM, no quota.
//   3. Everything else → the conversational LLM, with the current job's
//      status appended to the system prompt so mid-render questions get
//      grounded answers (and a new vibe mid-render gets acknowledge+offer).
//
// Pure functions — unit-tested without a network or DB.

/** Class 1: no letters and no digits anywhere (",", "...", "??", whitespace). */
function isTrivialMessage(message) {
  const s = String(message || '').trim();
  if (s.length === 0) return true;
  // Strip everything that isn't a letter (any script) or digit; if nothing
  // remains, there is no content to act on.
  const meaningful = s.replace(/[^\p{L}\p{N}]/gu, '');
  return meaningful.length === 0;
}

const TRIVIAL_REPLY =
  "Looks like that message came through empty! Tell me what you'd like — " +
  'attach a video with a vibe to start an edit, or ask me anything about Promptly.';

/** Class 2 detector: is this a "how's my render doing" question? */
function isStatusQuestion(message) {
  const s = String(message || '').toLowerCase().trim();
  // Guard (review finding): edit INSTRUCTIONS must never classify as status
  // questions ("make the status bar pop", "slow the video down", "add a
  // progress bar"). Imperative edit verbs veto the class outright — a real
  // status question is interrogative, not imperative.
  if (/\b(make|add|remove|cut|trim|zoom|slow|speed|caption|edit|put|use|give|show|render\s+it|create)\b/.test(s)) {
    return false;
  }
  return (
    /taking\s+(so\s+)?long/.test(s) ||
    /how\s+(much\s+)?longer/.test(s) ||
    /(is|are)\s+(it|my\s+(video|edit|render))\s+(done|ready|finished)/.test(s) ||
    /done\s+yet|ready\s+yet|finished\s+yet/.test(s) ||
    // Bare keywords only as (near-)whole message — "status?", "what's the eta"
    /^\s*(what('|\u2019)?s\s+the\s+)?(status|progress|eta)\s*\??\s*$/.test(s) ||
    /(is|why\s+is|it('|\u2019)?s)\s+(stuck|frozen|not\s+(moving|working|loading))/.test(s) ||
    /(stuck|frozen)\s*\?/.test(s) ||
    // Whole-message complaint form: "video not moving", "my render stuck"
    /^(my\s+)?(video|edit|render|upload)\s+(is\s+)?(stuck|frozen|not\s+(moving|working|loading))\s*[.!?]*$/.test(s) ||
    /when\s+(will|is).{0,32}(done|ready|finish)/.test(s) ||
    /why\s+is\s+(it|this|my\s+(video|edit|render))\s+(so\s+)?(slow|taking)/.test(s)
  );
}

/** Human stage names + honest typical durations for the deterministic answer. */
const STAGE_INFO = {
  queued: { label: 'queued to start', typical: 'usually under a minute' },
  download: { label: 'loading your video in', typical: 'usually under a minute' },
  analyze: { label: 'analyzing your footage', typical: 'usually 1–2 minutes' },
  transcribe: { label: 'transcribing the audio', typical: 'usually under a minute' },
  face_detect: { label: 'tracking faces', typical: 'usually under a minute' },
  plan: { label: 'writing the edit recipe', typical: 'usually 1–3 minutes' },
  broll_search: { label: 'sourcing B-roll', typical: 'usually under a minute' },
  render: { label: 'rendering — usually the longest part', typical: 'about 3–5 minutes' },
  complete: { label: 'finishing up', typical: 'moments away' },
};

function freshnessPhrase(updatedAtIso, nowMs = Date.now()) {
  const t = new Date(updatedAtIso || 0).getTime();
  if (!Number.isFinite(t) || t <= 0) return '';
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 20) return 'still moving as of a few seconds ago';
  if (s < 120) return `last update ${s} seconds ago`;
  const m = Math.round(s / 60);
  return `last update ${m} minute${m === 1 ? '' : 's'} ago`;
}

/**
 * Deterministic status answer from the job row. `job` is the user's most
 * recent video_jobs row (or null). Returns a string reply, or null when
 * there's no job to talk about (caller falls through to the LLM).
 */
function statusAnswerFromJob(job, nowMs = Date.now()) {
  if (!job) return null;
  const status = String(job.status || '');
  if (status === 'processing' || status === 'queued') {
    const info = STAGE_INFO[String(job.current_step || '').toLowerCase()] ||
      { label: 'working on your edit', typical: 'a few minutes end to end' };
    const fresh = freshnessPhrase(job.updated_at, nowMs);
    return `Your edit is in the ${info.label} stage — ${info.typical}.` + (fresh ? ` ${fresh[0].toUpperCase()}${fresh.slice(1)}.` : '');
  }
  if (status === 'completed') {
    return 'Good news — that edit is finished! It should be in your chat and Library now.';
  }
  if (status === 'failed') {
    const copy = String(job.error_message || '').trim();
    return copy
      ? `That render hit a problem: ${copy}`
      : 'That render hit a problem on our side and was stopped — you weren’t charged. Tap retry on the message to run it again.';
  }
  if (status === 'canceled') {
    return 'That render was canceled. Send your video with a vibe whenever you want to start a fresh one.';
  }
  if (status === 'needs_input') {
    return 'Your edit is paused on a question from Lumen — answer it on the render card and it will pick right back up.';
  }
  return null;
}

/**
 * One-line job context for the LLM system prompt (class 3), so mid-render
 * chat is grounded. Returns '' when there is no recent job.
 */
function jobContextLine(job, nowMs = Date.now()) {
  if (!job) return '';
  const status = String(job.status || '');
  if (status === 'processing' || status === 'queued') {
    const info = STAGE_INFO[String(job.current_step || '').toLowerCase()];
    const fresh = freshnessPhrase(job.updated_at, nowMs);
    return `Context: the user has a video edit rendering right now (stage: ${info ? info.label : status}${fresh ? ', ' + fresh : ''}). ` +
      'If they ask about it, answer from this. If they send a NEW edit idea while this one runs, acknowledge it warmly and offer to start a fresh edit with that vibe once the current one finishes.';
  }
  if (status === 'failed') {
    return 'Context: the user’s most recent render failed and was refunded; the message card has a retry. If they seem frustrated, acknowledge it and point them to retry.';
  }
  if (status === 'completed') {
    return 'Context: the user’s most recent render completed successfully.';
  }
  return '';
}

module.exports = {
  isTrivialMessage,
  TRIVIAL_REPLY,
  isStatusQuestion,
  statusAnswerFromJob,
  jobContextLine,
  STAGE_INFO,
  freshnessPhrase,
};

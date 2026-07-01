'use strict';

// Pure validation + the security guard for Phase D ask-back answers submitted on
// the re-edit rail. No I/O — unit-tested in tests/ask.test.js.

const VALID_ANSWER_KINDS = ['text', 'image', 'clip', 'choice'];
const MAX_ANSWER_TEXT_LEN = 4000;
const MAX_KEY_LEN = 512;
const MAX_CHOICE_LEN = 256;
const MAX_ASK_ID_LEN = 128;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * A re-edit body is an ANSWER submission (vs a fresh change-request re-edit)
 * iff it carries an ask_id.
 */
function isAnswerSubmission(body) {
  return !!(body && isNonEmptyString(body.ask_id || body.askId));
}

/**
 * Validate + normalize an answer payload. Requires ask_id AND at least one of
 * (skip, text, image_key, clip_key, choice). Returns {ok,value}|{ok:false,error}.
 * Never trusts the client for identity/status — that's canAcceptAnswer's job.
 */
function validateAnswer(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'missing body' };

  const askId = String(body.ask_id || body.askId || '').trim();
  if (!askId) return { ok: false, error: 'ask_id is required' };
  if (askId.length > MAX_ASK_ID_LEN) return { ok: false, error: 'ask_id too long' };

  const skip = body.skip === true || body.skip === 'true';

  const rawText = body.answer != null ? body.answer
    : (body.answer_text != null ? body.answer_text : (body.answerText != null ? body.answerText : ''));
  const text = typeof rawText === 'string' ? rawText : String(rawText || '');
  const imageKey = String(body.answer_image_key || body.answerImageKey || '').trim();
  const clipKey = String(body.answer_clip_key || body.answerClipKey || '').trim();
  const choice = String(body.answer_choice || body.answerChoice || '').trim();

  if (text.length > MAX_ANSWER_TEXT_LEN) return { ok: false, error: 'answer text too long' };
  if (imageKey.length > MAX_KEY_LEN || clipKey.length > MAX_KEY_LEN) return { ok: false, error: 'asset key too long' };
  if (choice.length > MAX_CHOICE_LEN) return { ok: false, error: 'choice too long' };

  const hasContent = skip || isNonEmptyString(text) || !!imageKey || !!clipKey || isNonEmptyString(choice);
  if (!hasContent) return { ok: false, error: 'answer requires skip or one of text/image/clip/choice' };

  const value = {
    ask_id: askId,
    skip,
    text: isNonEmptyString(text) ? text.trim() : null,
    image_key: imageKey || null,
    clip_key: clipKey || null,
    choice: isNonEmptyString(choice) ? choice.trim() : null,
  };
  return { ok: true, value };
}

/**
 * THE guard. Accept an answer ONLY when the job is the caller's AND still parked
 * at needs_input AND the ask_id matches the parked ask. This is what makes
 * double-answer, answer-after-timeout, stale-ask, and wrong-user all safe
 * rejects (the job is no longer awaiting this input). Returns
 * {ok:true}|{ok:false,reason}.
 */
function canAcceptAnswer({ job, userId, askId }) {
  if (!job) return { ok: false, reason: 'not_found' };
  if (!userId || job.user_id !== userId) return { ok: false, reason: 'forbidden' };
  if (job.status !== 'needs_input') return { ok: false, reason: 'not_awaiting_input' };
  const parkedAskId = job.ask && (job.ask.ask_id || job.ask.askId);
  if (!parkedAskId || String(parkedAskId) !== String(askId || '')) {
    return { ok: false, reason: 'ask_id_mismatch' };
  }
  return { ok: true };
}

module.exports = {
  VALID_ANSWER_KINDS,
  MAX_ANSWER_TEXT_LEN,
  MAX_KEY_LEN,
  MAX_CHOICE_LEN,
  MAX_ASK_ID_LEN,
  isAnswerSubmission,
  validateAnswer,
  canAcceptAnswer,
};

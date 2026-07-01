'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  isAnswerSubmission,
  validateAnswer,
  canAcceptAnswer,
  MAX_ANSWER_TEXT_LEN,
} = require('../lib/ask');

// ── isAnswerSubmission ──────────────────────────────────────────────────────
test('isAnswerSubmission: true only when ask_id present', () => {
  assert.equal(isAnswerSubmission({ ask_id: 'a1' }), true);
  assert.equal(isAnswerSubmission({ askId: 'a1' }), true);
  assert.equal(isAnswerSubmission({ change_request: 'make it faster' }), false);
  assert.equal(isAnswerSubmission({ ask_id: '' }), false);
  assert.equal(isAnswerSubmission({ ask_id: '   ' }), false);
  assert.equal(isAnswerSubmission({}), false);
  assert.equal(isAnswerSubmission(null), false);
});

// ── validateAnswer ──────────────────────────────────────────────────────────
test('validateAnswer: requires ask_id', () => {
  assert.equal(validateAnswer({ answer: 'hi' }).ok, false);
  assert.equal(validateAnswer({ ask_id: '', answer: 'hi' }).ok, false);
  assert.equal(validateAnswer(null).ok, false);
});

test('validateAnswer: skip is a valid answer with no content', () => {
  const r = validateAnswer({ ask_id: 'a1', skip: true });
  assert.equal(r.ok, true);
  assert.equal(r.value.skip, true);
  assert.equal(r.value.text, null);
});

test('validateAnswer: requires at least one of skip/text/image/clip/choice', () => {
  const r = validateAnswer({ ask_id: 'a1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /skip or one of/);
});

test('validateAnswer: text answer', () => {
  const r = validateAnswer({ ask_id: 'a1', answer: '  it is a fitness app  ' });
  assert.equal(r.ok, true);
  assert.equal(r.value.text, 'it is a fitness app');
  assert.equal(r.value.skip, false);
});

test('validateAnswer: image/clip/choice keys', () => {
  const img = validateAnswer({ ask_id: 'a1', answer_image_key: 'uploads/x.jpg' });
  assert.equal(img.ok, true);
  assert.equal(img.value.image_key, 'uploads/x.jpg');
  const clip = validateAnswer({ ask_id: 'a1', answer_clip_key: 'uploads/c.mp4' });
  assert.equal(clip.ok, true);
  assert.equal(clip.value.clip_key, 'uploads/c.mp4');
  const choice = validateAnswer({ ask_id: 'a1', answer_choice: 'moody treatment' });
  assert.equal(choice.ok, true);
  assert.equal(choice.value.choice, 'moody treatment');
});

test('validateAnswer: enforces length caps', () => {
  assert.equal(validateAnswer({ ask_id: 'a1', answer: 'x'.repeat(MAX_ANSWER_TEXT_LEN + 1) }).ok, false);
  assert.equal(validateAnswer({ ask_id: 'a1', answer_image_key: 'k'.repeat(600) }).ok, false);
  assert.equal(validateAnswer({ ask_id: 'x'.repeat(200), answer: 'hi' }).ok, false);
});

test('validateAnswer: camelCase aliases accepted', () => {
  const r = validateAnswer({ askId: 'a1', answerImageKey: 'uploads/x.jpg' });
  assert.equal(r.ok, true);
  assert.equal(r.value.ask_id, 'a1');
  assert.equal(r.value.image_key, 'uploads/x.jpg');
});

// ── canAcceptAnswer (THE guard) ─────────────────────────────────────────────
const parked = { id: 'j1', user_id: 'u1', status: 'needs_input', ask: { ask_id: 'a1' } };

test('canAcceptAnswer: valid parked job for its owner', () => {
  assert.deepEqual(canAcceptAnswer({ job: parked, userId: 'u1', askId: 'a1' }), { ok: true });
});

test('canAcceptAnswer: wrong user is forbidden', () => {
  assert.equal(canAcceptAnswer({ job: parked, userId: 'u2', askId: 'a1' }).reason, 'forbidden');
});

test('canAcceptAnswer: missing job is not_found', () => {
  assert.equal(canAcceptAnswer({ job: null, userId: 'u1', askId: 'a1' }).reason, 'not_found');
});

test('canAcceptAnswer: double-answer / after-timeout — job no longer needs_input', () => {
  // Already resumed (processing) — the second answer is a safe no-op.
  assert.equal(canAcceptAnswer({ job: { ...parked, status: 'processing' }, userId: 'u1', askId: 'a1' }).reason, 'not_awaiting_input');
  // Timed out & completed while the user was answering.
  assert.equal(canAcceptAnswer({ job: { ...parked, status: 'completed' }, userId: 'u1', askId: 'a1' }).reason, 'not_awaiting_input');
});

test('canAcceptAnswer: stale/mismatched ask_id rejected', () => {
  assert.equal(canAcceptAnswer({ job: parked, userId: 'u1', askId: 'OLD' }).reason, 'ask_id_mismatch');
  assert.equal(canAcceptAnswer({ job: { ...parked, ask: null }, userId: 'u1', askId: 'a1' }).reason, 'ask_id_mismatch');
});

test('canAcceptAnswer: accepts askId alias on the row', () => {
  const j = { ...parked, ask: { askId: 'a1' } };
  assert.deepEqual(canAcceptAnswer({ job: j, userId: 'u1', askId: 'a1' }), { ok: true });
});

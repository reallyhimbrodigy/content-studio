'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  isTrivialMessage, TRIVIAL_REPLY, isStatusQuestion, statusAnswerFromJob, jobContextLine,
} = require('../lib/chat-router');

// ── Class 1: trivial input ───────────────────────────────────────────────
test('trivial: bare comma, whitespace, punctuation-only — never content', () => {
  for (const s of [',', ' ', '...', '???', '—', '!!', '.', ', ,', '\n', '*']) {
    assert.equal(isTrivialMessage(s), true, JSON.stringify(s));
  }
});

test('non-trivial: real words, single letters, digits, non-latin scripts', () => {
  for (const s of ['hi', 'a', '2', 'why is it slow', 'Сделай видео', '早い', 'k?']) {
    assert.equal(isTrivialMessage(s), false, JSON.stringify(s));
  }
});

test('trivial reply is display-safe and non-empty', () => {
  assert.ok(TRIVIAL_REPLY.length > 20 && TRIVIAL_REPLY.length < 300);
});

// ── Class 2: status questions ────────────────────────────────────────────
test('status questions detected', () => {
  for (const s of [
    'why is it taking so long?', 'How much longer?', 'is my video done',
    'is it ready yet', 'whats the status', 'my render is stuck',
    'video not moving', 'when will it be done', 'ETA?', 'progress?',
  ]) {
    assert.equal(isStatusQuestion(s), true, s);
  }
});

test('non-status messages pass through to the LLM', () => {
  for (const s of ['hello', 'make it punchy and fast', 'what is promptly?', 'thanks!']) {
    assert.equal(isStatusQuestion(s), false, s);
  }
});

test('REVIEW regression: edit instructions never classify as status questions', () => {
  for (const s of [
    'make the status bar pop', 'add a progress bar', 'slow the video down',
    'make it slow and cinematic', 'speed up the middle', 'show progress numbers on screen',
    'edit the video so the render looks stuck in time', 'put an eta counter in the corner',
  ]) {
    assert.equal(isStatusQuestion(s), false, s);
  }
  // ...while genuine questions still classify
  for (const s of ['status?', "what's the eta", 'is it stuck?', 'why is it taking so long']) {
    assert.equal(isStatusQuestion(s), true, s);
  }
});

// ── Deterministic answers from the row ───────────────────────────────────
test('processing job → stage + typical duration + freshness', () => {
  const now = Date.now();
  const a = statusAnswerFromJob({
    status: 'processing', current_step: 'render',
    updated_at: new Date(now - 8000).toISOString(),
  }, now);
  assert.match(a, /rendering — usually the longest part/);
  assert.match(a, /3–5 minutes/);
  assert.match(a, /few seconds ago/);
});

test('failed job → surfaces the stored copy (or honest generic)', () => {
  assert.match(statusAnswerFromJob({ status: 'failed', error_message: 'This render stalled on our side — you weren’t charged. Tap to try again.' }), /stalled on our side/);
  assert.match(statusAnswerFromJob({ status: 'failed', error_message: '' }), /weren’t charged/);
});

test('completed / canceled / needs_input all answered; no job → null (falls to LLM)', () => {
  assert.match(statusAnswerFromJob({ status: 'completed' }), /finished/);
  assert.match(statusAnswerFromJob({ status: 'canceled' }), /canceled/);
  assert.match(statusAnswerFromJob({ status: 'needs_input' }), /question from Lumen/);
  assert.equal(statusAnswerFromJob(null), null);
});

// ── LLM grounding line ───────────────────────────────────────────────────
test('in-flight job produces a context line with the acknowledge+offer instruction', () => {
  const line = jobContextLine({ status: 'processing', current_step: 'plan', updated_at: new Date().toISOString() });
  assert.match(line, /rendering right now/);
  assert.match(line, /offer to start a fresh edit/);
});

test('no recent job → empty context', () => {
  assert.equal(jobContextLine(null), '');
});

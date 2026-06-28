'use strict';

// Run with:  node --test tests/feedback.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const {
  VALID_RATINGS,
  MAX_FEEDBACK_TEXT_LEN,
  MAX_JOB_ID_LEN,
  MAX_APP_VERSION_LEN,
  isValidRating,
  validateFeedback,
} = require('../lib/feedback');

// --- isValidRating ---

test('isValidRating: each valid rating is true', () => {
  for (const r of VALID_RATINGS) {
    assert.strictEqual(isValidRating(r), true);
  }
});

test('isValidRating: null / undefined are allowed', () => {
  assert.strictEqual(isValidRating(null), true);
  assert.strictEqual(isValidRating(undefined), true);
});

test('isValidRating: case-insensitive + trimmed', () => {
  assert.strictEqual(isValidRating('  UP  '), true);
  assert.strictEqual(isValidRating('Down'), true);
});

test('isValidRating: invalid rating is false', () => {
  assert.strictEqual(isValidRating('maybe'), false);
  assert.strictEqual(isValidRating('sideways'), false);
  assert.strictEqual(isValidRating(''), false);
});

// --- validateFeedback: accepted ---

test('validateFeedback: up with text is accepted', () => {
  const r = validateFeedback({ rating: 'up', text: 'Great tool!' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.rating, 'up');
  assert.strictEqual(r.value.text, 'Great tool!');
  assert.strictEqual(r.value.job_id, null);
  assert.strictEqual(r.value.app_version, null);
});

test('validateFeedback: down with job_id + app_version is accepted', () => {
  const r = validateFeedback({
    rating: 'down',
    text: 'Audio was off',
    job_id: 'job-123',
    app_version: '1.1.5',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.rating, 'down');
  assert.strictEqual(r.value.text, 'Audio was off');
  assert.strictEqual(r.value.job_id, 'job-123');
  assert.strictEqual(r.value.app_version, '1.1.5');
});

test('validateFeedback: rating-only (no text) is accepted', () => {
  const r = validateFeedback({ rating: 'up' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.rating, 'up');
  assert.strictEqual(r.value.text, null);
});

test('validateFeedback: text-only (no rating) is accepted', () => {
  const r = validateFeedback({ text: 'Just some feedback' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.rating, null);
  assert.strictEqual(r.value.text, 'Just some feedback');
});

test('validateFeedback: rating is case-insensitively normalized', () => {
  const r = validateFeedback({ rating: 'UP', text: 'nice' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.rating, 'up');
});

test('validateFeedback: text is trimmed', () => {
  const r = validateFeedback({ rating: 'up', text: '  hello  ' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.text, 'hello');
});

test('validateFeedback: text at the max length is accepted', () => {
  const r = validateFeedback({ text: 'x'.repeat(MAX_FEEDBACK_TEXT_LEN) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.text.length, MAX_FEEDBACK_TEXT_LEN);
});

// --- validateFeedback: empty/whitespace collapse to null ---

test('validateFeedback: whitespace-only text with a rating collapses text to null', () => {
  const r = validateFeedback({ rating: 'down', text: '   ' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.rating, 'down');
  assert.strictEqual(r.value.text, null);
});

test('validateFeedback: empty job_id / app_version collapse to null', () => {
  const r = validateFeedback({ rating: 'up', job_id: '   ', app_version: '' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.job_id, null);
  assert.strictEqual(r.value.app_version, null);
});

// --- validateFeedback: rejected ---

test('validateFeedback: empty body is rejected', () => {
  const r = validateFeedback({});
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('validateFeedback: no args is rejected', () => {
  const r = validateFeedback();
  assert.strictEqual(r.ok, false);
});

test('validateFeedback: rating-absent + whitespace-only text is rejected', () => {
  const r = validateFeedback({ text: '   ' });
  assert.strictEqual(r.ok, false);
});

test('validateFeedback: invalid rating is rejected', () => {
  const r = validateFeedback({ rating: 'maybe', text: 'hi' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('validateFeedback: text too long is rejected', () => {
  const r = validateFeedback({ text: 'x'.repeat(MAX_FEEDBACK_TEXT_LEN + 1) });
  assert.strictEqual(r.ok, false);
});

test('validateFeedback: over-length job_id is rejected', () => {
  const r = validateFeedback({ rating: 'up', job_id: 'j'.repeat(MAX_JOB_ID_LEN + 1) });
  assert.strictEqual(r.ok, false);
});

test('validateFeedback: over-length app_version is rejected', () => {
  const r = validateFeedback({ rating: 'up', app_version: 'v'.repeat(MAX_APP_VERSION_LEN + 1) });
  assert.strictEqual(r.ok, false);
});

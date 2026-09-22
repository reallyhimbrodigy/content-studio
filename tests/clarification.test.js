'use strict';
const test = require('node:test');
const assert = require('node:assert');

const C = require('../lib/clarification');

// Fixtures mirror the 19 rows in prod: status needs_input, ask NULL,
// partial_state NULL, result.clarification_question non-empty, parent present.
const parked = (o = {}) => ({
  id: 'c1', status: 'needs_input', parent_job_id: 'p1', ask: null,
  partial_state: null, created_at: '2026-09-01T00:00:00Z',
  result: { clarification_question: 'Which part should be faster?' }, ...o,
});

test('the question is read from result, never from the ask column', () => {
  assert.strictEqual(C.questionOf(parked()), 'Which part should be faster?');
  // the shape that actually exists in prod: ask column null, result populated
  assert.strictEqual(C.questionOf(parked({ ask: null })), 'Which part should be faster?');
});

test('an ask-back park is NOT a clarification park', () => {
  // Phase D writes result.ask, never result.clarification_question. Reading the
  // status alone is what let one mechanism be handled by the other's code path.
  const askBack = parked({ result: { ask: { ask_id: 'ask_low_light', prompt: 'Brighter clip?' } } });
  assert.strictEqual(C.isClarificationPark(askBack), false);
  assert.strictEqual(C.questionOf(askBack), null);
});

test('a blank or whitespace question is not a question', () => {
  assert.strictEqual(C.questionOf(parked({ result: { clarification_question: '   ' } })), null);
  assert.strictEqual(C.isClarificationPark(parked({ result: { clarification_question: '' } })), false);
});

test('only needs_input rows are parks', () => {
  for (const s of ['completed', 'failed', 'canceled', 'processing', 'queued']) {
    assert.strictEqual(C.isClarificationPark(parked({ status: s })), false, s);
  }
  assert.strictEqual(C.isClarificationPark(parked()), true);
});

test('the retry target is the PARENT, not the parked row itself', () => {
  // Retrying against the parked row would re-edit a job that never rendered.
  assert.strictEqual(C.retryTargetFor(parked()), 'p1');
});

test('a parentless park has no retry target and must not fall back to its own id', () => {
  assert.strictEqual(C.retryTargetFor(parked({ parent_job_id: null })), null);
  const f = C.deliveryFields(parked({ parent_job_id: null }));
  assert.strictEqual(f.clarification_retry_job_id, null);
  assert.strictEqual(f.clarification_question, 'Which part should be faster?');
});

test('deliveryFields returns stable nulls for a non-park, not absent keys', () => {
  const f = C.deliveryFields({ status: 'completed', result: null });
  assert.deepStrictEqual(Object.keys(f).sort(),
    ['clarification_question', 'clarification_retry_job_id']);
  assert.strictEqual(f.clarification_question, null);
  assert.strictEqual(f.clarification_retry_job_id, null);
});

test('expiry is 24h from creation', () => {
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  const row = parked({ created_at: '2026-09-01T00:00:00Z' });
  assert.strictEqual(C.isExpired(row, t0 + 23 * 3600e3), false);
  assert.strictEqual(C.isExpired(row, t0 + 24 * 3600e3), true, 'exactly 24h expires');
  assert.strictEqual(C.isExpired(row, t0 + 25 * 3600e3), true);
});

test('a terminal row never expires — expiry only releases a HELD lock', () => {
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  assert.strictEqual(C.isExpired(parked({ status: 'completed' }), t0 + 1e9), false);
  assert.strictEqual(C.isExpired(parked({ status: 'canceled' }), t0 + 1e9), false);
});

test('an unparseable created_at never expires rather than expiring immediately', () => {
  // Defaulting to "expired" would cancel rows on a date-format change.
  assert.strictEqual(C.isExpired(parked({ created_at: 'not-a-date' }), Date.now()), false);
  assert.strictEqual(C.msUntilExpiry(parked({ created_at: null })), null);
  assert.strictEqual(C.expiresAt(parked({ created_at: undefined })), null);
});

test('expiresAt is created_at + 24h, derived — no column needed', () => {
  assert.strictEqual(C.expiresAt(parked({ created_at: '2026-09-01T00:00:00.000Z' })),
    '2026-09-02T00:00:00.000Z');
});

test('msUntilExpiry floors at 0 rather than going negative', () => {
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  assert.strictEqual(C.msUntilExpiry(parked(), t0 + 100 * 3600e3), 0);
});

test('malformed input does not throw', () => {
  for (const bad of [null, undefined, {}, { result: 'nope' }, { result: { clarification_question: 5 } }]) {
    assert.doesNotThrow(() => C.deliveryFields(bad));
    assert.strictEqual(C.isClarificationPark(bad), false);
  }
});

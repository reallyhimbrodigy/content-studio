'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { dispatchErrorMessage, clarificationMessage, renderTooShortMessage, wallRequiredMessage } = require('../lib/failure-copy');

// Mirror of the iOS display filters (MessageBubble.displaySafeError /
// EditorView.friendlySSEError): anything matching this is suppressed to the
// generic retry line on device. Wave-1 copy hygiene = the STORED
// error_message must pass this filter, so cold loads show the real copy.
function looksTechnicalToiOS(s) {
  return (
    s.includes('is not defined') || s.includes('undefined') ||
    /error:/i.test(s) || s.includes('{') || s.startsWith('[') ||
    s.length > 160 ||
    /^[a-z][a-z0-9_]*$/.test(s) // bare snake_case code
  );
}

test('Path D copy: clean, human, passes the iOS cold-load filter', () => {
  const copy = dispatchErrorMessage();
  assert.equal(looksTechnicalToiOS(copy), false, 'must not be suppressed on device');
  assert.ok(!/modal|fetch|econn|retries|exception/i.test(copy), 'no engineering vocabulary');
  assert.ok(copy.length > 20 && copy.length <= 160);
});

test('Path B copy: stores the bare question — no needs_clarification prefix', () => {
  const q = 'Which part of the video should get the zoom?';
  assert.equal(clarificationMessage(q), q);
  assert.ok(!clarificationMessage(q).includes('needs_clarification'));
  assert.equal(looksTechnicalToiOS(clarificationMessage(q)), false);
});

test('Path B copy: empty/missing question falls back to a clean prompt', () => {
  for (const v of [null, undefined, '', '   ']) {
    const copy = clarificationMessage(v);
    assert.equal(copy, 'Can you describe the change in more detail?');
    assert.equal(looksTechnicalToiOS(copy), false);
  }
});

test('RENDER_TOO_SHORT copy: honest, credit-returned, guiding, display-safe', () => {
  const copy = renderTooShortMessage();
  assert.equal(looksTechnicalToiOS(copy), false, 'must not be suppressed on device');
  assert.ok(!/unknown|something went wrong|error|failed|exception/i.test(copy), 'no UNKNOWN mask, no engineering vocab');
  assert.ok(/return|back/i.test(copy), 'confirms the credit was returned (refunded class)');
  assert.ok(/again|longer|try/i.test(copy), 'gives one clear, actionable next step');
  assert.ok(copy.length > 20 && copy.length <= 160);
});

test('WALL copy: old-client-safe soft forced-update (item 2 edge)', () => {
  const copy = wallRequiredMessage();
  // A new account on an old binary has no wall UI — this string IS what they see,
  // so it must survive the same cold-load filter and read as an update prompt.
  assert.equal(looksTechnicalToiOS(copy), false, 'must not be suppressed on an old client');
  assert.ok(/update/i.test(copy), 'reads as a soft forced-update');
  assert.ok(/trial/i.test(copy), 'names the payoff — start your free trial');
  assert.ok(!/error|failed|forbidden|403|denied/i.test(copy), 'not a technical/hostile error');
  assert.ok(copy.length > 20 && copy.length <= 160);
});

test('cold-load per class: every stored failure copy is display-safe', () => {
  // The three app-owned write classes after Wave 1 (Path C's copy is the
  // worker's user_message — worker-side rail mirror kills that class):
  const stored = [
    dispatchErrorMessage(),                       // Path D
    clarificationMessage('Should the caption move to the top?'), // Path B
    'Modal error: 503',                           // Path A — UNCHANGED (Wave 2): document today's behavior
  ];
  assert.equal(looksTechnicalToiOS(stored[0]), false);
  assert.equal(looksTechnicalToiOS(stored[1]), false);
  // Path A intentionally still trips the filter (generic on device) until Wave 2:
  assert.equal(looksTechnicalToiOS(stored[2]), true, 'Path A pending Wave 2 by design');
});

// ── WORKER-CODE COVERAGE (2026-08-30, localization) ───────────────────────────
// The app overrides the worker's user_message by error_code so the words live
// in the iOS String Catalog. A code the worker EMITS but this table does not
// MAP resolves to null, the caller falls back to the worker's free text, and a
// Hindi or Arabic reader gets English. Nothing errors — that is why it needs a
// test. These five are the codes handler.py emits alongside a user_message.
test('every worker-emitted error_code maps to server copy', () => {
  // Derived from an AST sweep of the worker for every error_code emitted
  // ALONGSIDE a user_message. INTEGRITY_TRIP and MISSING_FIELDS were absent
  // here until 2026-08-31 — INTEGRITY_TRIP alone is 38 trips / 29 users whose
  // copy was English-only, and nothing failed to say so.
  for (const code of ['TIER_CONCURRENCY_LIMIT', 'SAMPLE_MISSING',
                      'SAMPLE_UNREADABLE', 'NOT_TALKING_HEAD', 'CORE_ERROR',
                      'INTEGRITY_TRIP', 'MISSING_FIELDS']) {
    const copy = require('../lib/failure-copy').rejectionCopy(code);
    assert.ok(copy, `${code} is emitted by the worker but maps to NOTHING — the ` +
                    `app falls back to the worker's English free text`);
    assert.ok(copy.length > 40, `${code} copy is too short to be the real sentence`);
  }
  // CONTROL — the lookup must be able to MISS, or the assertions above are vacuous.
  assert.strictEqual(require('../lib/failure-copy').rejectionCopy('NOT_A_REAL_CODE_XYZ'), null,
    'an unmapped code must return null; if everything maps, this test proves nothing');
});

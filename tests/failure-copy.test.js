'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { dispatchErrorMessage, clarificationMessage, renderTooShortMessage } = require('../lib/failure-copy');

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

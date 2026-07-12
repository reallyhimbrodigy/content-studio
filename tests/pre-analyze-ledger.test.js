'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classifyGeminiFailure } = require('../lib/video-processor/pre-analyze');

// Ledger-not-swallow classifier. The load-bearing case (proven empirically
// 2026-07-11): an INVALID/rotated key returns HTTP 400 with reason
// API_KEY_INVALID — NOT 401 — so this must escalate a 400+API_KEY_INVALID to
// CRITICAL, or the exact key-rotation incident degrades silently to WARN.
const axiosErr = (status, data) => ({ response: { status, data }, message: 'x' });

test('invalid key returns 400 API_KEY_INVALID -> CRITICAL AUTH/CONFIG (the key-rotation case)', () => {
  const c = classifyGeminiFailure(axiosErr(400, { error: { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }));
  assert.equal(c.cls, 'AUTH/CONFIG');
  assert.equal(c.sev, 'CRITICAL');
  assert.equal(c.keyInvalid, true);
});

test('401 / 403 -> CRITICAL AUTH/CONFIG', () => {
  for (const s of [401, 403]) {
    const c = classifyGeminiFailure(axiosErr(s, { error: { message: 'unauthenticated' } }));
    assert.equal(c.sev, 'CRITICAL', `status ${s}`);
    assert.equal(c.keyInvalid, true);
  }
});

test('429 (or RESOURCE_EXHAUSTED) -> HIGH QUOTA', () => {
  assert.equal(classifyGeminiFailure(axiosErr(429, {})).cls, 'QUOTA');
  const c = classifyGeminiFailure(axiosErr(400, { error: { status: 'RESOURCE_EXHAUSTED' } }));
  assert.equal(c.cls, 'QUOTA');
  assert.equal(c.sev, 'HIGH');
});

test('network/timeout (no response) -> TRANSIENT WARN, not a false key alarm', () => {
  const c = classifyGeminiFailure({ message: 'ETIMEDOUT' });
  assert.equal(c.cls, 'TRANSIENT');
  assert.equal(c.sev, 'WARN');
  assert.equal(c.keyInvalid, false);
  assert.equal(c.status, null);
});

test('generic 500 -> TRANSIENT WARN (not miscategorized as auth)', () => {
  const c = classifyGeminiFailure(axiosErr(500, { error: { message: 'backend error' } }));
  assert.equal(c.cls, 'TRANSIENT');
  assert.equal(c.keyInvalid, false);
});

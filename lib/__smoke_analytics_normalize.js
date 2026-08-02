'use strict';
// Real-path smoke for analytics ingest normalisation.
//
// Guards two defects that each hid a real number:
//  1. `not_talking_head_rejected` fired with proceeded:true on 570 of 1040
//     events — a name ending "_rejected" describing a NON-rejection 55% of the
//     time. Counting it at face value produced a false 35.9% corrected
//     completion rate (real: 46.5%).
//  2. Every pre-dispatch event landed with user_id NULL, so the largest block
//     class in the product could not be cut by USER (Rule 7) at all.

const assert = require('assert');
const { normalizeEventName, resolveUserId } = require('./analytics-normalize');

// ── 1. the split ────────────────────────────────────────────────────────────
assert.strictEqual(
  normalizeEventName('not_talking_head_rejected', { proceeded: true }),
  'not_talking_head_warned',
  'a precheck the user clicked THROUGH is a warning, not a rejection');

assert.strictEqual(
  normalizeEventName('not_talking_head_rejected', { proceeded: false }),
  'not_talking_head_blocked',
  'a precheck that actually stopped the upload is a block');

// ── 2. THE LOAD-BEARING CASE: an unknown must not be guessed into a bucket ──
// 180 of 1040 real events carry no `proceeded` prop (older client builds).
// Bucketing those as blocks would re-create the exact over-count this fixes.
for (const props of [{}, null, undefined, { proceeded: 'yes' }, { proceeded: 1 }, []]) {
  assert.strictEqual(
    normalizeEventName('not_talking_head_rejected', props),
    'not_talking_head_rejected',
    `absent/non-boolean proceeded must keep the legacy name, got props=${JSON.stringify(props)}`);
}

// ── 3. a future client sending the split names directly passes through ──────
for (const e of ['not_talking_head_warned', 'not_talking_head_blocked']) {
  assert.strictEqual(normalizeEventName(e, { proceeded: true }), e,
    'an already-split name must never be rewritten again');
}

// ── 4. every OTHER event name is untouched ──────────────────────────────────
// The 2026-08-02 audit over 20,000 events found no other name contradicting its
// payload; normalisation must stay surgical, not a general rewriter.
for (const e of ['too_short_rejected', 'too_long_rejected', 'no_audio_rejected',
                 'render_failed', 'render_completed', 'upload_completed',
                 'free_limit_hit', 'purchase_failed', 'session_started']) {
  assert.strictEqual(normalizeEventName(e, { proceeded: true }), e,
    `${e} must pass through unchanged`);
}

// ── 5. Rule-7 actor resolution ──────────────────────────────────────────────
assert.strictEqual(
  resolveUserId('1aa24c33-c6c7-4a18-93d6-df36fbc45cc9'),
  '1aa24c33-c6c7-4a18-93d6-df36fbc45cc9',
  'a UUID distinct_id IS the Supabase user id — populate user_id so blocks are cuttable by user');
assert.strictEqual(resolveUserId('1AA24C33-C6C7-4A18-93D6-DF36FBC45CC9'),
  '1AA24C33-C6C7-4A18-93D6-DF36FBC45CC9', 'case-insensitive');
for (const bad of [null, undefined, '', 'anon-device-123', 'not-a-uuid', '12345']) {
  assert.strictEqual(resolveUserId(bad), null,
    `anonymous / pre-signin actors must stay NULL, never invented (got ${bad})`);
}

console.log('[smoke] analytics normalize: ALL PASS (split derived from props; unknowns not guessed; Rule-7 actor resolved)');

'use strict';
// GATE: a churn read must never be able to call a billing failure a user
// cancellation, and must never silently drop the field that tells them apart.
//
// The defect this locks out (2026-08-28): we stored rc_type only. RevenueCat
// reports a deliberate unsubscribe and a failed payment BOTH as CANCELLATION,
// so "12 cancellations" was unsplittable — and the natural reading of it, that
// twelve people chose to leave, could have been wrong for any number of them.
// Recoverable churn would have been invisible inside a voluntary-churn number.

const assert = require('assert');
const { rcReasons, churnCause, isRecoverable } = require('./rc-webhook-reasons');

// ── 1. the discriminating field survives ingest ─────────────────────────────
const cancelBilling = { type: 'CANCELLATION', cancel_reason: 'BILLING_ERROR', grace_period_expiration_at_ms: 4102444800000 };
assert.strictEqual(rcReasons(cancelBilling).cancel_reason, 'BILLING_ERROR',
  'cancel_reason must be persisted — it is the ONLY field separating a failed payment from an unsubscribe');

// ── 2. and it is never fabricated when absent ───────────────────────────────
assert.strictEqual(rcReasons({ type: 'CANCELLATION' }).cancel_reason, null,
  'a missing reason must stay null; inventing one manufactures a cause we never observed');

// ── 3. the two CANCELLATIONs split ──────────────────────────────────────────
assert.strictEqual(churnCause(cancelBilling), 'billing');
assert.strictEqual(churnCause({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' }), 'user_cancel');
assert.notStrictEqual(churnCause(cancelBilling), churnCause({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' }),
  'the whole point: identical rc_type, opposite cause');

// ── 4. an unmeasured reason is NOT voluntary churn ──────────────────────────
assert.strictEqual(churnCause({ type: 'CANCELLATION' }), 'unknown_reason',
  'a cancellation with no captured reason is UNMEASURED — folding it into user_cancel is how a billing problem vanishes');

// ── 5. the other causes ─────────────────────────────────────────────────────
assert.strictEqual(churnCause({ type: 'REFUND' }), 'refund');
assert.strictEqual(churnCause({ type: 'BILLING_ISSUE' }), 'billing');
assert.strictEqual(churnCause({ type: 'EXPIRATION', expiration_reason: 'BILLING_ERROR' }), 'billing',
  'an expiration caused by a card failure is billing churn, not a user choice');
assert.strictEqual(churnCause({ type: 'EXPIRATION', expiration_reason: 'UNSUBSCRIBE' }), 'expired');
assert.strictEqual(churnCause({ type: 'RENEWAL' }), 'active');

// ── 6. recoverability is time-bounded, both directions ──────────────────────
const past = { type: 'BILLING_ISSUE', grace_period_expiration_at_ms: 1000 };
const future = { type: 'BILLING_ISSUE', grace_period_expiration_at_ms: 4102444800000 };
assert.strictEqual(isRecoverable(future, 1700000000000), true, 'inside the grace window it is winnable');
assert.strictEqual(isRecoverable(past, 1700000000000), false, 'past the grace window it is gone');
assert.strictEqual(isRecoverable({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', grace_period_expiration_at_ms: 4102444800000 }, 1700000000000), false,
  'a deliberate unsubscribe is not recoverable churn no matter what timestamps ride along');

// ── 6b. the identity chain survives, so an anonymous purchase is resolvable ──
// 32% of purchase webhooks arrive under $RCAnonymousID because the first-launch
// paywall sells before sign-in. Discarding original_app_user_id/aliases makes
// those rows permanently unjoinable, which silently under-reports the surface
// the conversion work is built around.
const { identityChain } = require('./rc-webhook-reasons');
const merged = { type: 'INITIAL_PURCHASE', app_user_id: 'auth-uuid',
                 original_app_user_id: '$RCAnonymousID:abc', aliases: ['$RCAnonymousID:abc', 'auth-uuid'] };
assert.strictEqual(rcReasons(merged).original_app_user_id, '$RCAnonymousID:abc',
  'original_app_user_id must be persisted — it is the anonymous id the purchase arrived under');
assert.deepStrictEqual(rcReasons(merged).aliases, ['$RCAnonymousID:abc', 'auth-uuid']);
assert.deepStrictEqual(identityChain(merged).sort(), ['$RCAnonymousID:abc', 'auth-uuid'].sort(),
  'the chain must contain BOTH ids — that pairing is what resolves the join');
assert.strictEqual(rcReasons({ type: 'RENEWAL' }).original_app_user_id, null,
  'absent identity fields stay null; never invented');
assert.deepStrictEqual(identityChain({ app_user_id: 'solo' }), ['solo'],
  'an unmerged event yields just its own id, not an empty chain');

// ── 7. the ingest shape actually spreads the reasons ────────────────────────
// Structural backstop: server.js must spread rcReasons into the stored props,
// or the fields above are computed and then thrown away.
const fs = require('fs'), path = require('path');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.ok(/rcReceived\(\{[\s\S]{0,400}?\.\.\.rcReasons\(event\)/.test(server),
  "server.js must spread ...rcReasons(event) into the rc_webhook_received props — otherwise the discriminating fields are never stored");

console.log('rc-webhook-reasons smoke: PASS — billing failure and user cancellation cannot be conflated, and an uncaptured reason stays UNMEASURED.');

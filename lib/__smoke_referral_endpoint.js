'use strict';
// GATE: the payout endpoint must not be talked into paying.
//
// The referral loop was CLAIM-ONLY until this endpoint existed — a referral
// could be entered and never qualify or pay. Wiring the payout is also wiring
// the thing an attacker most wants to reach, so the properties that make it
// safe are asserted structurally rather than left to review.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const i = server.indexOf("parsed.pathname === '/api/referral/reconcile'");
assert.ok(i > 0, 'the reconcile endpoint must exist — without it the loop is claim-only');
const block = server.slice(i, i + 6000);

// ── 1. the referrer comes from the TOKEN, never the body ────────────────────
assert.ok(/const referrerId = user\.id/.test(block),
  'referrerId must be derived from the authenticated user, never accepted from the request body');
assert.ok(!/body\.(referrer|referrer_id|referrerId)/.test(block),
  'the endpoint must never read a referrer id from the body — that is a self-grant');

// ── 2. qualification is a RENDER, not the flag ──────────────────────────────
assert.ok(/from\('video_jobs'\)/.test(block) && /eq\('status', 'completed'\)/.test(block),
  'qualification must be decided by a completed render read from video_jobs');
assert.ok(/referredWithRender/.test(block),
  'the render set must be passed to reconcile as the qualification input');

// ── 3. the cap is summed over the real ledger, in-window ────────────────────
assert.ok(/from\('referral_rewards'\)[\s\S]{0,200}?gte\('granted_at'/.test(block),
  'the cap must SUM days_granted over the rolling window from referral_rewards');

// ── 4. a failed grant still leaves a row ────────────────────────────────────
assert.ok(/provider_ok: false/.test(block),
  'the ledger row must be written BEFORE the entitlement, with provider_ok false');
assert.ok(/provider_ok: true/.test(block),
  'and flipped true only once the entitlement write succeeds');
const okFalseAt = block.indexOf('provider_ok: false');
const okTrueAt = block.indexOf('provider_ok: true');
assert.ok(okFalseAt < okTrueAt,
  'ledger-first ordering: absence and failure must not look identical');

// ── 5. paid referrals are marked counted, or they pay again ─────────────────
assert.ok(/counted_at: new Date\(\)\.toISOString\(\)/.test(block),
  'eligible referrals must be marked counted_at or the same referral pays repeatedly');

// ── 6. the suspicious case is recorded, not swallowed ───────────────────────
assert.ok(/qualified_without_render/.test(block),
  'a referral flagged qualified with no render must be recorded as a finding');

console.log('referral-endpoint smoke: PASS — referrer from token, payout gated on a real render, cap summed from the ledger, failures visible, no double-pay.');

'use strict';
// Wall enforcement decisions — the enforcement half of the truth table, proven.
//   node --test tests/wall-enforcement.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { shouldEnforceWall, resolveEnforce, clientFreemium, effectiveTier, gateDecision, uploadDecision } = require('../lib/wall-enforcement');

const FLIP = Date.parse('2026-08-01T00:00:00Z');
const beforeFlip = '2026-07-15T00:00:00Z';
const afterFlip = '2026-08-05T00:00:00Z';

// Header helpers — mimic what each client era sends.
const FREEMIUM_HEADERS = { 'x-promptly-freemium': '1', 'x-promptly-wall-capable': '1' }; // 1.3.0
const WALLCAPABLE_HEADERS = { 'x-promptly-wall-capable': '1' };                            // 1.2.0
const OLD_HEADERS = {};                                                                    // pre-1.2.0

// ── Rollout policy ─────────────────────────────────────────────────────────
test('rollout: master switch OFF → never enforce (spine is a no-op pre-flip)', () => {
  assert.strictEqual(shouldEnforceWall({ accountCreatedAt: afterFlip, clientWallCapable: true, enabled: false, flip: FLIP }), false);
});
test('rollout: enabled + account created after flip → enforce', () => {
  assert.strictEqual(shouldEnforceWall({ accountCreatedAt: afterFlip, clientWallCapable: false, enabled: true, flip: FLIP }), true);
});
test('rollout: enabled + wall-capable client → enforce (even a pre-flip account)', () => {
  assert.strictEqual(shouldEnforceWall({ accountCreatedAt: beforeFlip, clientWallCapable: true, enabled: true, flip: FLIP }), true);
});
test('rollout: enabled + pre-flip account + old binary → grandfathered (no enforce)', () => {
  assert.strictEqual(shouldEnforceWall({ accountCreatedAt: beforeFlip, clientWallCapable: false, enabled: true, flip: FLIP }), false);
});
test('rollout: no flip date configured + old client → not enforced (safe default)', () => {
  assert.strictEqual(shouldEnforceWall({ accountCreatedAt: afterFlip, clientWallCapable: false, enabled: true, flip: null }), false);
});

// ── resolveEnforce: the 1.3.0-vs-1.2.0 distinguisher (freemium unconditional) ─
// This is the safety-critical seam: a 1.3.0 client (freemium header) is ALWAYS
// enforced regardless of the knob; a 1.2.0 client (no freemium header) is only
// ever the legacy knob-gated wall — which stays off — so it is never walled.
test('clientFreemium: only the X-Promptly-Freemium:1 header trips it', () => {
  assert.strictEqual(clientFreemium(FREEMIUM_HEADERS), true);
  assert.strictEqual(clientFreemium(WALLCAPABLE_HEADERS), false); // 1.2.0 wall-capable is NOT freemium
  assert.strictEqual(clientFreemium(OLD_HEADERS), false);
  assert.strictEqual(clientFreemium(undefined), false);
});
test('resolveEnforce: 1.3.0 freemium client → ALWAYS enforce, knob OFF, any account age', () => {
  // Knob explicitly off + a pre-flip account + no flip date: every legacy term
  // is false, yet the freemium header forces enforcement. Knob is NOT consulted.
  assert.strictEqual(resolveEnforce({ headers: FREEMIUM_HEADERS, accountCreatedAt: beforeFlip, enabled: false, flip: null }), true);
  assert.strictEqual(resolveEnforce({ headers: FREEMIUM_HEADERS, accountCreatedAt: afterFlip, enabled: false, flip: FLIP }), true);
});
test('resolveEnforce: 1.2.0 client (wall-capable, NO freemium header) + knob OFF → NOT enforced', () => {
  // The live 1.2.0 build: knob off → never enforced → no trial wall activates.
  assert.strictEqual(resolveEnforce({ headers: WALLCAPABLE_HEADERS, accountCreatedAt: afterFlip, enabled: false, flip: FLIP }), false);
  assert.strictEqual(resolveEnforce({ headers: WALLCAPABLE_HEADERS, accountCreatedAt: beforeFlip, enabled: false, flip: FLIP }), false);
});
test('resolveEnforce: 1.2.0 path still honors the legacy knob when ON (unchanged semantics)', () => {
  // If the knob were ever flipped on, a 1.2.0 wall-capable client enforces —
  // exactly as before. resolveEnforce delegates to shouldEnforceWall verbatim.
  assert.strictEqual(resolveEnforce({ headers: WALLCAPABLE_HEADERS, accountCreatedAt: beforeFlip, enabled: true, flip: FLIP }), true);
  assert.strictEqual(resolveEnforce({ headers: OLD_HEADERS, accountCreatedAt: beforeFlip, enabled: true, flip: FLIP }), false); // old binary grandfathered
});
test('resolveEnforce: freemium 1.3.0 → free 1/day render cap, 402 paywall, NEVER a 403 wall', () => {
  const enforce = resolveEnforce({ headers: FREEMIUM_HEADERS, accountCreatedAt: beforeFlip, enabled: false, flip: null });
  assert.strictEqual(gateDecision({ tier: 'none', kind: 'render', todayCount: 0, enforce }).allow, true);   // 1st allowed
  assert.strictEqual(gateDecision({ tier: 'none', kind: 'render', todayCount: 1, enforce }).status, 402);   // 2nd → paywall
  assert.strictEqual(gateDecision({ tier: 'none', kind: 'render', todayCount: 1, enforce }).route, 'paywall'); // never 'wall'
});
test('resolveEnforce: comped/active pro on 1.3.0 → paid, unlimited (exempt under unconditional freemium)', () => {
  const enforce = resolveEnforce({ headers: FREEMIUM_HEADERS, accountCreatedAt: afterFlip, enabled: false, flip: null });
  assert.strictEqual(effectiveTier('paid', enforce), 'paid');
  assert.strictEqual(gateDecision({ tier: 'paid', kind: 'render', todayCount: 999, enforce }).allow, true);
  assert.strictEqual(uploadDecision({ tier: 'paid', count: 10, enforce }).allow, true);
});

// ── effectiveTier: knob-off (legacy) vs knob-on (FREEMIUM) ──────────────────
test('effectiveTier knob-off: none → trial (today\'s 3/day free); trial → paid', () => {
  assert.strictEqual(effectiveTier('none', false), 'trial');
  assert.strictEqual(effectiveTier('trial', false), 'paid'); // active trial was isPro==unlimited today
});
test('effectiveTier FREEMIUM (enforce): none → free (never the wall)', () => {
  assert.strictEqual(effectiveTier('none', true), 'free');
});
test('effectiveTier FREEMIUM: active trial → paid (grandfathered for its duration)', () => {
  assert.strictEqual(effectiveTier('trial', true), 'paid');
});
test('effectiveTier: paid always paid', () => {
  assert.strictEqual(effectiveTier('paid', false), 'paid');
  assert.strictEqual(effectiveTier('paid', true), 'paid');
});
test('knob-off keeps a straggler trial UNLIMITED — byte-for-byte today', () => {
  assert.strictEqual(gateDecision({ tier: 'trial', kind: 'render', todayCount: 99999, enforce: false }).allow, true);
  assert.strictEqual(gateDecision({ tier: 'trial', kind: 'chat', todayCount: 99999, enforce: false }).allow, true);
  assert.strictEqual(uploadDecision({ tier: 'trial', count: 10, enforce: false }).allow, true);
});

// ── The render gate ────────────────────────────────────────────────────────
test('FREEMIUM render: non-pro → free 1/day, upgrade paywall (402) at cap — NEVER a wall', () => {
  // effectiveTier('none', true) === 'free' → usable, 1/day.
  assert.strictEqual(gateDecision({ tier: 'none', kind: 'render', todayCount: 0, enforce: true }).allow, true);
  assert.deepStrictEqual(gateDecision({ tier: 'none', kind: 'render', todayCount: 1, enforce: true }),
    { allow: false, route: 'paywall', status: 402 });
  // The 403 wall is structurally unreachable for a non-pro user under freemium.
  assert.notStrictEqual(gateDecision({ tier: 'none', kind: 'render', todayCount: 99, enforce: true }).status, 403);
});
test('render knob-off (legacy): none → 3/day, paywall at cap', () => {
  assert.strictEqual(gateDecision({ tier: 'none', kind: 'render', todayCount: 2, enforce: false }).allow, true);
  assert.deepStrictEqual(gateDecision({ tier: 'none', kind: 'render', todayCount: 3, enforce: false }),
    { allow: false, route: 'paywall', status: 402 });
});
test('FREEMIUM render: grandfathered trial + paid never blocked', () => {
  assert.strictEqual(gateDecision({ tier: 'trial', kind: 'render', todayCount: 99999, enforce: true }).allow, true);
  assert.strictEqual(gateDecision({ tier: 'paid', kind: 'render', todayCount: 99999, enforce: true }).allow, true);
});

// ── The chat gate ──────────────────────────────────────────────────────────
// 2026-09-02: was asserting the cap at 50. FREE_DAILY_CHATS was deliberately
// cut 50 → 5 on 2026-07-24 and neither test file was updated, so this and its
// twin in tier-capabilities.test.js had both been red ever since. Pre-existing;
// found while adding the max row and fixed rather than left red.
test('FREEMIUM chat: free to 5 → paywall; trial + paid unlimited', () => {
  assert.strictEqual(gateDecision({ tier: 'none', kind: 'chat', todayCount: 4, enforce: true }).allow, true);
  assert.deepStrictEqual(gateDecision({ tier: 'none', kind: 'chat', todayCount: 5, enforce: true }),
    { allow: false, route: 'paywall', status: 402 });
  assert.strictEqual(gateDecision({ tier: 'trial', kind: 'chat', todayCount: 1e6, enforce: true }).allow, true);
  assert.strictEqual(gateDecision({ tier: 'paid', kind: 'chat', todayCount: 1e6, enforce: true }).allow, true);
});

// ── The upload gate ────────────────────────────────────────────────────────
test('FREEMIUM upload: free 1 → upgrade paywall (402) at 2, never a wall', () => {
  assert.strictEqual(uploadDecision({ tier: 'none', count: 1, enforce: true }).allow, true);
  assert.deepStrictEqual(uploadDecision({ tier: 'none', count: 2, enforce: true }),
    { allow: false, route: 'paywall', status: 402, max: 1 });
});
test('upload knob-off (legacy): none → 1', () => {
  assert.strictEqual(uploadDecision({ tier: 'none', count: 1, enforce: false }).allow, true);
  assert.strictEqual(uploadDecision({ tier: 'none', count: 2, enforce: false }).allow, false);
});
test('FREEMIUM upload: grandfathered trial + paid → 10', () => {
  assert.strictEqual(uploadDecision({ tier: 'trial', count: 10, enforce: true }).allow, true);
  assert.strictEqual(uploadDecision({ tier: 'paid', count: 10, enforce: true }).allow, true);
  assert.strictEqual(uploadDecision({ tier: 'paid', count: 11, enforce: true }).allow, false);
});

// ── MAX survives effectiveTier (2026-09-02) ────────────────────────────────
// The bug this locks down: under enforcement, 'max' fell to `return 'free'`, so
// a Max subscriber was resolved to the 1-render/day free tier while TIER_RANK
// ranked max:40 ABOVE pro:30. That is what "effectiveTier lies" meant.
test('effectiveTier: max survives enforcement (does NOT collapse to free)', () => {
  assert.strictEqual(effectiveTier('max', true), 'max');
  assert.notStrictEqual(effectiveTier('max', true), 'free');
});
test('effectiveTier: max survives with enforcement OFF too', () => {
  assert.strictEqual(effectiveTier('max', false), 'max');
});
test('effectiveTier: paid/trial still collapse to paid, free still free', () => {
  assert.strictEqual(effectiveTier('paid', true), 'paid');
  assert.strictEqual(effectiveTier('trial', true), 'paid');
  assert.strictEqual(effectiveTier('none', true), 'free');
});
// THE LOCKOUT GUARD. effectiveTier passing 'max' through is only safe because
// tier-capabilities has a max row; without it this resolves to the fail-closed
// default and every Max subscriber gets a 403 wall instead of the app.
test('effectiveTier(max) + gateDecision: allowed, never routed to the wall', () => {
  const d = gateDecision({ tier: 'max', kind: 'render', todayCount: 9999, enforce: true });
  assert.strictEqual(d.allow, true, 'max must not be capped');
  assert.notStrictEqual(d.route, 'wall', 'max must NEVER hit the wall');
  assert.strictEqual(d.status, 200);
});

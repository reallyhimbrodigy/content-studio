'use strict';
// Wall enforcement decisions — the enforcement half of the truth table, proven.
//   node --test tests/wall-enforcement.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { shouldEnforceWall, effectiveTier, gateDecision, uploadDecision } = require('../lib/wall-enforcement');

const FLIP = Date.parse('2026-08-01T00:00:00Z');
const beforeFlip = '2026-07-15T00:00:00Z';
const afterFlip = '2026-08-05T00:00:00Z';

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
test('FREEMIUM render: non-pro → free 2/day, upgrade paywall (402) at cap — NEVER a wall', () => {
  // effectiveTier('none', true) === 'free' → usable, 2/day.
  assert.strictEqual(gateDecision({ tier: 'none', kind: 'render', todayCount: 0, enforce: true }).allow, true);
  assert.strictEqual(gateDecision({ tier: 'none', kind: 'render', todayCount: 1, enforce: true }).allow, true);
  assert.deepStrictEqual(gateDecision({ tier: 'none', kind: 'render', todayCount: 2, enforce: true }),
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
test('FREEMIUM chat: free to 50 → paywall; trial + paid unlimited', () => {
  assert.strictEqual(gateDecision({ tier: 'none', kind: 'chat', todayCount: 49, enforce: true }).allow, true);
  assert.deepStrictEqual(gateDecision({ tier: 'none', kind: 'chat', todayCount: 50, enforce: true }),
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

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

// ── Grandfathering ─────────────────────────────────────────────────────────
test('effectiveTier: none + not enforcing → trial (today\'s capped free tier)', () => {
  assert.strictEqual(effectiveTier('none', false), 'trial');
});
test('effectiveTier: none + enforcing → none (the wall)', () => {
  assert.strictEqual(effectiveTier('none', true), 'none');
});
test('effectiveTier: trial/paid unchanged by enforce flag', () => {
  assert.strictEqual(effectiveTier('trial', true), 'trial');
  assert.strictEqual(effectiveTier('paid', false), 'paid');
});

// ── The render gate ────────────────────────────────────────────────────────
test('render: enforced none → DENY at 0 used, route wall, 403 (the wall holds)', () => {
  assert.deepStrictEqual(gateDecision({ tier: 'none', kind: 'render', todayCount: 0, enforce: true }),
    { allow: false, route: 'wall', status: 403 });
});
test('render: grandfathered none → capped free (3/day), route paywall at cap', () => {
  assert.strictEqual(gateDecision({ tier: 'none', kind: 'render', todayCount: 2, enforce: false }).allow, true);
  assert.deepStrictEqual(gateDecision({ tier: 'none', kind: 'render', todayCount: 3, enforce: false }),
    { allow: false, route: 'paywall', status: 402 });
});
test('render: trial allows 3, blocks 4th → paywall 402', () => {
  assert.strictEqual(gateDecision({ tier: 'trial', kind: 'render', todayCount: 2, enforce: true }).allow, true);
  assert.deepStrictEqual(gateDecision({ tier: 'trial', kind: 'render', todayCount: 3, enforce: true }),
    { allow: false, route: 'paywall', status: 402 });
});
test('render: paid never blocked', () => {
  assert.strictEqual(gateDecision({ tier: 'paid', kind: 'render', todayCount: 99999, enforce: true }).allow, true);
});

// ── The chat gate ──────────────────────────────────────────────────────────
test('chat: enforced none → wall 403; trial to 50; paid unlimited', () => {
  assert.strictEqual(gateDecision({ tier: 'none', kind: 'chat', todayCount: 0, enforce: true }).status, 403);
  assert.strictEqual(gateDecision({ tier: 'trial', kind: 'chat', todayCount: 49, enforce: true }).allow, true);
  assert.strictEqual(gateDecision({ tier: 'trial', kind: 'chat', todayCount: 50, enforce: true }).allow, false);
  assert.strictEqual(gateDecision({ tier: 'paid', kind: 'chat', todayCount: 1e6, enforce: true }).allow, true);
});

// ── The upload gate ────────────────────────────────────────────────────────
test('upload: enforced none → wall 403', () => {
  assert.deepStrictEqual(uploadDecision({ tier: 'none', count: 1, enforce: true }),
    { allow: false, route: 'wall', status: 403, max: 0 });
});
test('upload: grandfathered none → trial cap (1)', () => {
  assert.strictEqual(uploadDecision({ tier: 'none', count: 1, enforce: false }).allow, true);
  assert.strictEqual(uploadDecision({ tier: 'none', count: 2, enforce: false }).allow, false);
});
test('upload: trial 1, paid 10', () => {
  assert.strictEqual(uploadDecision({ tier: 'trial', count: 1, enforce: true }).allow, true);
  assert.strictEqual(uploadDecision({ tier: 'trial', count: 2, enforce: true }).allow, false);
  assert.strictEqual(uploadDecision({ tier: 'paid', count: 10, enforce: true }).allow, true);
  assert.strictEqual(uploadDecision({ tier: 'paid', count: 11, enforce: true }).allow, false);
});

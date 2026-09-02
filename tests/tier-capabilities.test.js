'use strict';
// The tier × capability truth table, every cell a test (Wall Correctness item 1).
//   node --test tests/tier-capabilities.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const {
  capabilities, appUsable, canReedit, canUseLumen, canRender, canChat, canUpload, denialRouting,
} = require('../lib/tier-capabilities');

// ── app usable (post-auth) — the wall itself ──────────────────────────────
test('appUsable: none=false (→wall), trial=true, paid=true', () => {
  assert.strictEqual(appUsable('none'), false);
  assert.strictEqual(appUsable('trial'), true);
  assert.strictEqual(appUsable('paid'), true);
});
test('appUsable: an unrecognized tier fails closed to false (no free tier leak)', () => {
  assert.strictEqual(appUsable(undefined), false);
  assert.strictEqual(appUsable('garbage'), false);
});

// ── upload cap ────────────────────────────────────────────────────────────
test('upload max: none=0, trial=1, paid=10', () => {
  assert.strictEqual(capabilities('none').uploadMax, 0);
  assert.strictEqual(capabilities('trial').uploadMax, 1);
  assert.strictEqual(capabilities('paid').uploadMax, 10);
});
test('canUpload: none blocks any count', () => {
  assert.strictEqual(canUpload('none', 1), false);
});
test('canUpload: trial allows exactly 1, blocks 2', () => {
  assert.strictEqual(canUpload('trial', 1), true);
  assert.strictEqual(canUpload('trial', 2), false);
});
test('canUpload: paid allows up to 10, blocks 11', () => {
  assert.strictEqual(canUpload('paid', 10), true);
  assert.strictEqual(canUpload('paid', 11), false);
});

// ── renders/day ───────────────────────────────────────────────────────────
test('render limit: none=0, trial=3, paid=∞', () => {
  assert.strictEqual(capabilities('none').renderLimit, 0);
  assert.strictEqual(capabilities('trial').renderLimit, 3);
  assert.strictEqual(capabilities('paid').renderLimit, Infinity);
});
test('canRender: none blocked even at 0 used (the wall, not a cap)', () => {
  assert.strictEqual(canRender('none', 0), false);
});
test('canRender: trial allows renders 1-3, blocks the 4th', () => {
  assert.strictEqual(canRender('trial', 0), true);
  assert.strictEqual(canRender('trial', 2), true);  // 3rd render
  assert.strictEqual(canRender('trial', 3), false); // 4th → paywall
});
test('canRender: paid never blocked', () => {
  assert.strictEqual(canRender('paid', 0), true);
  assert.strictEqual(canRender('paid', 9999), true);
});

// ── chats/day ─────────────────────────────────────────────────────────────
test('chat limit: none=0, trial=50, paid=∞', () => {
  assert.strictEqual(capabilities('none').chatLimit, 0);
  assert.strictEqual(capabilities('trial').chatLimit, 50);
  assert.strictEqual(capabilities('paid').chatLimit, Infinity);
});
test('canChat: none blocked; trial to 50 then blocked; paid unlimited', () => {
  assert.strictEqual(canChat('none', 0), false);
  assert.strictEqual(canChat('trial', 49), true);
  assert.strictEqual(canChat('trial', 50), false);
  assert.strictEqual(canChat('paid', 100000), true);
});

// ── re-edit (Pro only) ────────────────────────────────────────────────────
test('re-edit: none=false, trial=false, paid=true', () => {
  assert.strictEqual(canReedit('none'), false);
  assert.strictEqual(canReedit('trial'), false);
  assert.strictEqual(canReedit('paid'), true);
});

// ── Lumen (Pro only) ──────────────────────────────────────────────────────
test('lumen: none=false, trial=false, paid=true', () => {
  assert.strictEqual(canUseLumen('none'), false);
  assert.strictEqual(canUseLumen('trial'), false);
  assert.strictEqual(canUseLumen('paid'), true);
});

// ── limit-hit routing ─────────────────────────────────────────────────────
test('limit-hit routing: none→wall, trial→paywall, paid→none', () => {
  assert.strictEqual(denialRouting('none'), 'wall');
  assert.strictEqual(denialRouting('trial'), 'paywall');
  assert.strictEqual(denialRouting('paid'), null);
});

// ── FREEMIUM 'free' tier (2026-07-21 pivot) ─────────────────────────────────
test("capabilities('free'): usable, 1 render/day, 1 upload, 5 chats, no reedit/lumen, paywall route", () => {
  const c = capabilities('free');
  assert.strictEqual(c.appUsable, true);
  assert.strictEqual(c.renderLimit, 1); // 2026-07-23: tightened 2 → 1/day (conversion)
  assert.strictEqual(c.uploadMax, 1);
  // 2026-09-02: was asserting 50. FREE_DAILY_CHATS was deliberately cut 50 → 5
  // on 2026-07-24 ("0 free users sent >5 chats/day in the prior 14 days") and
  // this assertion was never updated — so this file's own law, "a cell without
  // a green test does not exist", had been broken for that cell ever since.
  // Pre-existing failure, found while adding the max row; fixed here rather
  // than left red, because a suite with a known-red test cannot police a new one.
  assert.strictEqual(c.chatLimit, 5);
  assert.strictEqual(c.reedit, false);
  assert.strictEqual(c.lumen, false);
  assert.strictEqual(c.limitHitRouting, 'paywall'); // upgrade, never a wall
});
test("canRender: free allows the 1st/day then blocks the 2nd", () => {
  assert.strictEqual(canRender('free', 0), true);  // 1st render
  assert.strictEqual(canRender('free', 1), false); // 2nd → paywall
});
test("free tier is USABLE — appUsable true (freemium is never a wall)", () => {
  assert.strictEqual(appUsable('free'), true);
  assert.strictEqual(canReedit('free'), false);
  assert.strictEqual(canUseLumen('free'), false);
  assert.strictEqual(canUpload('free', 1), true);
  assert.strictEqual(canUpload('free', 2), false);
});

// ── MAX (2026-09-02) ───────────────────────────────────────────────────────
// A row without a green test does not exist (this file's standing law). Max's
// cells are identical to `paid` TODAY — each is asserted on its own so a future
// Max-only divergence breaks exactly the cell it changes, not a shared alias.
test('MAX: appUsable=true', () => {
  assert.strictEqual(appUsable('max'), true);
});
test('MAX: upload max = 10 (same as paid today)', () => {
  assert.strictEqual(capabilities('max').uploadMax, 10);
});
test('MAX: renders/day unlimited', () => {
  assert.strictEqual(capabilities('max').renderLimit, Infinity);
  assert.strictEqual(canRender('max', 9999), true);
});
test('MAX: chats/day unlimited', () => {
  assert.strictEqual(capabilities('max').chatLimit, Infinity);
  assert.strictEqual(canChat('max', 9999), true);
});
test('MAX: re-edit allowed', () => {
  assert.strictEqual(canReedit('max'), true);
});
test('MAX: lumen allowed', () => {
  assert.strictEqual(canUseLumen('max'), true);
});
test('MAX: never routes to a limit screen', () => {
  assert.strictEqual(denialRouting('max'), null);
});
test('MAX: canUpload allows 10, blocks 11 and 0', () => {
  assert.strictEqual(canUpload('max', 10), true);
  assert.strictEqual(canUpload('max', 11), false);
  assert.strictEqual(canUpload('max', 0), false);
});
// THE REGRESSION THIS ROW EXISTS TO PREVENT. Before the row, capabilities('max')
// fell through to the fail-closed default — appUsable:false — so a Max
// subscriber got a 403 WALL, not a paywall. If the row is ever deleted this is
// the test that fails, and it fails loudly rather than as a subtle downgrade.
test('MAX: is NOT the fail-closed default row (the lockout regression)', () => {
  const max = capabilities('max');
  const unknown = capabilities('garbage');
  assert.notDeepStrictEqual(max, unknown);
  assert.strictEqual(unknown.appUsable, false, 'unknown must still fail closed');
  assert.strictEqual(max.appUsable, true, 'max must NOT fail closed');
});
// Max is its own row, not an alias of paid — identical cells today, but they
// must be independently addressable or a Max-only change cannot land.
test('MAX: cells match paid today, as separate rows', () => {
  assert.deepStrictEqual(capabilities('max'), capabilities('paid'));
});

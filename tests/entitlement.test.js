'use strict';

// Run with:  node --test tests/entitlement.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { isUserPro, proEntitlementFromV2ActiveList } = require('../lib/entitlement');

const NOW = Date.UTC(2026, 5, 18); // 2026-06-18, fixed so tests are deterministic
const futureMs = NOW + 30 * 864e5; // +30 days, epoch ms (RC v2 format)
const pastMs = NOW - 864e5; // -1 day
const PRO_ID = 'entl_pro_internal';

// RC v2 active_entitlements item shape.
const item = (entitlement_id, expires_at) => ({
  object: 'customer.active_entitlement',
  entitlement_id,
  expires_at,
});

test('active pro entitlement (future expiry) grants pro', () => {
  const r = proEntitlementFromV2ActiveList([item(PRO_ID, futureMs)], PRO_ID, NOW);
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.proUntil, new Date(futureMs).toISOString());
});

test('non-expiring entitlement (expires_at null) is active with null proUntil', () => {
  const r = proEntitlementFromV2ActiveList([item(PRO_ID, null)], PRO_ID, NOW);
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.proUntil, null);
});

test('expired match is not active (consistent with BILLING_ISSUE=revoke)', () => {
  const r = proEntitlementFromV2ActiveList([item(PRO_ID, pastMs)], PRO_ID, NOW);
  assert.deepStrictEqual(r, { active: false, proUntil: null });
});

test('a different entitlement id does not grant pro', () => {
  const r = proEntitlementFromV2ActiveList([item('entl_other', futureMs)], PRO_ID, NOW);
  assert.strictEqual(r.active, false);
});

test('null target id = accept any active entitlement (single-entitlement fallback)', () => {
  const r = proEntitlementFromV2ActiveList([item('entl_whatever', futureMs)], null, NOW);
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.proUntil, new Date(futureMs).toISOString());
});

test('multiple matches pick the furthest-out expiry', () => {
  const later = futureMs + 90 * 864e5;
  const r = proEntitlementFromV2ActiveList(
    [item(PRO_ID, futureMs), item(PRO_ID, later)],
    PRO_ID,
    NOW
  );
  assert.strictEqual(r.proUntil, new Date(later).toISOString());
});

test('non-expiring wins over a dated expiry', () => {
  const r = proEntitlementFromV2ActiveList(
    [item(PRO_ID, futureMs), item(PRO_ID, null)],
    PRO_ID,
    NOW
  );
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.proUntil, null);
});

test('empty / garbage lists are not active', () => {
  assert.strictEqual(proEntitlementFromV2ActiveList([], PRO_ID, NOW).active, false);
  assert.strictEqual(proEntitlementFromV2ActiveList(null, PRO_ID, NOW).active, false);
  assert.strictEqual(proEntitlementFromV2ActiveList([{}], PRO_ID, NOW).active, false);
});

// Guards the contract the reconciliation write depends on: an active RC
// entitlement maps to a profiles row that isUserPro() then accepts.
test('reconciliation write shape satisfies isUserPro()', () => {
  const r = proEntitlementFromV2ActiveList([item(PRO_ID, futureMs)], PRO_ID, NOW);
  assert.strictEqual(r.active, true);
  const profileRowAfterWrite = {
    tier: 'pro',
    pro_until: r.proUntil,
    rc_app_user_id: 'some-supabase-uuid',
  };
  assert.strictEqual(isUserPro(profileRowAfterWrite), true);
});

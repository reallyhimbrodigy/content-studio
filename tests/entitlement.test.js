'use strict';

// Run with:  node --test tests/entitlement.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { isUserPro, entitlementTier, tierFromEntitlement, unknownPeriodPaid, proEntitlementFromV2ActiveList, revenuecatWebhookAuthMatches,
        tierRank, tierAfterGrant, tieredEntitlementFromV2ActiveList, ENTITLEMENT_TIER_BY_LOOKUP_KEY } = require('../lib/entitlement');

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

// --- revenuecatWebhookAuthMatches: tolerate the dashboard's Bearer/bare forms ---
// This is the exact bug that 401'd every production webhook: the dashboard sent
// one form, the server expected the other.

test('webhook auth: bare header matches bare secret', () => {
  assert.strictEqual(revenuecatWebhookAuthMatches('s3cr3t', 's3cr3t'), true);
});

test('webhook auth: "Bearer <secret>" header matches bare secret', () => {
  assert.strictEqual(revenuecatWebhookAuthMatches('Bearer s3cr3t', 's3cr3t'), true);
});

test('webhook auth: bare header matches "Bearer <secret>" configured', () => {
  assert.strictEqual(revenuecatWebhookAuthMatches('s3cr3t', 'Bearer s3cr3t'), true);
});

test('webhook auth: Bearer on both sides matches', () => {
  assert.strictEqual(revenuecatWebhookAuthMatches('Bearer s3cr3t', 'Bearer s3cr3t'), true);
});

test('webhook auth: case-insensitive prefix + stray whitespace tolerated', () => {
  assert.strictEqual(revenuecatWebhookAuthMatches('  bearer   s3cr3t  ', '  s3cr3t '), true);
});

test('webhook auth: wrong secret is rejected', () => {
  assert.strictEqual(revenuecatWebhookAuthMatches('Bearer nope', 's3cr3t'), false);
});

test('webhook auth: empty configured secret fails closed', () => {
  assert.strictEqual(revenuecatWebhookAuthMatches('Bearer s3cr3t', ''), false);
  assert.strictEqual(revenuecatWebhookAuthMatches('Bearer s3cr3t', '   '), false);
  assert.strictEqual(revenuecatWebhookAuthMatches('Bearer s3cr3t', 'Bearer   '), false);
});

test('webhook auth: missing/empty header is rejected', () => {
  assert.strictEqual(revenuecatWebhookAuthMatches('', 's3cr3t'), false);
  assert.strictEqual(revenuecatWebhookAuthMatches(undefined, 's3cr3t'), false);
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
  assert.strictEqual(isUserPro(profileRowAfterWrite, NOW), true);
});

// --- isUserPro: core profile cases (RevenueCat + admin comp) ---

const future = new Date(NOW + 30 * 864e5).toISOString();
const past = new Date(NOW - 864e5).toISOString();

test('tier=pro with future pro_until is pro', () => {
  // Pass the frozen NOW so the test doesn't drift once wall-clock time passes
  // the fixture's +30d date (isUserPro compares pro_until against `now`).
  assert.strictEqual(isUserPro({ tier: 'pro', pro_until: future }, NOW), true);
});

test('tier=pro with expired pro_until is NOT pro', () => {
  assert.strictEqual(isUserPro({ tier: 'pro', pro_until: past }, NOW), false);
});

test('tier=pro with rc_app_user_id (webhook just landed) is pro', () => {
  assert.strictEqual(isUserPro({ tier: 'pro', rc_app_user_id: 'uuid' }), true);
});

test('free tier is not pro', () => {
  assert.strictEqual(isUserPro({ tier: 'free' }), false);
});

// The fail-closed guard against the removed self-promote bypass: a bare
// tier=pro (no pro_until, no rc_app_user_id, no comp) must NOT grant pro.
test('bare tier=pro with no pro_until/rc_app_user_id/comp is NOT pro (fail-closed)', () => {
  assert.strictEqual(isUserPro({ tier: 'pro' }), false);
});

test('tier=pro with comp_pro=false stays fail-closed', () => {
  assert.strictEqual(isUserPro({ tier: 'pro', comp_pro: false }), false);
});

// Admin comp: comp_pro=true is an explicit, service-role-only signal (RLS
// blocks clients from writing it), so it grants pro on its own.
test('comp_pro=true grants pro (standalone admin comp)', () => {
  assert.strictEqual(isUserPro({ comp_pro: true }), true);
});

test('comp_pro=true grants pro even alongside tier=pro and no dates', () => {
  assert.strictEqual(isUserPro({ tier: 'pro', comp_pro: true }), true);
});

test('comp_pro=true grants pro even if tier still says free', () => {
  assert.strictEqual(isUserPro({ tier: 'free', comp_pro: true }), true);
});

test('comp_pro truthy-but-not-true (e.g. string) does NOT grant pro', () => {
  // Strict boolean only — avoids a stray truthy DB value silently comping.
  assert.strictEqual(isUserPro({ comp_pro: 'yes' }), false);
});

// --- entitlementTier: three-way none/trial/paid (trial-wall model, N+1) ---

test('entitlementTier: no active entitlement → none (the wall)', () => {
  assert.strictEqual(entitlementTier({ tier: 'free' }, NOW), 'none');
  assert.strictEqual(entitlementTier(null, NOW), 'none');
});

test('entitlementTier: active free trial → trial (limited tier)', () => {
  assert.strictEqual(
    entitlementTier({ tier: 'pro', pro_until: future, rc_app_user_id: 'u', rc_period_type: 'trial' }, NOW),
    'trial'
  );
});

test('entitlementTier: active normal subscription → paid (full Pro)', () => {
  assert.strictEqual(
    entitlementTier({ tier: 'pro', pro_until: future, rc_app_user_id: 'u', rc_period_type: 'normal' }, NOW),
    'paid'
  );
});

test('entitlementTier: paid introductory offer (intro) → paid, not trial', () => {
  assert.strictEqual(
    entitlementTier({ tier: 'pro', pro_until: future, rc_app_user_id: 'u', rc_period_type: 'intro' }, NOW),
    'paid'
  );
});

test('entitlementTier: comp is paid even if rc_period_type=trial (comps get full Pro)', () => {
  assert.strictEqual(entitlementTier({ comp_pro: true, rc_period_type: 'trial' }, NOW), 'paid');
});

test('entitlementTier: legacy pro with no rc_period_type → paid (never down-tiered)', () => {
  assert.strictEqual(
    entitlementTier({ tier: 'pro', pro_until: future, rc_app_user_id: 'u' }, NOW),
    'paid'
  );
});

test('entitlementTier: expired/lapsed trial → none (fail-closed, back to the wall)', () => {
  assert.strictEqual(
    entitlementTier({ tier: 'free', pro_until: past, rc_period_type: 'trial' }, NOW),
    'none'
  );
});

// --- unknownPeriodPaid: the ratified edge counter (cron-fixable population) ---

test('unknownPeriodPaid: RC-linked active pro with NO period → true (the edge)', () => {
  assert.strictEqual(unknownPeriodPaid({ tier: 'pro', pro_until: future, rc_app_user_id: 'u' }, NOW), true);
});

test('unknownPeriodPaid: RC-linked active pro WITH a period → false', () => {
  assert.strictEqual(unknownPeriodPaid({ tier: 'pro', pro_until: future, rc_app_user_id: 'u', rc_period_type: 'normal' }, NOW), false);
});

test('unknownPeriodPaid: active free trial → false (it is trial, not paid)', () => {
  assert.strictEqual(unknownPeriodPaid({ tier: 'pro', pro_until: future, rc_app_user_id: 'u', rc_period_type: 'trial' }, NOW), false);
});

test('unknownPeriodPaid: comp → false (intentional paid, excluded)', () => {
  assert.strictEqual(unknownPeriodPaid({ comp_pro: true }, NOW), false);
});

test('unknownPeriodPaid: legacy non-RC hand-promote → false (no rc_app_user_id)', () => {
  assert.strictEqual(unknownPeriodPaid({ tier: 'pro', pro_until: future }, NOW), false);
});

test('unknownPeriodPaid: not entitled → false', () => {
  assert.strictEqual(unknownPeriodPaid({ tier: 'free' }, NOW), false);
});

// ── tierFromEntitlement: tier from the DECISION, not a bare row ──────────────
// The wiring regression this guards: gates fed `entitlement.row || {}` computed
// tier 'none' for EVERYONE when the decision carried no row — knob-off mapped
// Pro users to 'trial' (3/day + 1 concurrent). isPro must win over a missing or
// stale row; a real active trial must NOT be masked up to paid.

test('tierFromEntitlement: isPro decision with NO row → paid (the live-bug cell)', () => {
  assert.strictEqual(tierFromEntitlement({ isPro: true, reason: 'RC_SELF_HEAL' }, NOW), 'paid');
});

test('tierFromEntitlement: isPro with stale/empty row → paid (isPro wins)', () => {
  assert.strictEqual(tierFromEntitlement({ isPro: true, row: {} }, NOW), 'paid');
});

test('tierFromEntitlement: isPro with active TRIAL row stays trial (guard must not mask)', () => {
  assert.strictEqual(
    tierFromEntitlement({ isPro: true, row: { tier: 'pro', pro_until: future, rc_period_type: 'trial', rc_app_user_id: 'u' } }, NOW),
    'trial');
});

test('tierFromEntitlement: not pro, no row → none', () => {
  assert.strictEqual(tierFromEntitlement({ isPro: false, row: null }, NOW), 'none');
});

test('tierFromEntitlement: comp row → paid', () => {
  assert.strictEqual(tierFromEntitlement({ isPro: true, row: { comp_pro: true } }, NOW), 'paid');
});

test('tierFromEntitlement: undefined decision → none (fails closed)', () => {
  assert.strictEqual(tierFromEntitlement(undefined, NOW), 'none');
});

// ── MAX is a PAID tier (2026-09-02) ────────────────────────────────────────
// isUserPro returned FALSE for tier 'max' while TIER_RANK already ranked
// max:40 above pro:30 — the codebase called Max the top tier and simultaneously
// did not consider it paid. Downstream that meant /api/credits/balance derived
// the allowance from isPro and reported 30 instead of 1000.
{
  const future = new Date(Date.now() + 30 * 864e5).toISOString();
  test('isUserPro: max with a future pro_until is PRO', () => {
    assert.strictEqual(isUserPro({ tier: 'max', pro_until: future, rc_app_user_id: 'rc_x' }), true);
  });
  test('isUserPro: max is pro alongside pro/teams/premium', () => {
    for (const tier of ['pro', 'teams', 'premium', 'max']) {
      assert.strictEqual(
        isUserPro({ tier, pro_until: future, rc_app_user_id: 'rc_x' }), true, `${tier} must be pro`);
    }
  });
  test('isUserPro: max still EXPIRES — pro_until is honoured, not bypassed', () => {
    const past = new Date(Date.now() - 864e5).toISOString();
    assert.strictEqual(isUserPro({ tier: 'max', pro_until: past, rc_app_user_id: 'rc_x' }), false);
  });
  test('isUserPro: free/garbage still NOT pro (no leak from the new branch)', () => {
    assert.strictEqual(isUserPro({ tier: 'free', pro_until: future }), false);
    assert.strictEqual(isUserPro({ tier: 'garbage', pro_until: future }), false);
  });
  test('TIER_RANK: max outranks pro, and a pro grant cannot lower max', () => {
    assert.ok(tierRank('max') > tierRank('pro'));
    assert.strictEqual(tierAfterGrant('max', 'pro'), 'max');
  });
}

// ── TIERED ENTITLEMENT RESOLUTION (2026-09-02) ─────────────────────────────
// THE BUG: RC carries a `max` entitlement with the Max products attached, and
// resolution keyed on the single 'pro' entitlement id. A customer holding ONLY
// `max` matched nothing -> active:false -> a completed purchase granted NOTHING.
{
  const NOW = Date.now();
  const soon = NOW + 30 * 864e5;
  const later = NOW + 60 * 864e5;
  const past = NOW - 864e5;
  const MAXID = 'entl_max'; const PROID = 'entl_pro';
  const MAP = { [MAXID]: 'max', [PROID]: 'pro' };
  const it = (id, exp) => ({ entitlement_id: id, expires_at: exp });
  const T = tieredEntitlementFromV2ActiveList;

  test('tiered: max entitlement ONLY is ACTIVE and resolves max (the bug)', () => {
    const r = T([it(MAXID, soon)], MAP, NOW);
    assert.strictEqual(r.active, true);
    assert.strictEqual(r.tier, 'max');
  });
  test('tiered: max + pro both attached (the interim guard) -> max wins', () => {
    assert.strictEqual(T([it(MAXID, soon), it(PROID, soon)], MAP, NOW).tier, 'max');
    assert.strictEqual(T([it(PROID, soon), it(MAXID, soon)], MAP, NOW).tier, 'max',
      'order of the active list must not change the answer');
  });
  test('tiered: tier and expiry describe the SAME entitlement', () => {
    // max 30d, pro 60d. Reporting max with pro's later expiry would grant Max
    // access past the Max subscription.
    const r = T([it(MAXID, soon), it(PROID, later)], MAP, NOW);
    assert.strictEqual(r.tier, 'max');
    assert.strictEqual(r.proUntil, new Date(soon).toISOString());
  });
  test('tiered: an EXPIRED max falls back to the active pro', () => {
    const r = T([it(MAXID, past), it(PROID, later)], MAP, NOW);
    assert.strictEqual(r.tier, 'pro');
    assert.strictEqual(r.proUntil, new Date(later).toISOString());
  });
  test('tiered: pro-only is unchanged (no regression to the Pro path)', () => {
    const r = T([it(PROID, soon)], MAP, NOW);
    assert.strictEqual(r.active, true);
    assert.strictEqual(r.tier, 'pro');
  });
  test('tiered: all expired / empty / unmapped -> inactive, tier null', () => {
    assert.strictEqual(T([it(MAXID, past), it(PROID, past)], MAP, NOW).active, false);
    assert.strictEqual(T([], MAP, NOW).active, false);
    assert.strictEqual(T(null, MAP, NOW).active, false);
    const un = T([it('entl_unknown', soon)], MAP, NOW);
    assert.strictEqual(un.active, false, 'an unmapped entitlement must not grant');
    assert.strictEqual(un.tier, null);
  });
  test('tiered: no map (lookup failed) keeps accept-any-active, and calls it PRO', () => {
    const r = T([it('entl_whatever', soon)], null, NOW);
    assert.strictEqual(r.active, true);
    assert.strictEqual(r.tier, 'pro', 'an unidentified entitlement must never be promoted to max');
  });
  test('tiered: non-expiring max beats a dated one and reports null proUntil', () => {
    const r = T([it(MAXID, soon), it(MAXID, null)], MAP, NOW);
    assert.strictEqual(r.tier, 'max');
    assert.strictEqual(r.proUntil, null);
  });
  test('ENTITLEMENT_TIER_BY_LOOKUP_KEY maps to tiers TIER_RANK actually knows', () => {
    for (const [key, tier] of Object.entries(ENTITLEMENT_TIER_BY_LOOKUP_KEY)) {
      assert.ok(tierRank(tier) > 0, `lookup_key '${key}' -> '${tier}' must be a ranked tier`);
    }
    assert.strictEqual(ENTITLEMENT_TIER_BY_LOOKUP_KEY.max, 'max');
    assert.strictEqual(ENTITLEMENT_TIER_BY_LOOKUP_KEY.pro, 'pro');
  });
}

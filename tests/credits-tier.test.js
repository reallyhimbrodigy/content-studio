'use strict';
// The credit tier and the grant script's enumeration predicate.
//   node --test tests/credits-tier.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { creditTierFor, TIER_ALLOWANCE } = require('../lib/credits');
const { isUserPro } = require('../lib/entitlement');

const FUTURE = '2030-01-01T00:00:00Z';
const PAST = '2020-01-01T00:00:00Z';

// ── creditTierFor ──────────────────────────────────────────────────────────
test('creditTierFor: an ordinary Pro subscriber is pro', () => {
  assert.strictEqual(
    creditTierFor({ tier: 'pro', pro_until: FUTURE, rc_app_user_id: 'rc_1' }), 'pro');
});
test('creditTierFor: a Max subscriber is max', () => {
  assert.strictEqual(
    creditTierFor({ tier: 'max', pro_until: FUTURE, rc_app_user_id: 'rc_1' }), 'max');
});
test('creditTierFor: an expired subscription is free', () => {
  assert.strictEqual(
    creditTierFor({ tier: 'pro', pro_until: PAST, rc_app_user_id: 'rc_1' }), 'free');
});
test('creditTierFor: a plain free row is free', () => {
  assert.strictEqual(creditTierFor({ tier: 'free' }), 'free');
  assert.strictEqual(creditTierFor(null), 'free');
});

// THE COHORT A pro_until QUERY MISSES. comp_pro short-circuits isUserPro before
// it reads tier or pro_until, so this row is fully paid everywhere in the
// server while having tier='free' and no expiry at all. Five such rows exist in
// production with 37 renders between them. They also cannot be reached by the
// free monthly roll (it skips paid tiers) and have no subscription to renew, so
// missing them here means they sit at zero permanently once the debit arms.
test('creditTierFor: a COMPED row with tier=free and NO pro_until is pro', () => {
  const comped = { tier: 'free', comp_pro: true, pro_until: null, rc_app_user_id: null };
  assert.strictEqual(isUserPro(comped), true, 'precondition: the server calls this paid');
  assert.strictEqual(creditTierFor(comped), 'pro');
  assert.strictEqual(TIER_ALLOWANCE[creditTierFor(comped)], 200);
});
test('creditTierFor: comp_pro is strict — a truthy value does not comp', () => {
  assert.strictEqual(creditTierFor({ tier: 'free', comp_pro: 1 }), 'free');
  assert.strictEqual(creditTierFor({ tier: 'free', comp_pro: 'yes' }), 'free');
});

// The allowance the script deposits must be the one the balance endpoint
// reports, or a user is told 1000 while holding 200.
test('every tier creditTierFor can return has an allowance', () => {
  for (const t of ['free', 'pro', 'max']) {
    assert.ok(Number.isInteger(TIER_ALLOWANCE[t]), `no allowance for '${t}'`);
  }
});

// ── THE COMP EXEMPTION (leg a only) ────────────────────────────────────────
const { isCompAccount } = require('../lib/entitlement');

test('isCompAccount: an admin comp is exempt', () => {
  assert.strictEqual(isCompAccount({ tier: 'free', comp_pro: true }), true);
  assert.strictEqual(isCompAccount({ tier: 'pro', comp_pro: true, pro_until: FUTURE }), true);
});
test('isCompAccount: strict === true — a truthy value does not exempt', () => {
  for (const v of [1, 'yes', 'true', {}])
    assert.strictEqual(isCompAccount({ comp_pro: v }), false, `comp_pro=${JSON.stringify(v)}`);
});
test('isCompAccount: null / missing row is not exempt', () => {
  assert.strictEqual(isCompAccount(null), false);
  assert.strictEqual(isCompAccount(undefined), false);
  assert.strictEqual(isCompAccount({}), false);
});

// THE ONE THAT MATTERS. `pro_until` and `rc_app_user_id` are client-writable:
// UPDATE is granted to `authenticated` at TABLE level and the RLS policy is
// `auth.uid() = id` with no column restriction, while only `comp_pro` carries a
// guard trigger. So a user who sets their own pro_until must STILL be debited —
// otherwise the bypass is self-serve unlimited free renders.
test('SECURITY: a self-set pro_until does NOT exempt — it is client-writable', () => {
  const selfPromoted = {
    tier: 'pro', comp_pro: false, pro_until: '2099-12-31T00:00:00Z', rc_app_user_id: null,
  };
  assert.strictEqual(isUserPro(selfPromoted), true, 'precondition: this row reads as paid');
  assert.strictEqual(isCompAccount(selfPromoted), false,
    'a row a user can write for themselves must never skip the debit');
});
test('SECURITY: an ordinary paying subscriber is not exempt either', () => {
  assert.strictEqual(
    isCompAccount({ tier: 'pro', comp_pro: false, pro_until: FUTURE, rc_app_user_id: 'rc_1' }),
    false);
});

// ── THE ENUMERATION SUPERSET ───────────────────────────────────────────────
// scripts/grant-credits.js pre-filters in SQL, then decides with isUserPro. The
// filter is only safe if it can never EXCLUDE a row isUserPro would accept —
// an under-selection is a paying user silently omitted from the grant, with a
// run that still prints success. This proves the property instead of trusting
// the two expressions to look similar.
const TIER_PATTERNS = ['pro', 'teams', 'premium', 'max'];
const prefilterMatches = (row) => (
  row.comp_pro === true
  || TIER_PATTERNS.some((t) => String(row.tier ?? '').toLowerCase().includes(t))
);

test('SUPERSET: nothing isUserPro accepts is excluded by the SQL prefilter', () => {
  const tiers = [
    // the accepted set, and the case/whitespace variants a case-sensitive
    // `tier.in.(...)` would have dropped while isUserPro accepted them
    'pro', 'Pro', 'PRO', ' pro ', '\tpro\n', 'teams', 'Teams', 'premium', 'PREMIUM',
    'max', 'Max', ' max',
    // and things that must not be paid at all
    'free', 'Free', '', '   ', null, undefined, 'proo', 'nonsense',
  ];
  const flags = [true, false, undefined, null, 1, 'yes'];
  const untils = [FUTURE, PAST, null, 'not-a-date'];
  const rcIds = ['rc_1', null];

  let accepted = 0;
  for (const tier of tiers) {
    for (const comp_pro of flags) {
      for (const pro_until of untils) {
        for (const rc_app_user_id of rcIds) {
          const row = { tier, comp_pro, pro_until, rc_app_user_id };
          if (!isUserPro(row)) continue;
          accepted++;
          assert.ok(prefilterMatches(row),
            `isUserPro accepts ${JSON.stringify(row)} but the SQL prefilter `
            + 'excludes it — this is a paying user dropped from the grant');
        }
      }
    }
  }
  // Guard the guard: a predicate that accepted nothing would pass the loop
  // above vacuously. This is the shape that has produced four false zeros.
  assert.ok(accepted > 20,
    `only ${accepted} rows were accepted — the sweep is not exercising isUserPro`);
});

test('SUPERSET: the prefilter is allowed to over-select (isUserPro rejects)', () => {
  // 'nonpro' contains 'pro', so the substring filter selects it. That is fine
  // and is the direction the design tolerates — the JS predicate is the decider.
  const row = { tier: 'nonpro', comp_pro: false, pro_until: FUTURE };
  assert.strictEqual(prefilterMatches(row), true);
  assert.strictEqual(isUserPro(row), false);
});

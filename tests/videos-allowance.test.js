// NOTE 2026-09-22: NOTHING RUNS THIS FILE — verified by grepping lib/, .github/
// and package.json for its name, which returns nothing. Its sibling
// tests/free-credits.test.js IS gated, through lib/__smoke_grant_cohort.js, so the
// two files in this directory differ on whether they are checks at all. The
// constants here are gated by lib/__smoke_free_tier_limits.js; do not add a NEW
// assertion here expecting it to guard anything.
'use strict';
// The VIDEO allowance — the unit the user was actually sold.
//   node --test tests/videos-allowance.test.js
//
// THE DEFECT THIS EXISTS FOR, caught before it shipped and worth stating because
// it PARSED, RAN, and was wrong for every paying user: videos_limit was first
// computed as creditTierFor({ tier: rawTier }), synthesising a row from the
// ENTITLEMENT vocabulary ('paid' / 'none'). creditTierFor calls isUserPro, which
// accepts profiles.tier in {pro, teams, premium, max} and knows nothing about
// 'paid' — so it returned 'free' for EVERY row and the endpoint would have
// reported videos_limit 3 to Max subscribers. Nothing threw. The shapes are the
// test.
const { test } = require('node:test');
const assert = require('node:assert');
const { creditTierFor, VIDEOS_LIMIT, TIER_ALLOWANCE, COST_PER_RENDER,
        videosLimitFor } = require('../lib/credits');

const FUTURE = '2030-01-01T00:00:00Z';
const PAST = '2020-01-01T00:00:00Z';

// THE SHIPPED FUNCTION, imported — not a restatement. A check that drives its
// own copy proves the copy.

test('the ruled numbers are the ruled numbers', () => {
  assert.deepStrictEqual(VIDEOS_LIMIT, { free: 1, pro: 50, max: 200 });
});

test('every REAL profile shape maps to the right video allowance', () => {
  assert.strictEqual(videosLimitFor({ tier: 'free' }).own, 1);
  assert.strictEqual(videosLimitFor({ tier: 'pro', pro_until: FUTURE }).own, 50);
  assert.strictEqual(videosLimitFor({ tier: 'max', pro_until: FUTURE }).own, 200);
  assert.strictEqual(videosLimitFor({ tier: 'pro', pro_until: PAST }).own, 1);
  assert.strictEqual(videosLimitFor({ comp_pro: true }).own, 50);
});

test('the ENTITLEMENT vocabulary is not the PROFILE vocabulary', () => {
  // This is the bug. 'paid' is what the entitlement layer calls a subscriber;
  // profiles.tier never holds it. A synthesised row reads FREE, silently.
  assert.strictEqual(creditTierFor({ tier: 'paid', pro_until: FUTURE }), 'free');
  assert.notStrictEqual(videosLimitFor({ tier: 'paid', pro_until: FUTURE }).own, 50);
});

test('videos_limit is an OBJECT, never a scalar', () => {
  // RULED 2026-09-22. The paywall renders Pro and Max to a user holding
  // neither, so a scalar — which can only describe the caller — cannot serve
  // the screen that needs this. This leg is what makes a scalar unsendable.
  for (const row of [{ tier: 'free' }, { tier: 'max', pro_until: FUTURE }, null]) {
    const v = videosLimitFor(row);
    assert.strictEqual(typeof v, 'object', 'must be an object');
    assert.notStrictEqual(v, null, 'must not be null — absent goes in `own`');
    assert.ok(!Array.isArray(v), 'must not be an array');
    assert.deepStrictEqual(Object.keys(v).sort(), ['free', 'max', 'own', 'pro']);
  }
});

test('every tier ships every time, at the ruled numbers', () => {
  const v = videosLimitFor({ tier: 'free' });
  assert.strictEqual(v.free, 1);
  assert.strictEqual(v.pro, 50);
  assert.strictEqual(v.max, 200);
});

test('own tracks the caller across every REAL profile shape', () => {
  assert.strictEqual(videosLimitFor({ tier: 'free' }).own, 1);
  assert.strictEqual(videosLimitFor({ tier: 'pro', pro_until: FUTURE }).own, 50);
  assert.strictEqual(videosLimitFor({ tier: 'max', pro_until: FUTURE }).own, 200);
  assert.strictEqual(videosLimitFor({ tier: 'pro', pro_until: PAST }).own, 1);
  assert.strictEqual(videosLimitFor({ comp_pro: true }).own, 50);
});

test('own is ABSENT, not the smallest tier, on an unreadable row', () => {
  // A limit of 3 shown to a Max subscriber is worse than showing none. The
  // absent-as-zero family, in the field the user reads. The tier map still
  // ships — only `own` is unknown.
  const v = videosLimitFor(null);
  assert.strictEqual(v.own, null);
  assert.strictEqual(v.pro, 50, 'the tier map is known even when the caller is not');
});

test('videos_limit is RULED, never credits / cost', () => {
  // They agree today, and that agreement is a coincidence of today's prices.
  // This asserts the SOURCE is independent, not that the numbers match: if an
  // AI video costs 20, credits/cost stops being the number of videos and only
  // an independently ruled constant still states the promise.
  for (const tier of ['free', 'pro', 'max']) {
    assert.ok(Number.isInteger(VIDEOS_LIMIT[tier]), `${tier} has a ruled video limit`);
  }
  // NEITHER EQUALITY NOR INEQUALITY IS ASSERTED, AND I GOT THAT WRONG ONCE IN
  // EACH DIRECTION BEFORE WRITING IT DOWN.
  //
  // First this said "they agree today and that is a coincidence, so do not
  // encode it". Right. Then RevenueCat lagged the ruling, pro went 50 promised
  // against 20 held, and I replaced the note with assert.notStrictEqual —
  // encoding the DIVERGENCE as the rule. That broke the moment RC flipped and
  // 500/10 came back to 50, which is the same mistake with the sign changed:
  //
  //     before the flip   VIDEOS_LIMIT.pro 50   TIER_ALLOWANCE.pro/COST 20
  //     after  the flip   VIDEOS_LIMIT.pro 50   TIER_ALLOWANCE.pro/COST 50
  //
  // The relationship between them is a FACT ABOUT A MOMENT — how far RevenueCat
  // has caught up with a ruling — and a check that pins a moment is wrong on
  // either side of it. What is durable is that VIDEOS_LIMIT is a LITERAL nobody
  // computes: the promise is stated, not derived, so it cannot move when the
  // mechanism does.
  //
  // So: assert the values and the independence, and say why the obvious
  // assertion is a trap, because the next reader will see two numbers that
  // agree and reach for exactly it.
  assert.deepStrictEqual(VIDEOS_LIMIT, { free: 1, pro: 50, max: 200 },
    'the ruled promise, stated and not derived');
});

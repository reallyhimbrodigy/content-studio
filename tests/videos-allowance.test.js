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
  assert.deepStrictEqual(VIDEOS_LIMIT, { free: 3, pro: 50, max: 200 });
});

test('every REAL profile shape maps to the right video allowance', () => {
  assert.strictEqual(videosLimitFor({ tier: 'free' }).own, 3);
  assert.strictEqual(videosLimitFor({ tier: 'pro', pro_until: FUTURE }).own, 50);
  assert.strictEqual(videosLimitFor({ tier: 'max', pro_until: FUTURE }).own, 200);
  assert.strictEqual(videosLimitFor({ tier: 'pro', pro_until: PAST }).own, 3);
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
  assert.strictEqual(v.free, 3);
  assert.strictEqual(v.pro, 50);
  assert.strictEqual(v.max, 200);
});

test('own tracks the caller across every REAL profile shape', () => {
  assert.strictEqual(videosLimitFor({ tier: 'free' }).own, 3);
  assert.strictEqual(videosLimitFor({ tier: 'pro', pro_until: FUTURE }).own, 50);
  assert.strictEqual(videosLimitFor({ tier: 'max', pro_until: FUTURE }).own, 200);
  assert.strictEqual(videosLimitFor({ tier: 'pro', pro_until: PAST }).own, 3);
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
  // Deliberately NOT asserted: VIDEOS_LIMIT[t] === TIER_ALLOWANCE[t] / COST_PER_RENDER.
  // Encoding that would make the coincidence a rule and fail the day the rule
  // is correctly broken. Recorded so the next reader knows it was a choice.
  assert.ok(TIER_ALLOWANCE.pro === 500 && COST_PER_RENDER === 10);
});

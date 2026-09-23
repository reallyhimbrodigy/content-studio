#!/usr/bin/env node
'use strict';
// FREE IS ONE VIDEO A MONTH, TEN CREDITS, AND NO RE-EDIT.
//
// WHY THIS FILE EXISTS RATHER THAN A LINE IN tests/. The two constants it
// guards were asserted only in tests/videos-allowance.test.js and
// tests/free-credits.test.js, and NOTHING RUNS THOSE. Render's buildCommand
// runs `node validate_deploy.js`, which discovers `lib/__smoke_*.js`; CI runs
// the same one command. There is no `npm test` wired to either. So the
// assertion that VIDEOS_LIMIT.free is what we think it is has never executed
// once — a check that has never run is not yet a check, and this is the
// quietest form of it: the file is present, correct, and dark.
//
// THE 402 HALF IS A PAIR, NOT A READER. "Free gets the re-edit paywall" is two
// facts: the door returns 402 when `reeditCaps.reedit` is false, and
// capabilities('free').reedit IS false. The first is in server.js and the
// second in lib/tier-capabilities.js, and a change to either alone silently
// turns the paywall into a free feature or a paid one into a wall. L4 and L5
// assert both ends, because a flag's test surface is the pair.

const assert = require('assert');
const { VIDEOS_LIMIT, videosLimitFor, shouldDebit, TIER_ALLOWANCE } = require('./credits');
const { FREE_MONTHLY_ALLOWANCE, topUpDelta } = require('./free-credits');
const { capabilities } = require('./tier-capabilities');

let n = 0;
const leg = (name, fn) => { fn(); n += 1; console.log(`   ok  ${name}`); };

// L1 ONE VIDEO A MONTH. Reversal recorded 2026-09-22: this was 3 on 09-21.
leg('L1 videos_limit_free_is_one', () => {
  assert.strictEqual(VIDEOS_LIMIT.free, 1);
  assert.deepStrictEqual(VIDEOS_LIMIT, { free: 1, pro: 50, max: 200 });
});

// L2 AND THE CALLER AGREES. The constant and what /api/usage reports are two
// different things; a Max subscriber was once shown the free number because
// the tier resolver collapsed every row to 'free'.
leg('L2 videos_limit_for_free_reports_one', () => {
  const v = videosLimitFor({ tier: 'free' });
  assert.strictEqual(v.free, 1);
  assert.strictEqual(v.own, 1);
  assert.deepStrictEqual(Object.keys(v).sort(), ['free', 'max', 'own', 'pro']);
});

// L3 TEN CREDITS A MONTH, TOP UP TO rather than ADD. Reversal: 30 until 09-22.
leg('L3 free_monthly_allowance_is_ten', () => {
  assert.strictEqual(FREE_MONTHLY_ALLOWANCE, 10);
  assert.strictEqual(topUpDelta(0), 10, 'an empty balance tops up to the allowance');
  assert.strictEqual(topUpDelta(10), 0, 'at the allowance, nothing is added');
  assert.strictEqual(topUpDelta(40), 0,
    'ABOVE the allowance is left alone — purchased credits are not clawed back');
});

// L4 FREE CANNOT RE-EDIT — the capability half of the pair.
leg('L4 free_has_no_reedit_capability', () => {
  assert.strictEqual(capabilities('free').reedit, false);
  assert.strictEqual(capabilities('trial').reedit, false);
});

// L5 AND PAID STILL CAN — the other direction, asserted separately so a change
// that turns re-edit off for everyone cannot pass as "free is blocked".
leg('L5 paid_and_max_keep_reedit', () => {
  assert.strictEqual(capabilities('paid').reedit, true);
  assert.strictEqual(capabilities('max').reedit, true);
});

// L6 shouldDebit IS UNTOUCHED. Ruling 3 (a re-edit never debits) now applies to
// Pro and Max only, and it applies to them by this function being UNCHANGED —
// free never reaches it, because the 402 fires first in the re-edit door. If
// this ever starts returning true for a re-edit, a paying subscriber is charged
// for a change to a video they already paid for.
leg('L6 reedit_still_never_debits', () => {
  assert.strictEqual(shouldDebit({ isReEdit: true }), false);
  assert.strictEqual(shouldDebit({ mode: 'tweak' }), false);
  assert.strictEqual(shouldDebit({ mode: 'render_only' }), false);
  assert.strictEqual(shouldDebit({ mode: 'full' }), true, 'a fresh render still debits');
});

// L7 THE TWO FREE NUMBERS AGREE. TIER_ALLOWANCE.free is what /api/usage reports
// and what scripts/grant-credits.js deposits; FREE_MONTHLY_ALLOWANCE is what the
// live top-up actually targets. They are the SAME QUANTITY reached by different
// code, and nothing made them agree — so moving one alone shows a free user a
// ceiling they can never reach, or hands a manual grant three times the credits.
// Asserted rather than made to compute from one another, because the free row is
// ours and the pro/max rows are RevenueCat's; collapsing them would put the free
// number under the "wait for RC" rule, where it does not belong.
leg('L7 the_two_free_allowances_agree', () => {
  assert.strictEqual(TIER_ALLOWANCE.free, FREE_MONTHLY_ALLOWANCE,
    'TIER_ALLOWANCE.free (displayed + granted) must equal the top-up target');
  assert.strictEqual(TIER_ALLOWANCE.free, 10);
});

console.log(`free-tier limits smoke: PASS (${n} legs — free 1 video / 10 credits / no re-edit)`);

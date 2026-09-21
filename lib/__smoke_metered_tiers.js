'use strict';
// WHICH TIERS THE METER APPLIES TO — and the reason each answer is what it is,
// pinned to the live store listings rather than to somebody's memory of them.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stripComments } = require('./__gate_strip');
const { tierIsMetered, meterAllTiers, METERED_TIERS, TIER_ALLOWANCE,
        COST_PER_RENDER, creditTierFor } = require('./credits');

// ── THIS FILE CONTROLS ITS OWN ENVIRONMENT ──────────────────────────────────
// It used to INHERIT process.env, so its expectations depended on wherever it
// happened to run. That is not hypothetical: CREDITS_METER_ALL_TIERS=1 is set
// in production, so `tierIsMetered('Pro')` is TRUE there and FALSE on a laptop
// — the file passed locally, 78/78, and failed the Render build gate on the
// deploy that mattered, keeping Pro unmetered for another cycle.
//
// A test that reads deploy configuration for a behavioural expectation is not
// testing the code, it is testing the machine it is on. Every assertion below
// runs against a KNOWN state; the override block sets the flag deliberately and
// puts it back.
const _ENV_SAVED = process.env.CREDITS_METER_ALL_TIERS;
delete process.env.CREDITS_METER_ALL_TIERS;
process.on('exit', () => {
  if (_ENV_SAVED === undefined) delete process.env.CREDITS_METER_ALL_TIERS;
  else process.env.CREDITS_METER_ALL_TIERS = _ENV_SAVED;
});

// ── THE OVERRIDE, BY NAME ───────────────────────────────────────────────────
// CREDITS_METER_ALL_TIERS=1 was set in production and NOTHING READ IT, so Pro
// stayed exempt and the arming did nothing for the tier it was set for. A flag
// that is set and unread is worse than one that was never set: the dashboard
// says the decision is in force.
{
  assert.strictEqual(tierIsMetered('pro'), false, 'unset: pro stays exempt');
  process.env.CREDITS_METER_ALL_TIERS = '1';
  assert.strictEqual(tierIsMetered('pro'), true,
    "CREDITS_METER_ALL_TIERS=1 must meter Pro — this is the exact name set in "
    + 'production, and the whole point of the ruling');
  assert.strictEqual(tierIsMetered('free'), true);
  assert.strictEqual(tierIsMetered('max'), true);
  // UNKNOWN TIERS STILL FAIL CLOSED. The override widens which KNOWN tiers are
  // metered; it must not turn the check off. A tier we do not recognise is one
  // whose store copy nobody has read.
  for (const t of ['comp', 'trial', 'enterprise', '', null, undefined, 'nonsense']) {
    assert.strictEqual(tierIsMetered(t), false,
      `override must not meter an unrecognised tier: ${JSON.stringify(t)}`);
  }
  process.env.CREDITS_METER_ALL_TIERS = '0';
  assert.strictEqual(tierIsMetered('pro'), false, "'0' is not '1' — an explicit opt-in");
  process.env.CREDITS_METER_ALL_TIERS = 'true';
  assert.strictEqual(tierIsMetered('pro'), false,
    "only the literal '1' arms it, matching every other switch in this server");
  delete process.env.CREDITS_METER_ALL_TIERS;   // back to the file's known state
}

// ── the rule ────────────────────────────────────────────────────────────────
assert.strictEqual(tierIsMetered('free'), true, 'free is metered: no store copy to contradict');
assert.strictEqual(tierIsMetered('max'), true,
  'MAX IS METERED BECAUSE ITS LISTING ALREADY SAYS SO. promptly_max_monthly and '
  + '_yearly both read "100 videos a month + early access to latest features", '
  + 'and 1000 credits / 10 = exactly 100. Metering Max makes the product match '
  + 'its own approved description rather than changing what was sold.');
assert.strictEqual(tierIsMetered('pro'), false,
  'DEFAULT (flag unset): Pro is NOT metered. All three Pro listings say Unlimited — "Unlimited '
  + 'renders, unlimited chats, re-edit any video" (monthly, yearly) and '
  + '"Unlimited edits, re-editing, and premium AI models" (weekly), all '
  + 'APPROVED. 200 credits is 20 videos a month and 8 of 27 subscribers already '
  + 'exceed that in 30 days. Metering Pro sells unlimited and delivers twenty.');

// ── the arithmetic the listings depend on ──────────────────────────────────
assert.strictEqual(TIER_ALLOWANCE.max / COST_PER_RENDER, 100,
  "Max's description promises 100 videos a month. If this stops equalling 100, "
  + 'the listing and the grant have drifted and the App Store copy is the one '
  + 'that is wrong in public.');
assert.strictEqual(TIER_ALLOWANCE.free / COST_PER_RENDER, 3);
assert.strictEqual(TIER_ALLOWANCE.pro / COST_PER_RENDER, 20,
  'the number Pro would be capped at, kept visible so nobody re-derives it');

// ── unknown tiers FAIL CLOSED toward not charging ──────────────────────────
for (const t of ['', null, undefined, 'unknown', 'trial', 'comp', 'paid', 'premium', 'enterprise']) {
  assert.strictEqual(tierIsMetered(t), false,
    `unknown/other tier must not be metered: ${JSON.stringify(t)}. A tier we do `
    + 'not recognise is a tier whose store copy we have not read, and refusing a '
    + 'render against copy we have not read breaks a promise silently.');
}
// 'paid' and 'premium' matter specifically: creditTierFor maps entitled users to
// 'pro' or 'max' and never emits these, but a future caller passing a raw
// profile.tier could. They must not accidentally meter.
assert.strictEqual(creditTierFor({ tier: 'max', pro_until: '2099-01-01' }), 'max');

// case and whitespace are normalised, so a stray ' Max ' is still metered
assert.strictEqual(tierIsMetered(' MAX '), true);
assert.strictEqual(tierIsMetered('Pro'), false,
  'default state; this exact line is what failed the Render build, because it '
  + 'was written when Pro could never be metered and then inherited an env that '
  + 'said otherwise');

// ── the conjunct is actually wired into the limiter ────────────────────────
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const CODE = stripComments(SRC);
assert.ok(/creditsAreTheLimiter\s*=\s*CREDITS_DEBIT_ENABLED[\s\S]{0,400}?tierIsMetered\(/.test(CODE),
  'tierIsMetered must be a CONJUNCT of creditsAreTheLimiter. Deciding the tier '
  + 'anywhere else means the debit and the daily cap can both be off, or both '
  + 'on, for the same request — the exactly-one-limiter property is what stops a '
  + 'credit-holding user getting a daily_limit_reached 402.');
assert.ok(/&&\s*!isCompAccount\(entitlement\.row\)/.test(CODE),
  'comp stays excluded on its OWN line: it is exempt for a different reason — no '
  + 'subscription for RC\'s recurring grant to hang on — and collapsing two '
  + 'reasons into one condition is how the next person deletes the wrong half');

// ── METERED_TIERS is the single place to change ────────────────────────────
assert.deepStrictEqual([...METERED_TIERS].sort(), ['free', 'max'],
  'Pro moves here the day its listings stop saying unlimited, and it is ONE cell');

// ── credits_metering: "does the meter MOVE", separate from "may it be DRAWN" ──
// The live defect this closes: `credits` is on in production, so build 254 sets
// creditsEnabled=true and claims "20 videos a month" to a Pro subscriber whose
// listing says Unlimited and who really does get unlimited. Undersold — the
// failure direction that reads as conservative and goes unnoticed.
assert.ok(/credits_metering:/.test(CODE), 'health must expose credits_metering');
// ANCHORED ON THE RESOLVER. These conjuncts moved into _resolveCreditsSwitch
// when each 'off' gained a named cause. The property is unchanged — every one
// of them must still be required for the meter to read 'on' — so it is asserted
// where the logic now lives rather than against an inline expression.
const METER_BLOCK = (CODE.match(/function _resolveCreditsSwitch[\s\S]*?\n\}/) || [''])[0];
assert.ok(METER_BLOCK.length > 0,
  'positive control: _resolveCreditsSwitch not found, so the conjunct checks '
  + 'below would pass against an empty string');
// THE GUARD, NOT THE NAME. Checking that 'FREE_CREDITS_MIN_BUILD' appears is
// presence where USE was needed: the string survives in the `floorOk =` line
// even after the guard that consumes it is deleted, so the meter could stop
// requiring the floor with this check still green. Verified by mutation — it
// was. Each entry below is the GUARD EXPRESSION that must force 'off'.
for (const conj of ['!CREDITS_DEBIT_ENABLED', '!floorOk', '!rcOk', "probe !== 'ok'"]) {
  assert.ok(METER_BLOCK.includes(conj),
    `credits_metering must conjoin ${conj} — any one missing leaves the meter `
    + 'inert while it reports armed, which is the exact state that once debited '
    + 'nobody and took an elimination across five conjuncts to find');
}

// `credits` must KEEP its old meaning, or every build <= 254 changes behaviour
// on the deploy that adds credits_metering — which would make an additive field
// a live change. The DISPLAY switch is resolved with requireDebit:false; the
// METER with requireDebit:true. If the display ever demanded the debit flag,
// the whole installed fleet would flip on a deploy meant to add a field.
assert.ok(/_resolveCreditsSwitch\(\{\s*envOn: \/\^\(1\|on\|true\|yes\)\$\/i\.test\(String\(process\.env\.CREDITS/.test(CODE),
  'the display switch must still read process.env.CREDITS');
assert.ok(/requireDebit: false,\s*\}\);/.test(CODE),
  'the DISPLAY switch must resolve with requireDebit:false — making it depend on '
  + 'the debit flag would flip behaviour for every build <= 254 on a deploy that '
  + 'is supposed to be additive');
assert.ok(/_resolveCreditsSwitch\(\{ envOn: true, requireDebit: true \}\)/.test(CODE),
  'the METER switch must require the debit flag');

console.log('[smoke] metered tiers: ALL PASS (free + max metered and max matches its own '
  + 'approved listing at 100/mo; pro exempt against three "Unlimited" listings; unknown '
  + 'tiers fail closed; the conjunct is wired into creditsAreTheLimiter)');

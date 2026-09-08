/**
 * SMOKE: an EXPIRATION must not revoke a subscription the user still pays for.
 *
 * THE HAZARD, and why it needs a test rather than production watching. The
 * raise-guard is scoped to GRANTS on purpose — 'free' ranks below every paid
 * tier, so applying it to a revoke would make subscriptions unrevokable. That
 * left EXPIRATION writing 'free' unconditionally:
 *
 *   Max subscriber downgrades to Pro. The Pro grant arrives; the raise-guard
 *   keeps 'max' over it, correctly. Later the Max period ends, its EXPIRATION
 *   fires, and 'free' is written — revoking the Pro they are paying for.
 *   Nothing in the row ever recorded that the Pro grant happened.
 *
 * ORDERING-DEPENDENT AND UNOBSERVABLE: there are ZERO Max rows today, so it
 * cannot fire and cannot be caught by watching production. It goes live the day
 * someone buys Max. That is the whole reason this exists.
 *
 * WHAT MAKES IT FIRE: the decision reverting to an unconditional 'free', or the
 * server not consulting it at all — a decision function with no consumer is
 * this repo's recorded defect class, not a fix.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { tierAfterRevoke, tierRank } = require('../lib/entitlement');

let failed = 0;
function check(label, fn) {
  try { fn(); } catch (e) { failed++; console.log(`  - ${label}\n      ${e.message}`); }
}

// ── THE CUSTOMER SHAPE THIS EXISTS FOR ────────────────────────────────────
check('a Max expiration keeps the Pro that is still active', () => {
  assert.strictEqual(
    tierAfterRevoke({ ok: true, isPro: true, tier: 'pro', proUntil: 123 }), 'pro',
    'the Max expiration wrote free and revoked a paying Pro subscriber');
});
check('a Pro expiration keeps a Max that is still active', () => {
  assert.strictEqual(tierAfterRevoke({ ok: true, isPro: true, tier: 'max' }), 'max');
});

// ── IT MUST STILL REVOKE. The opposite bug is worse. ──────────────────────
check('nothing active still revokes', () => {
  assert.strictEqual(tierAfterRevoke({ ok: true, isPro: false }), 'free');
});
check('RC unavailable revokes (today\'s behaviour)', () => {
  assert.strictEqual(tierAfterRevoke(null), 'free');
});
check('a failed lookup revokes', () => {
  assert.strictEqual(tierAfterRevoke({ ok: false, tier: 'max' }), 'free');
  assert.strictEqual(tierAfterRevoke({}), 'free');
});
check('an unrecognised tier revokes rather than pinning', () => {
  assert.strictEqual(tierAfterRevoke({ ok: true, isPro: true, tier: 'bogus' }), 'free');
  assert.strictEqual(tierAfterRevoke({ ok: true, isPro: true, tier: '' }), 'free');
});
check('a free/none result revokes', () => {
  assert.strictEqual(tierAfterRevoke({ ok: true, isPro: true, tier: 'free' }), 'free');
  assert.ok(tierRank('free') >= tierRank('none'));
});

// ── THE CONSUMER. A decision nothing calls is not a fix. ──────────────────
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('server.js imports the decision', () => {
  assert.ok(/\btierAfterRevoke\b/.test(src), 'server.js never mentions tierAfterRevoke');
});
check('the REVOKE branch calls it', () => {
  const i = src.indexOf('revokesProNow.has(type)');
  assert.ok(i > 0, 'the revoke branch moved — re-wire this check');
  const branch = src.slice(i, i + 2600);
  assert.ok(/tierAfterRevoke\(/.test(branch),
    'the revoke branch does not call tierAfterRevoke — it is back to writing '
    + 'free unconditionally, and the decision function is a producer with no consumer');
});
check('the revoke branch no longer hardcodes tier: \'free\'', () => {
  const i = src.indexOf('revokesProNow.has(type)');
  const branch = src.slice(i, i + 2600);
  assert.ok(!/\bupdate\s*=\s*\{\s*\n\s*tier:\s*'free',/.test(branch),
    'the revoke branch still assigns tier:\'free\' literally in its update');
});
check('it consults RevenueCat for what is still active', () => {
  const i = src.indexOf('revokesProNow.has(type)');
  const branch = src.slice(i, i + 2600);
  assert.ok(/reconcileEntitlementFromRevenueCat\(/.test(branch),
    'the revoke branch never asks RC what remains active, so the decision is '
    + 'fed nothing and can only ever return free');
});

if (failed) { console.log(`REVOKE-KEEPS-ACTIVE: ${failed} FAILED`); process.exit(1); }
console.log('REVOKE-KEEPS-ACTIVE: PASS (10 checks — customer shape, revocability, and the consumer)');

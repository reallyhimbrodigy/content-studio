'use strict';
// GATE: the referral ladder decides how much unmetered compute we give away.
// It is the one piece of this loop where an arithmetic error costs real money
// rather than a wrong number on a dashboard.

const assert = require('assert');
const {
  BONUS_AT, BONUS_DAYS, CAP_DAYS_PER_30D,
  daysEarned, cumulativeDays, applyCap, endTimeMs, isSelfReferral,
} = require('./referral-rewards');

// ── 1. THE FIRST INVITE PAYS — the entire point of the re-ladder ────────────
// The old scheme paid nothing until three, so a user who shared once and
// succeeded learned the loop did not work.
assert.strictEqual(daysEarned(0, 1), 2,
  'one qualified referral must earn 2 days — a first success paying nothing is what the ladder fixes');

// ── 2. the bonus lands exactly once, at three ───────────────────────────────
assert.strictEqual(cumulativeDays(1), 2, 'one referral: two days');
assert.strictEqual(cumulativeDays(2), 4, 'two referrals: four days, no bonus yet');
assert.strictEqual(cumulativeDays(3), 7,
  'three referrals must total SEVEN — the week the DB default and the shipped copy already promise');
assert.strictEqual(cumulativeDays(4), 9, 'the bonus does not repeat on the fourth');
assert.strictEqual(daysEarned(3, 1), 2, 'past the milestone, each referral is worth two days again');
assert.strictEqual(CAP_DAYS_PER_30D, 2 * cumulativeDays(3),
  'the cap must be exactly two full rewards per rolling month — read the ladder and the cap together');

// ── 3. a batch spanning the threshold pays the bonus ONCE ───────────────────
// Reconciling three at once must equal reconciling them one at a time, or the
// answer depends on how often the job happens to run.
assert.strictEqual(daysEarned(0, 3), 7,
  'a batch crossing the bonus must pay the same as three separate crossings');
assert.strictEqual(
  daysEarned(0, 1) + daysEarned(1, 1) + daysEarned(2, 1),
  daysEarned(0, 3),
  'the ladder must be path-independent — batching must not change what is owed');

// ── 4. idempotent under replay ──────────────────────────────────────────────
// A reconcile that runs twice with nothing new must grant nothing. Without
// this, a retry is a free reward.
assert.strictEqual(daysEarned(5, 0), 0, 'no new qualified referrals means no new days, however often it runs');

// ── 5. THE CAP, which is what bounds the liability ──────────────────────────
let r = applyCap(10, 0);
assert.strictEqual(r.grant, 10, 'under the cap, grant in full');
assert.strictEqual(r.capped, false);

r = applyCap(10, CAP_DAYS_PER_30D - 4);
assert.strictEqual(r.grant, 4, 'only the remaining allowance may be granted');
assert.strictEqual(r.capped, true, 'and the caller must be told it was reduced');
assert.strictEqual(r.withheld, 6, 'the withheld amount is the number worth watching if abuse starts');

r = applyCap(5, CAP_DAYS_PER_30D);
assert.strictEqual(r.grant, 0, 'at the cap, nothing more is granted');
assert.strictEqual(r.capped, true);

// A silently truncated grant is indistinguishable from a small one — which is
// exactly the failure this flag exists to prevent.
assert.notStrictEqual(applyCap(10, 12).capped, applyCap(2, 0).capped,
  'granting 2 because that is all that is owed must not look like granting 2 because of the cap');

// ── 6. no negative or nonsense inputs produce a grant ───────────────────────
assert.strictEqual(daysEarned(-5, -5), 0, 'negative inputs never earn days');
assert.strictEqual(applyCap(-3, 0).grant, 0);
assert.strictEqual(applyCap(5, -100).grant, 5, 'a nonsense window does not inflate the allowance beyond the cap');
assert.ok(applyCap(999, 0).grant <= CAP_DAYS_PER_30D, 'no single grant may ever exceed the cap');

// ── 7. self-referral ────────────────────────────────────────────────────────
assert.strictEqual(isSelfReferral('u1', 'u1'), true, 'the cheapest abuse there is');
assert.strictEqual(isSelfReferral('u1', 'u2'), false);
assert.strictEqual(isSelfReferral(null, null), false, 'two missing ids are not a match');

// ── 8. the grant window is real time, forward only ──────────────────────────
const now = 1_700_000_000_000;
assert.strictEqual(endTimeMs(1, now), now + 86_400_000, 'one day is one day');
assert.strictEqual(endTimeMs(0, now), now, 'zero days does not extend entitlement');
assert.ok(endTimeMs(-5, now) >= now, 'a negative grant must never move entitlement backwards');

console.log(`referral-rewards smoke: PASS — first invite pays, bonus lands once at ${BONUS_AT}, ` +
            `ladder is path-independent and replay-safe, cap holds at ${CAP_DAYS_PER_30D}d and says when it bites.`);

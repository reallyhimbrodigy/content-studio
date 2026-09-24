#!/usr/bin/env node
'use strict';
// THE RE-EDIT DECISION. Free is refused, paid is free to a cap, past the cap
// is a price and not a wall, and the database owns concurrency.
const assert = require('assert');
const p = require('./reedit-policy');

let n = 0;
const failed = [];
const leg = (name, fn) => {
  try { fn(); n += 1; console.log(`   ok  ${name}`); }
  catch (e) { failed.push(name); console.log(`   FAIL  ${name}: ${e.message}`); }
};

// L1 FREE IS REFUSED BEFORE THE COUNT IS READ. "You have used 10 of 10" tells
// a free user a limit applies to them that does not — the refusal is about
// the tier, and the cap is not part of the answer.
leg('L1 free_is_pro_required_and_never_sees_a_cap', () => {
  for (const tier of ['free', 'trial', '', null, undefined, 'FREE ']) {
    const r = p.decideReedit({ tier, used: 0, capValue: { per_video: 10 } });
    assert.strictEqual(r.allow, false, `tier ${JSON.stringify(tier)} must be refused`);
    assert.strictEqual(r.status, 402);
    assert.strictEqual(r.reason, 'pro_required');
    assert.strictEqual(r.cap, undefined, 'a refused free user must not be told a cap');
    assert.strictEqual(r.used, undefined);
  }
});

// L2 PAID IS FREE UP TO THE CAP, and the boundary is pinned on both sides:
// the 10th re-edit is free and the 11th is priced.
leg('L2 paid_is_free_to_the_cap_and_the_boundary_is_exact', () => {
  for (const tier of ['pro', 'max', 'Pro', 'MAX']) {
    assert.strictEqual(p.decideReedit({ tier, used: 0, capValue: { per_video: 10 } }).charge, 0);
    assert.strictEqual(p.decideReedit({ tier, used: 9, capValue: { per_video: 10 } }).charge, 0,
      'the 10th re-edit (used=9) is still free');
    const at = p.decideReedit({ tier, used: 10, capValue: { per_video: 10 } });
    assert.strictEqual(at.charge, 'standard_edit', 'the 11th is priced');
    assert.strictEqual(at.remaining, 0);
  }
});

// L3 PAST THE CAP IS A PRICE, NOT A WALL. 402ing here would end the path at
// ten, and a re-edit that costs money is still a re-edit.
leg('L3 past_the_cap_still_allows', () => {
  const r = p.decideReedit({ tier: 'pro', used: 50, capValue: { per_video: 10 } });
  assert.strictEqual(r.allow, true, 'past the cap must ALLOW, priced');
  assert.strictEqual(r.status, undefined, 'no refusal status past the cap');
});

// L4 AN ABSENT CAP IS THE DEFAULT, NEVER ZERO. Zero means "charge every
// re-edit" and would arrive silently the first time the config read failed —
// charging users because a row could not be read is the expensive direction.
leg('L4 an_unreadable_cap_falls_back_and_never_to_zero', () => {
  for (const bad of [null, undefined, {}, { per_video: 0 }, { per_video: -3 },
                     { per_video: 'ten' }, 'nonsense', NaN]) {
    assert.strictEqual(p.capFrom(bad), p.DEFAULT_CAP,
      `${JSON.stringify(bad)} must fall back to ${p.DEFAULT_CAP}`);
  }
  // and a real configured value is honoured, or the fallback is the only path
  assert.strictEqual(p.capFrom({ per_video: 3 }), 3);
  assert.strictEqual(p.capFrom(25), 25);
});

// L5 A NEGATIVE OR NONSENSE `used` COUNTS AS ZERO RATHER THAN THROWING. A
// count that cannot be read must not refuse a paying customer.
leg('L5 an_unreadable_used_count_does_not_refuse', () => {
  for (const bad of [null, undefined, -1, 'three', NaN]) {
    const r = p.decideReedit({ tier: 'pro', used: bad, capValue: { per_video: 10 } });
    assert.strictEqual(r.allow, true);
    assert.strictEqual(r.charge, 0);
  }
});

// L6 THE DATABASE OWNS CONCURRENCY AND THIS ONLY NAMES WHAT IT SAID. A
// partial-unique violation is 23505 and is ORDINARY — a double tap, two tabs.
// Returning 500 for it would read as an outage.
leg('L6 a_duplicate_key_becomes_409_not_500', () => {
  const r = p.conflictFrom({ code: '23505',
    message: 'duplicate key value violates unique constraint '
      + '"video_jobs_one_inflight_reedit_per_project"' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.reason, 'one_reedit_at_a_time');
  assert.strictEqual(r.retryable, true);
});

// L7 AND A DIFFERENT UNIQUE VIOLATION IS NOT NAMED AS ONE. Saying "a re-edit
// is already running" for an unrelated constraint sends someone to wait for a
// render that is not there.
leg('L7 another_unique_violation_is_not_called_a_reedit', () => {
  const other = p.conflictFrom({ code: '23505',
    message: 'duplicate key value violates unique constraint "picked_clips_pkey"' });
  assert.strictEqual(other.status, 409);
  assert.strictEqual(other.reason, 'conflict', 'must NOT claim a re-edit is in flight');
  // and a non-duplicate error is not a conflict at all
  assert.strictEqual(p.conflictFrom({ code: '42P01', message: 'no such table' }), null);
  assert.strictEqual(p.conflictFrom(null), null);
});

if (failed.length) {
  console.log(`reedit-policy: FAIL (${failed.join(', ')})`);
  process.exit(1);
}
console.log(`reedit-policy: PASS (${n} legs — free never sees a cap, past the cap is a `
  + `price not a wall, and an absent cap is never zero)`);

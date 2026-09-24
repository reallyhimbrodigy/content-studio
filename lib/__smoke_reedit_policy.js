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
    // RE-AIMED 2026-09-24. This asserted charge === 'standard_edit', a symbolic
    // value that Zac's ruling replaced with a real number from the pricing
    // table. The leg was CORRECT when written and wrong once the design moved
    // — it defended a DECISION rather than the PROPERTY, which is that the
    // eleventh re-edit is PRICED and priced at whatever the table says.
    assert.ok(Number.isFinite(at.charge) && at.charge > 0,
      `the 11th is priced, as a number (got ${JSON.stringify(at.charge)})`);
    assert.strictEqual(at.charge, require('../lib/credit-prices.json')
      .our_prices.reedit_post_cap.credits,
      'and the number is the table\'s, never one written into the route');
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

// ══ THE 402 CONTRACT (Zac 2026-09-24) ═══════════════════════════════════
// "The body carries: reason, scope, included, used, price, balance. The client
// renders its copy from these fields. Post-cap price: 5 credits unless Zac
// overrides. It comes from the same pricing table as every other price, never
// a constant inside the route."
{
  const R = require('./reedit-policy');
  const A = require('assert');
  const table = require('./credit-prices.json');

  // ── C1: EXACTLY THE SIX FIELDS. A field the client does not expect is
  // noise; a field it does expect and does not get is a blank in the copy.
  const d = R.decideReedit({ tier: 'pro', used: 10, capValue: 10 });
  const body = R.capRefusalBody({ decision: d, balance: 37 });
  A.deepStrictEqual(Object.keys(body).sort(),
    ['balance', 'included', 'price', 'reason', 'scope', 'used'],
    'C1: the 402 body carries exactly reason, scope, included, used, price, balance');

  // ── C2: NO `message`. The client owns the wording; a server sentence here
  // is a second authority saying the same thing slightly differently.
  A.ok(!('message' in body), 'C2: the server does not write the copy');

  // ── C3: THE SCOPE IS PER ROOT VIDEO, and it is stated rather than implied.
  A.strictEqual(R.SCOPE, 'video',
    'C3: capFrom reads `per_video` and `used` counts re-edits on THIS video — '
    + 'a scope the server means and the client guesses is two products');
  A.strictEqual(body.scope, 'video');

  // ── C4: THE PRICE COMES FROM THE TABLE, not from this route.
  A.strictEqual(R.postCapPrice().price, table.our_prices.reedit_post_cap.credits,
    'C4: the quote must be the table\'s number');
  A.strictEqual(body.price, 5, 'C4: and the ruled value is 5 credits');
  A.strictEqual(d.charge, 5, 'C4: the decision charges the same number it quotes');

  // ── C5: A MISSING PRICE IS ABSENT, NEVER 0. Quoting 0 for a price we could
  // not find gives the work away and nothing ever surfaces it.
  const gone = R.postCapPrice({ our_prices: {} });
  A.strictEqual(gone.state, 'ABSENT', 'C5: an empty table is ABSENT');
  A.strictEqual(gone.price, null, 'C5: and its price is null, not 0');
  A.strictEqual(R.postCapPrice({}).state, 'ABSENT');
  A.ok(/credit_prices\.py/.test(gone.why), 'C5: and it says how to fix it');

  // ── C6: AN UNREAD BALANCE IS null, NOT 0. Number(null) is 0 and
  // Number.isFinite(0) is true, so the obvious spelling tells a user they have
  // nothing when they may have plenty. This was written wrong first.
  A.strictEqual(R.capRefusalBody({ decision: d }).balance, null,
    'C6: an unread balance is null');
  A.strictEqual(R.capRefusalBody({ decision: d, balance: undefined }).balance, null);
  A.strictEqual(R.capRefusalBody({ decision: d, balance: 'x' }).balance, null);
  A.strictEqual(R.capRefusalBody({ decision: d, balance: 0 }).balance, 0,
    'C6 control: and a real zero is still a real zero');

  // ── C7: `included` AND `used` ARE THE NUMBERS THE DECISION MADE, so the
  // copy the client renders describes the decision the server actually took.
  const d3 = R.decideReedit({ tier: 'max', used: 3, capValue: { per_video: 4 } });
  A.strictEqual(d3.reason, 'within_free_reedits', 'C7: 3 of 4 is still included');
  const d4 = R.decideReedit({ tier: 'max', used: 4, capValue: { per_video: 4 } });
  A.strictEqual(R.capRefusalBody({ decision: d4 }).included, 4);
  A.strictEqual(R.capRefusalBody({ decision: d4 }).used, 4);
  A.strictEqual(R.capRefusalBody({ decision: d4 }).reason, 'cap_reached');

  // ══ THE THREE REASON STRINGS AND THEIR PRECEDENCE (Zac 2026-09-24) ═════
  // All three re-edit refusals are 402, so the HTTP number cannot tell them
  // apart — Frontend has been matching on it because these were never stated.
  // `reason` is the discriminator and it is exhaustive.

  // ── P1: EXACTLY THREE, NAMED. A fourth string appearing without a client
  // change is a refusal the client cannot render.
  A.deepStrictEqual([...R.REASONS].sort(),
    ['cap_reached', 'insufficient_credits', 'pro_required'],
    'P1: the three re-edit refusal reasons, exhaustively');

  // ── P2: EACH ONE IS REACHABLE. A named reason no input produces is a
  // contract the server cannot honour.
  A.strictEqual(R.decideReedit({ tier: 'free', used: 0, capValue: 10 }).reason,
    'pro_required', 'P2: free tier');
  A.strictEqual(R.decideReedit({ tier: 'pro', used: 10, capValue: 10, balance: 40 }).reason,
    'cap_reached', 'P2: past the cap with money');
  A.strictEqual(R.decideReedit({ tier: 'pro', used: 10, capValue: 10, balance: 2 }).reason,
    'insufficient_credits', 'P2: past the cap without money');

  // ── P3: PRECEDENCE. Past the cap AND balance < price must be
  // insufficient_credits, never cap_reached — the client offers "Get credits"
  // on one and "Use 5 credits" on the other, and offering to spend five
  // credits to someone holding two is an instruction that cannot be obeyed.
  for (const bal of [0, 1, 4]) {
    const d = R.decideReedit({ tier: 'pro', used: 10, capValue: 10, balance: bal });
    A.strictEqual(d.reason, 'insufficient_credits',
      `P3: balance ${bal} against a price of ${R.postCapPrice().price} is insufficient`);
    A.strictEqual(d.allow, false, `P3: and it does not allow the edit at ${bal}`);
    const b = R.capRefusalBody({ decision: d });
    A.strictEqual(b.price, R.postCapPrice().price, 'P3: the body still carries the price');
    A.strictEqual(b.balance, bal, 'P3: and the balance, so the client can say both');
  }
  // EXACTLY AT THE PRICE IS PAYABLE. Off by one here refuses a user who can
  // afford it and sends them to a top-up they do not need.
  {
    const price = R.postCapPrice().price;
    const d = R.decideReedit({ tier: 'pro', used: 10, capValue: 10, balance: price });
    A.strictEqual(d.reason, 'cap_reached', 'P3: balance == price can pay');
    A.strictEqual(d.allow, true);
  }

  // ── P4: pro_required OUTRANKS BOTH. A free user is refused before the count
  // is read, so they are never told a balance is short — that is the same
  // mistake as "you have used 10 of 10" one layer down.
  for (const bal of [0, 2, 9999]) {
    const d = R.decideReedit({ tier: 'free', used: 99, capValue: 10, balance: bal });
    A.strictEqual(d.reason, 'pro_required', `P4: free at balance ${bal}`);
  }

  // ── P5: AN UNREAD BALANCE IS NOT "NO". We do not tell someone they are
  // short on a number we never read — that is the confident zero, told to the
  // customer, and it would route them to a top-up they may not need.
  {
    const d = R.decideReedit({ tier: 'pro', used: 10, capValue: 10 });
    A.strictEqual(d.reason, 'cap_reached', 'P5: no balance read -> not insufficient');
    A.strictEqual(R.capRefusalBody({ decision: d }).balance, null,
      'P5: and the body says so rather than printing 0');
    for (const junk of [null, undefined, 'x', NaN]) {
      A.strictEqual(R.decideReedit({ tier: 'pro', used: 10, capValue: 10, balance: junk }).reason,
        'cap_reached', `P5: ${JSON.stringify(junk)} is unread, not zero`);
    }
  }

  // ── P6: THE BODY NEVER CONTRADICTS ITS OWN REASON. insufficient_credits
  // with a balance at or above the price would be a refusal the fields deny.
  {
    const d = R.decideReedit({ tier: 'pro', used: 10, capValue: 10, balance: 1 });
    const b = R.capRefusalBody({ decision: d, balance: 9999 });
    A.strictEqual(b.reason, 'insufficient_credits');
    A.ok(b.balance < b.price,
      'P6: the decision\'s balance wins over a later argument — re-deciding '
      + 'precedence in the body is how a reason and its fields come to disagree');
  }

  console.log('[smoke] reedit 402 contract: ALL PASS (exactly six fields, no copy, '
    + 'scope=video, price from the table and never from the route, a missing price '
    + 'is ABSENT not 0, an unread balance is null not 0)');
}

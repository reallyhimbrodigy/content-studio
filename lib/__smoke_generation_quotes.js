#!/usr/bin/env node
'use strict';
// The generation and batch contract, sections 1-6. One definition, one shape.
const assert = require('assert');
const g = require('./generation-quotes');

let n = 0;
const leg = (name, fn) => { fn(); n += 1; console.log(`   ok  ${name}`); };

// L1 THE PRICE COMES FROM THE TABLE, NOT A FLAT NUMBER. The defect this
// replaces: a flat 20 credits for any generated video, which is UNDER cost on
// 7 of 11 model x resolution rows and 5.8x under at Seedance 2.5 1080p.
leg('L1 price_varies_by_model_and_resolution', () => {
  const lo = g.priceFor({ kind: 'ai_video', model: 'Seedance 2.0 Fast', resolution: '480p', duration_s: 5 });
  const hi = g.priceFor({ kind: 'ai_video', model: 'Seedance 2.5', resolution: '1080p', duration_s: 5 });
  assert.ok(lo.credits > 0 && hi.credits > 0);
  assert.ok(hi.credits / lo.credits >= 5, `expected a wide spread, got ${lo.credits}..${hi.credits}`);
});

// L2 THE LABEL AND THE CREDITS COME FROM THE SAME ROW. The client never
// builds the label, so a label that disagreed with the charge would be a
// price the user read and a different price we took.
leg('L2 label_and_credits_from_one_row', () => {
  const q = g.quoteCard({ quote_id: 'q', kind: 'ai_video', model: 'Seedance 2.0',
    resolution: '720p', duration_s: 5, balance: 100, now: 0 });
  const p = g.priceFor({ kind: 'ai_video', model: 'Seedance 2.0', resolution: '720p', duration_s: 5 });
  assert.strictEqual(q.credits, p.credits);
  assert.strictEqual(q.label, p.label);
  assert.ok(/\d+s$/.test(q.label), `label should carry the duration: ${q.label}`);
});

// L3 AN UNPRICED FEATURE REFUSES — it never returns a guessed number.
leg('L3 unpriced_refuses_rather_than_guesses', () => {
  const r = g.priceFor({ kind: 'ai_video', model: 'AI Avatar', resolution: '1080p', duration_s: 5 });
  assert.strictEqual(r.credits, undefined);
  assert.ok(r.error, 'an unpriced row must carry an error, not a price');
});

// L4 ONE 402 SHAPE, AND `reason` ALONE DECIDES THE CARD. Nothing parsed from
// prose, and every field the client reads is present on every reason.
leg('L4 one_402_shape_for_every_reason', () => {
  for (const reason of ['insufficient_credits', 'pro_required', 'daily_cap']) {
    const e = g.paymentRequired(reason, { needed: 45, balance: 20 });
    assert.strictEqual(e.error, 'payment_required');
    assert.strictEqual(e.reason, reason);
    for (const k of ['needed', 'balance', 'shortfall', 'actions']) {
      assert.ok(k in e, `${reason} is missing ${k}`);
    }
    assert.ok(Array.isArray(e.actions) && e.actions.length > 0);
  }
  assert.deepStrictEqual(
    g.paymentRequired('pro_required', { needed: 1, balance: 0 }).actions, ['upgrade']);
});

// L5 SHORTFALL IS NEVER NEGATIVE. A negative shortfall renders as "you are
// -25 short", which is the arithmetic saying the model is wrong.
leg('L5 shortfall_never_negative', () => {
  const e = g.paymentRequired('insufficient_credits', { needed: 10, balance: 100 });
  assert.strictEqual(e.shortfall, 0);
});

// L6 AN EXPIRED QUOTE IS REFUSED. Ten minutes, and the boundary is refused
// rather than admitted — a quote expiring exactly now is a quote whose price
// may already have moved.
leg('L6 expired_quote_is_refused', () => {
  const q = g.quoteCard({ quote_id: 'q', kind: 'ai_video', model: 'Seedance 2.0',
    resolution: '720p', duration_s: 5, balance: 100, now: 0 });
  assert.strictEqual(g.isExpired(q.expires_at, 0), false);
  assert.strictEqual(g.isExpired(q.expires_at, g.QUOTE_TTL_MS - 1), false);
  assert.strictEqual(g.isExpired(q.expires_at, g.QUOTE_TTL_MS), true, 'the boundary must expire');
  assert.strictEqual(g.isExpired(q.expires_at, g.QUOTE_TTL_MS + 1), true);
});

// L7 THE BATCH IS ALL OR NOTHING, and the shortfall is stated in the same
// breath as what IS affordable. No partial sends, ever.
leg('L7 batch_is_all_or_nothing_with_a_stated_shortfall', () => {
  const b = g.batchQuote({ batch_quote_id: 'b', clip_ids: Array(10).fill('c'),
    kind: 'ai_video', model: 'Seedance 2.0', resolution: '720p', duration_s: 5,
    balance: 45, now: 0 });
  assert.strictEqual(b.count, 10);
  assert.strictEqual(b.credits_total, b.credits_each * 10);
  assert.strictEqual(b.affordable_count, Math.floor(45 / b.credits_each));
  assert.strictEqual(b.shortfall, b.credits_total - 45);
  assert.ok(b.affordable_count < b.count, 'this fixture must be a shortfall case');
});

// L7b NO PARTIAL SENDS, EVER — and nothing tested this until a mutation
// walked straight past L7. L7 checks the QUOTE shape; the all-or-nothing rule
// lives in CONFIRM, and "dispatch what we can afford" is exactly the helpful-
// looking change someone makes on a Friday. It must refuse and dispatch zero.
leg('L7b confirm_dispatches_all_or_nothing', () => {
  const short = g.batchConfirm({ count: 10, credits_each: 10, balance: 45,
    tier: 'paid', used_today: 0 });
  assert.strictEqual(short.error, 'payment_required');
  assert.strictEqual(short.reason, 'insufficient_credits');
  assert.strictEqual(short.dispatch, undefined, 'a refused batch dispatches NOTHING');
  assert.strictEqual(short.ok, undefined);
  assert.strictEqual(short.shortfall, 100 - 45);
  const fine = g.batchConfirm({ count: 4, credits_each: 10, balance: 45,
    tier: 'paid', used_today: 0 });
  assert.strictEqual(fine.ok, true);
  assert.strictEqual(fine.dispatch, 4, 'the user asking for 4 gets exactly 4');
  assert.strictEqual(fine.reserve, 40);
});

// L8 THE BATCH CAP IS TEN, enforced on the BATCH. Ten single requests and one
// batch of ten are the same day's generation; only a whole-batch check sees
// the second.
leg('L8 batch_cap_and_daily_cap_on_the_whole_batch', () => {
  const tooMany = g.batchQuote({ batch_quote_id: 'b', clip_ids: Array(11).fill('c'),
    kind: 'ai_video', model: 'Seedance 2.0', resolution: '720p', duration_s: 5, balance: 1e9, now: 0 });
  assert.strictEqual(tooMany.error, 'too_many');
  const capped = g.batchConfirm({ count: 10, credits_each: 10, balance: 1e9,
    tier: 'paid', used_today: 5 });
  assert.strictEqual(capped.reason, 'daily_cap', 'used 5 + 10 exceeds the Pro cap of 10');
  const ok = g.batchConfirm({ count: 5, credits_each: 10, balance: 1e9, tier: 'paid', used_today: 5 });
  assert.strictEqual(ok.ok, true);
});

// L9 A FREE TIER GETS pro_required FROM THE BATCH PATH TOO. A loophole that
// only closes on one endpoint is not closed.
leg('L9 free_tier_batch_is_pro_required', () => {
  for (const tier of ['free', 'trial', '', null, undefined]) {
    const r = g.batchConfirm({ count: 1, credits_each: 10, balance: 1e9, tier, used_today: 0 });
    assert.strictEqual(r.reason, 'pro_required', `tier ${JSON.stringify(tier)} must be refused`);
  }
});

// L10 ETA IS NULL BELOW 20 SAMPLES. A median of three is a number that looks
// like knowledge and is not; the client shows the position only.
leg('L10 eta_is_null_below_twenty_samples', () => {
  const few = g.queueFields({ queue_position: 3, recent_durations_s: [30, 40, 50] });
  assert.strictEqual(few.eta_seconds, null);
  assert.strictEqual(few.queue_position, 3);
  const many = g.queueFields({ queue_position: 2,
    recent_durations_s: Array.from({ length: 20 }, () => 60) });
  assert.strictEqual(typeof many.eta_seconds, 'number');
  assert.ok(many.eta_seconds > 0);
  const none = g.queueFields({ queue_position: 1, recent_durations_s: [] });
  assert.strictEqual(none.eta_seconds, null, 'no samples is null, never 0');
});

console.log(`generation-quotes: PASS (${n} legs — one price table, one 402 shape, no partial sends)`);

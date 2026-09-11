'use strict';
const assert = require('assert');
const { debitSources, shortfallFor, DEFAULT_COST } = require('./credits-batch');

const quiet = { log() {}, error() {} };
const srcs = (n) => Array.from({ length: n }, (_, i) => ({ client_key: `k${i + 1}` }));

/** A debit that refuses once the balance runs out, the way RC does: atomically,
 *  with no pre-read, throwing INSUFFICIENT. */
function rc(balance) {
  const calls = [];
  return {
    calls,
    debit: async (userId, amount) => {
      calls.push(amount);
      if (balance < amount) { const e = new Error('insufficient'); e.code = 'INSUFFICIENT'; throw e; }
      balance -= amount;
    },
    get left() { return balance; },
  };
}

(async () => {
  // ── DARK: every source answered, nothing charged, ZERO RC calls ──────────
  const dark = rc(0);
  let r = await debitSources({ userId: 'u', sources: srcs(10), armed: false, debit: dark.debit, log: quiet });
  assert.strictEqual(r.metered, false);
  assert.strictEqual(r.answered.length, 10);
  assert.strictEqual(r.held.length, 0);
  assert.strictEqual(r.spent, 0);
  assert.strictEqual(dark.calls.length, 0,
    'DARK MUST NOT TOUCH RC AT ALL. A debit call that "would have failed" still '
    + 'costs a round-trip and still logs — dark means the path is not taken.');
  assert.ok(r.answered.every((a) => a.credits_debited === null),
    'a dark answer carries a NULL receipt, which refund-leg reads as never-debited');
  // and the shape is identical to the armed path, so the caller has ONE path
  assert.deepStrictEqual(Object.keys(r).sort(),
    ['answered', 'costPerSource', 'held', 'metered', 'spent'].sort());

  // ── THE HEADLINE CASE: 60 credits, ten sources -> SIX ────────────────────
  const six = rc(60);
  r = await debitSources({ userId: 'u', sources: srcs(10), armed: true, debit: six.debit, log: quiet });
  assert.strictEqual(r.metered, true);
  assert.strictEqual(r.answered.length, 6, '60 / 10 = six answered');
  assert.strictEqual(r.held.length, 4);
  assert.strictEqual(r.spent, 60);
  assert.strictEqual(six.left, 0, 'exactly the balance was spent, never more');
  assert.ok(r.answered.every((a) => a.credits_debited === 10),
    'AN ARMED ANSWER CARRIES THE ACTUAL RECEIPT. A null here would be read by '
    + 'refund-leg as never-debited — refundJobCredits returns noop on a NULL '
    + 'credits_debited — so a failed render would be charged and never refunded. '
    + '(Asserted only for the dark case at first, which is how it was missed.)');
  assert.deepStrictEqual(r.answered.map((a) => a.client_key), ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'],
    'answered IN THE USER\'S OWN ORDER — they get the first six they picked, '
    + 'which is predictable; an arbitrary six is not');
  assert.deepStrictEqual(r.held.map((h) => h.client_key), ['k7', 'k8', 'k9', 'k10']);
  assert.ok(r.held.every((h) => h.reason === 'insufficient'));
  // HELD BY NAME. The client maps client_key back to the asset the user picked;
  // without it the UI can only say "four failed" and not WHICH four.
  assert.ok(r.held.every((h) => typeof h.client_key === 'string' && h.client_key));

  // ── STOPS AT THE FIRST REFUSAL, rather than trying the rest ──────────────
  assert.strictEqual(six.calls.length, 7,
    'six successes plus ONE refusal. A balance cannot rise mid-loop, so every '
    + 'later source would be refused too — continuing spends N more RC '
    + 'round-trips to learn what the first refusal already said.');

  // ── an UNMEASURABLE failure holds the rest and keeps what was charged ────
  let n = 0;
  const flaky = async () => {
    n += 1;
    if (n <= 2) return;
    const e = new Error('rc down'); e.code = 'UNREACHABLE'; throw e;
  };
  r = await debitSources({ userId: 'u', sources: srcs(5), armed: true, debit: flaky, log: quiet });
  assert.strictEqual(r.answered.length, 2,
    'the two that were CHARGED stay answered and MUST still be dispatched — '
    + 'those users paid, and withholding their renders is the wrong repair');
  assert.strictEqual(r.held.length, 3);
  assert.ok(r.held.every((h) => h.reason === 'unavailable'),
    'RC being unreachable is UNMEASURABLE, not "no credits" — held for a '
    + 'different reason, and never reported to the user as a shortfall');
  assert.strictEqual(r.spent, 20);

  // ── it NEVER THROWS, which is what makes the caller contract total ───────
  const boom = async () => { throw Object.assign(new Error('x'), { code: 'RC_ERROR' }); };
  r = await debitSources({ userId: 'u', sources: srcs(3), armed: true, debit: boom, log: quiet });
  assert.strictEqual(r.answered.length, 0);
  assert.strictEqual(r.held.length, 3, 'a total failure holds everything and reports it');

  // ── the shortfall message counts ONLY genuine shortfalls ────────────────
  const s1 = shortfallFor({ held: [{ reason: 'insufficient' }, { reason: 'insufficient' }], costPerSource: 10 });
  assert.deepStrictEqual(s1, { reason_code: 'credits_shortfall', held: 2, needed: 20 });
  assert.strictEqual(shortfallFor({ held: [{ reason: 'unavailable' }], costPerSource: 10 }), null,
    'an outage must NOT be reported as "you need more credits" — that is a '
    + 'purchase prompt for a problem the user cannot fix and did not cause');
  assert.strictEqual(shortfallFor({ held: [], costPerSource: 10 }), null);
  assert.ok(!/[a-z] [a-z]/.test(s1.reason_code),
    'a reason_code, never a sentence — the words live in the String Catalog or '
    + 'every non-English reader gets English');

  // ── edge: zero sources, and one source ──────────────────────────────────
  r = await debitSources({ userId: 'u', sources: [], armed: true, debit: rc(999).debit, log: quiet });
  assert.deepStrictEqual([r.answered.length, r.held.length, r.spent], [0, 0, 0]);
  r = await debitSources({ userId: 'u', sources: srcs(1), armed: true, debit: rc(5).debit, log: quiet });
  assert.strictEqual(r.answered.length, 0, 'a single unaffordable source is held, not part-charged');
  assert.strictEqual(r.spent, 0);

  assert.strictEqual(DEFAULT_COST, 10, 'matches lib/credits.js COST_PER_RENDER');

  console.log('[smoke] credits batch: ALL PASS (dark makes ZERO rc calls and answers all; '
    + '60/10 answers six in the user\'s order and holds four BY NAME; stops at the first '
    + 'refusal; an outage holds rather than shortfalls; never throws)');
})().catch((e) => { console.error('[smoke] FAILED:', e && e.message); process.exit(1); });

'use strict';
// GATE: a referral must not pay out on a flag alone.
//
// `referrals.qualified_at` is written inside the database and nothing in either
// tree writes it. Zero RPCs are exposed to the `anon` role, but the client calls
// claim_referral with a USER JWT, so the `authenticated` role holds EXECUTE on
// at least one of these functions — and which ones cannot be enumerated without
// SQL access. If qualification turned out to be reachable by a logged-in user,
// the cap would bound the payout while the ledger recorded capped grants against
// referrals nobody earned.
//
// So the reconcile pays against a COMPLETED RENDER, not against the flag. These
// assertions are what stop that from being quietly weakened later.

const assert = require('assert');
const { reconcile, suspiciousQualifications } = require('./referral-reconcile');
const { CAP_DAYS_PER_30D } = require('./referral-rewards');

const R = 'referrer-1';
const base = { referrerId: R, priorCounted: 0, grantedInWindow: 0 };

// ── 1. THE FLAG ALONE PAYS NOTHING ──────────────────────────────────────────
let out = reconcile({
  ...base,
  referrals: [{ referred_id: 'a', qualified_at: '2026-08-29T00:00:00Z', counted_at: null }],
  referredWithRender: new Set(),           // flag set, but NO completed render
});
assert.strictEqual(out.days, 0, 'a referral marked qualified with no completed render must pay NOTHING');
assert.strictEqual(out.eligible.length, 0);
assert.strictEqual(suspiciousQualifications(out).length, 1,
  'and it must be REPORTED — a non-zero count here means qualification is reachable without a render');

// ── 2. the render alone pays ────────────────────────────────────────────────
out = reconcile({
  ...base,
  referrals: [{ referred_id: 'a', qualified_at: null, counted_at: null }],
  referredWithRender: new Set(['a']),
});
assert.strictEqual(out.days, 2, 'a confirmed completed render earns its two days, flag or no flag');

// ── 3. self-referral never pays, even with a real render ────────────────────
out = reconcile({
  ...base,
  referrals: [{ referred_id: R, qualified_at: '2026-08-29T00:00:00Z', counted_at: null }],
  referredWithRender: new Set([R]),
});
assert.strictEqual(out.days, 0, 'self-referral pays nothing even when the render is genuine');
assert.strictEqual(out.rejected[0].reason, 'self_referral');

// ── 4. already-counted rows are skipped, not re-paid ────────────────────────
out = reconcile({
  ...base,
  referrals: [{ referred_id: 'a', qualified_at: 'x', counted_at: '2026-08-01T00:00:00Z' }],
  referredWithRender: new Set(['a']),
});
assert.strictEqual(out.days, 0, 'a counted referral must never pay twice');
assert.strictEqual(out.rejected.length, 0, 'and that is not an error worth reporting');

// ── 5. the bonus lands through the reconcile, once ──────────────────────────
out = reconcile({
  ...base,
  referrals: [
    { referred_id: 'a', counted_at: null }, { referred_id: 'b', counted_at: null },
    { referred_id: 'c', counted_at: null },
  ],
  referredWithRender: new Set(['a', 'b', 'c']),
});
assert.strictEqual(out.days, 7, 'three confirmed renders pay the full week — the reward the copy already promises');

// ── 6. the cap bites, and says so ───────────────────────────────────────────
out = reconcile({
  referrerId: R, priorCounted: 0, grantedInWindow: CAP_DAYS_PER_30D - 1,
  referrals: [
    { referred_id: 'a', counted_at: null }, { referred_id: 'b', counted_at: null },
    { referred_id: 'c', counted_at: null },
  ],
  referredWithRender: new Set(['a', 'b', 'c']),
});
assert.strictEqual(out.days, 1, 'only the remaining allowance is granted');
assert.strictEqual(out.cap.capped, true);
assert.strictEqual(out.reason, 'capped', 'the reason must distinguish a capped grant from a small one');

// ── 7. mixed batch: only the confirmed ones count ───────────────────────────
out = reconcile({
  ...base,
  referrals: [
    { referred_id: 'a', qualified_at: 'x', counted_at: null },   // confirmed
    { referred_id: 'b', qualified_at: 'x', counted_at: null },   // flag only
    { referred_id: 'c', qualified_at: null, counted_at: null },  // neither
  ],
  referredWithRender: new Set(['a']),
});
assert.strictEqual(out.days, 2, 'one confirmed render out of three rows pays exactly two days');
assert.strictEqual(suspiciousQualifications(out).length, 1, 'b is flagged-without-render and must be visible');
assert.ok(out.rejected.some((r) => r.reason === 'not_yet_qualified'),
  'c is simply not there yet — a different case from b, and must not be conflated with it');

// ── 8. empty input is a no-op, not a grant ──────────────────────────────────
out = reconcile({ ...base, referrals: [], referredWithRender: new Set() });
assert.strictEqual(out.days, 0);
assert.strictEqual(out.reason, 'nothing_newly_earned');

console.log('referral-reconcile smoke: PASS — pays against a completed render, never the flag; ' +
            'self-referral and double-count blocked; flagged-without-render surfaced as a finding.');

'use strict';
// The free-tier credit decisions, every branch a test.
//   node --test tests/free-credits.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const {
  FREE_MONTHLY_ALLOWANCE, periodKey, topUpDelta, decideDeviceClaim, decidePeriodGrant,
  parseBuild, debitApplies,
} = require('../lib/free-credits');

// ── periodKey ──────────────────────────────────────────────────────────────
test('periodKey: UTC calendar month, YYYY-MM', () => {
  assert.strictEqual(periodKey(new Date('2026-09-02T22:00:00Z')), '2026-09');
  assert.strictEqual(periodKey(new Date('2026-01-31T23:59:59Z')), '2026-01');
  assert.strictEqual(periodKey(new Date('2026-02-01T00:00:00Z')), '2026-02');
});
test('periodKey: UTC, not local — a timezone crossing must not grant twice', () => {
  // 2026-09-30T23:30Z is still September everywhere in UTC terms, even though
  // it is already October in UTC+2. A local-time boundary would roll early and
  // hand the same user a second allowance.
  assert.strictEqual(periodKey(new Date('2026-09-30T23:30:00Z')), '2026-09');
  assert.strictEqual(periodKey(new Date('2026-10-01T00:30:00Z')), '2026-10');
});
test('periodKey: sorts and compares correctly as text', () => {
  assert.ok(periodKey(new Date('2026-09-01T00:00:00Z'))
          > periodKey(new Date('2026-08-01T00:00:00Z')));
  assert.ok(periodKey(new Date('2027-01-01T00:00:00Z'))
          > periodKey(new Date('2026-12-01T00:00:00Z')));
});

// ── topUpDelta ─────────────────────────────────────────────────────────────
test('topUpDelta: tops UP to the allowance', () => {
  assert.strictEqual(topUpDelta(0), 30);
  assert.strictEqual(topUpDelta(10), 20);
  assert.strictEqual(topUpDelta(29), 1);
});
test('topUpDelta: already at the allowance grants nothing', () => {
  assert.strictEqual(topUpDelta(30), 0);
});
// THE CONFISCATION GUARD. A user above the allowance is holding credits they
// BOUGHT as a top-up, or Pro credits from before a lapse. A flat "add 30" would
// inflate them without bound; a "set to 30" would take purchased credits away.
test('topUpDelta: NEVER negative — a purchased top-up is never confiscated', () => {
  assert.strictEqual(topUpDelta(100), 0);
  assert.strictEqual(topUpDelta(1000), 0);
  assert.ok(topUpDelta(500) >= 0);
});
test('topUpDelta: garbage balance is treated as 0, not NaN', () => {
  assert.strictEqual(topUpDelta(undefined), 30);
  assert.strictEqual(topUpDelta(null), 30);
  assert.strictEqual(topUpDelta(NaN), 30);
  assert.strictEqual(topUpDelta('nonsense'), 30);
});
test('topUpDelta: honours a custom allowance', () => {
  assert.strictEqual(topUpDelta(0, 200), 200);
  assert.strictEqual(topUpDelta(250, 200), 0);
});
test('FREE_MONTHLY_ALLOWANCE is 30', () => {
  assert.strictEqual(FREE_MONTHLY_ALLOWANCE, 30);
});

// ── decideDeviceClaim ──────────────────────────────────────────────────────
const U1 = 'user-1'; const U2 = 'user-2';
test('claim: an unseen device is claimed', () => {
  assert.deepStrictEqual(decideDeviceClaim({ row: null, userId: U1 }),
    { action: 'claim', reason: 'unseen_device' });
});
test('claim: the SAME user returning is already_claimed, never a second grant', () => {
  const d = decideDeviceClaim({ row: { user_id: U1 }, userId: U1 });
  assert.strictEqual(d.action, 'already_claimed');
});
// THE MULTI-ACCOUNT CASE THE PK EXISTS FOR: one phone, N accounts, 30 each.
test('claim: a DIFFERENT user on a claimed device is a conflict (409)', () => {
  const d = decideDeviceClaim({ row: { user_id: U1 }, userId: U2 });
  assert.strictEqual(d.action, 'conflict');
  assert.strictEqual(d.reason, 'device_claimed_by_other');
});

// ── decidePeriodGrant ──────────────────────────────────────────────────────
const P = '2026-09';
test('period: no row for the current period grants', () => {
  const d = decidePeriodGrant({ periodRow: null, period: P, currentPeriod: P });
  assert.strictEqual(d.action, 'grant');
});
test('period: a landed row skips — one allowance per account per period', () => {
  const d = decidePeriodGrant({ periodRow: { provider_ok: true }, period: P, currentPeriod: P });
  assert.strictEqual(d.action, 'skip');
  assert.strictEqual(d.reason, 'already_granted');
});
// The refund-leg shape: a row written before the money, where the money then
// failed. It must be retryable, and retry must be safe — topUpDelta recomputes
// from the live balance, so a retry after a credit that DID land grants 0.
test('period: a row that never landed is RETRIED, not skipped', () => {
  const d = decidePeriodGrant({ periodRow: { provider_ok: false }, period: P, currentPeriod: P });
  assert.strictEqual(d.action, 'retry');
  assert.strictEqual(d.reason, 'claimed_not_landed');
});
test('period: a stale period is skipped (never back-grants a past month)', () => {
  const d = decidePeriodGrant({ periodRow: null, period: '2026-08', currentPeriod: P });
  assert.strictEqual(d.action, 'skip');
  assert.strictEqual(d.reason, 'not_current_period');
});

// ── the two behaviours the whole design exists for ─────────────────────────
test('DESIGN: two devices, one account — 30/month, not 60', () => {
  // Both devices claim (two rows in free_credit_grants), but the allowance is
  // keyed on (user_id, period): the first render grants, the second sees a
  // landed row and skips. The device table cannot multiply the allowance.
  const first = decidePeriodGrant({ periodRow: null, period: P, currentPeriod: P });
  assert.strictEqual(first.action, 'grant');
  const second = decidePeriodGrant({ periodRow: { provider_ok: true }, period: P, currentPeriod: P });
  assert.strictEqual(second.action, 'skip');
});
test('DESIGN: one device, two accounts — the second is refused', () => {
  assert.strictEqual(decideDeviceClaim({ row: null, userId: U1 }).action, 'claim');
  assert.strictEqual(decideDeviceClaim({ row: { user_id: U1 }, userId: U2 }).action, 'conflict');
});
test('DESIGN: a spent-down user rolls to exactly the allowance next period', () => {
  // Spent 25 of 30 in September, nothing carried: October tops back up to 30.
  assert.strictEqual(topUpDelta(5), 25);
  const oct = decidePeriodGrant({ periodRow: null, period: '2026-10', currentPeriod: '2026-10' });
  assert.strictEqual(oct.action, 'grant');
});

// ── THE DEBIT BUILD FLOOR ──────────────────────────────────────────────────
test('parseBuild: pulls the build out of a real version string', () => {
  assert.strictEqual(parseBuild('1.3.25 (243)'), 243);
  assert.strictEqual(parseBuild('1.3.16 (234)'), 234);
  assert.strictEqual(parseBuild('2.0.0 (1000)'), 1000);
});
test('parseBuild: null on anything it cannot read', () => {
  for (const v of [null, undefined, '', '1.3.25', 'Promptly', '()', '(abc)'])
    assert.strictEqual(parseBuild(v), null, `expected null for ${JSON.stringify(v)}`);
});
test('debitApplies: charges at and above the floor', () => {
  assert.strictEqual(debitApplies({ build: 244, minBuild: 244 }), true);
  assert.strictEqual(debitApplies({ build: 250, minBuild: 244 }), true);
});
test('debitApplies: does NOT charge below the floor', () => {
  for (const b of [243, 240, 224])
    assert.strictEqual(debitApplies({ build: b, minBuild: 244 }), false, `build ${b}`);
});
// FAIL OPEN, both directions. Leaking a free render is recoverable; 402'ing a
// paying user because a header went missing is not, and it would fail silently
// across whatever client stopped sending it.
test('debitApplies: FAILS OPEN when the floor is unset (ships dark)', () => {
  assert.strictEqual(debitApplies({ build: 999, minBuild: NaN }), false);
  assert.strictEqual(debitApplies({ build: 999, minBuild: undefined }), false);
});
test('debitApplies: FAILS OPEN when the build is unreadable', () => {
  assert.strictEqual(debitApplies({ build: null, minBuild: 244 }), false);
  assert.strictEqual(debitApplies({ build: undefined, minBuild: 244 }), false);
  assert.strictEqual(debitApplies({ build: NaN, minBuild: 244 }), false);
});
// The two sides share ONE env var so a build can never be chargeable while
// being ungrantable — the window that would 402 a user who cannot be granted.
test('DESIGN: chargeable implies grantable — same floor governs both', () => {
  const FLOOR = 244;
  for (const b of [224, 240, 243, 244, 245]) {
    const chargeable = debitApplies({ build: b, minBuild: FLOOR });
    const grantable = b >= FLOOR;   // the free-grant endpoint's own check
    assert.strictEqual(chargeable, chargeable && grantable,
      `build ${b}: chargeable must never exceed grantable`);
  }
});

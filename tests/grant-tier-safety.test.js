'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const E = require('../lib/entitlement');

// A GRANT MUST NEVER COST A USER ACCESS.
//
// Two defects this pins, both live before 2026-09-01:
//   1. The reverse trial computed `Date.now() + 72h` ABSOLUTELY and wrote it to
//      profiles.pro_until. A Max subscriber six months out who tapped Decline
//      had their subscription overwritten with three days. The referral path
//      always guarded this with Math.max; the trial never did.
//   2. BOTH paths wrote `tier: 'pro'` unconditionally, clobbering a stored
//      'max' down to 'pro'. There was no tier ordering anywhere in the server,
//      which is exactly why the clobber looked harmless.
//
// Both directions are asserted, because "a Max user was unaffected" and "the
// grant never landed at all" are otherwise the same observation.

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ── direction 1: an active Max user is UNTOUCHED ────────────────────────────
test('a grant never lowers a Max tier', () => {
  assert.equal(E.tierAfterGrant('max', 'pro'), 'max');
  assert.equal(E.tierAfterGrant('Max', 'pro'), 'max', 'case must not defeat it');
  assert.equal(E.tierAfterGrant(' max ', 'pro'), 'max', 'whitespace must not defeat it');
});

test('a grant never SHORTENS an active subscription', () => {
  const sixMonths = new Date(Date.now() + 180 * 24 * 3600e3).toISOString();
  const from = E.grantFromMs(sixMonths);
  assert.ok(from > Date.now() + 179 * 24 * 3600e3,
    'the grant must count from the EXISTING expiry, not from now');
  // The full reverse-trial arithmetic: 72h on top of the existing expiry.
  const until = new Date(from + 72 * 3600 * 1000);
  assert.ok(until.getTime() > new Date(sixMonths).getTime(),
    'a 72h trial must EXTEND a six-month subscription, never replace it');
});

test('teams / premium / paid are not lowered either', () => {
  for (const t of ['teams', 'premium', 'paid']) {
    assert.equal(E.tierRank(E.tierAfterGrant(t, 'pro')), E.tierRank(t),
      `${t} must not lose rank to a pro grant`);
  }
});

// ── direction 2: a free user's grant STILL LANDS ────────────────────────────
test('a free user IS upgraded by the grant', () => {
  assert.equal(E.tierAfterGrant('free', 'pro'), 'pro');
  assert.equal(E.tierAfterGrant(null, 'pro'), 'pro', 'no stored tier still grants');
  assert.equal(E.tierAfterGrant('', 'pro'), 'pro');
  assert.equal(E.tierAfterGrant('none', 'pro'), 'pro');
});

test('a free user with no pro_until grants from NOW', () => {
  const t0 = Date.now();
  const from = E.grantFromMs(null, t0);
  assert.equal(from, t0, 'no existing expiry means the window starts now');
});

test('an EXPIRED pro_until does not drag the window backwards', () => {
  const t0 = Date.now();
  const lastYear = new Date(t0 - 365 * 24 * 3600e3).toISOString();
  assert.equal(E.grantFromMs(lastYear, t0), t0,
    'a stale expiry must not produce a grant that is already over');
});

test('a garbage pro_until falls back to now rather than NaN', () => {
  const t0 = Date.now();
  assert.equal(E.grantFromMs('not-a-date', t0), t0);
});

// ── the call sites actually USE them (a helper nobody calls is not a fix) ────
test('BOTH grant sites write a ranked tier, not a hardcoded pro', () => {
  const hard = SRC.match(/update\(\{\s*tier:\s*'pro'/g) || [];
  assert.equal(hard.length, 0,
    `${hard.length} grant site(s) still write tier:'pro' unconditionally`);
  const ranked = SRC.match(/tierAfterGrant\(/g) || [];
  assert.ok(ranked.length >= 2,
    `expected both grant sites to call tierAfterGrant, found ${ranked.length}`);
});

test('the reverse trial no longer computes an ABSOLUTE 72h window', () => {
  assert.ok(!/new Date\(Date\.now\(\) \+ 72 \* 3600 \* 1000\)/.test(SRC),
    'an absolute Date.now()+72h is the exact write that shortened a Max sub');
  assert.match(SRC, /grantFromMs\(beforeIso\) \+ 72 \* 3600 \* 1000/,
    'the trial must count 72h from the LATER of now and the existing expiry');
});

test('CONTROL: these assertions can fail', () => {
  // If tierAfterGrant were identity-on-grant, direction 1 would pass vacuously.
  const broken = (existing, grant) => grant;
  assert.notEqual(broken('max', 'pro'), 'max',
    'the control proves direction 1 is testing something');
});

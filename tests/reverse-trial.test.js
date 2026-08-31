'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

// Seam tests: the endpoint's properties are structural (order, gates, absence),
// and each is a thing that would silently degrade rather than error.
function region() {
  const i = SRC.indexOf("parsed.pathname === '/api/reverse-trial/grant'");
  assert.ok(i > 0, 'the endpoint is not registered at all');
  const j = SRC.indexOf("parsed.pathname === '/api/credits/balance'", i);
  return SRC.slice(i, j > i ? j : i + 8000);
}

test('72 HOURS from now, never calendar days', () => {
  const R = region();
  assert.match(R, /Date\.now\(\) \+ 72 \* 3600 \* 1000/,
    'a decline at 23:50 must yield 72 hours, not eight');
  assert.doesNotMatch(R, /startOfDay|setHours\(0/,
    'no calendar-day arithmetic anywhere in the grant');
});

test('gated on the KEYCHAIN build, and DARK until that build is named', () => {
  const R = region();
  assert.match(R, /REVERSE_TRIAL_MIN_BUILD/,
    '241 shipped IDFV-in-UserDefaults, which does not survive reinstall — a ' +
    'grant keyed on it re-grants forever');
  assert.match(R, /min_build_unset/,
    'with the build unset the endpoint must REFUSE, so it cannot go live ' +
    'against 241 by accident');
  const iUnset = R.indexOf('min_build_unset');
  const iGrant = R.indexOf('Date.now() + 72');
  assert.ok(iUnset > 0 && iUnset < iGrant, 'the gate must precede the grant');
});

test('device_id is required and length-bounded', () => {
  const R = region();
  assert.match(R, /device_id_required/);
  assert.match(R, /length < 8 \|\| .*length > 128/);
});

test('idempotent: a prior grant returns the ORIGINAL pro_until', () => {
  const R = region();
  assert.match(R, /already: true/);
  // The property is that the REPLY BLOCK recomputes nothing. Asserting that
  // `prior.pro_until` merely appears is too weak: replacing the returned value
  // with a fresh 72h leaves other references intact and the test green.
  // BOUND THE WINDOW TO THE REPLY OBJECT. A fixed +400 ran past the replay
  // block into the fresh-grant line, which legitimately contains
  // `Date.now() + 72` — so the assertion fired on correct code. Slice to the
  // closing `});` instead of guessing a character count.
  const iAlready = R.indexOf('already: true');
  const iEnd = R.indexOf('});', iAlready);
  const replyBlock = R.slice(iAlready, iEnd > iAlready ? iEnd : iAlready + 200);
  assert.match(replyBlock, /prior\.pro_until|won\.pro_until/,
    'the replay must echo the STORED expiry');
  assert.doesNotMatch(replyBlock, /Date\.now\(\) \+ 72/,
    'a replay that recomputes 72h turns a double-tap into 144 hours');
  assert.match(R, /reverse_trial_grants[\s\S]{0,400}insert/,
    'the PK insert is the one-shot gate');
});

test('the 30-day cap is SUMmed, and exhaustion REFUSES rather than truncates', () => {
  const R = region();
  // The COMPARISON must exist, not just the constant. Neutering the predicate
  // to `false` left CAP_DAYS_PER_30D in the require and cap_exhausted in an
  // unreachable branch, and a presence test stayed green.
  assert.match(R, /used \+ 3 > CAP_DAYS_PER_30D/,
    'without the shared cap, referrals are capped and trials unbounded — both ' +
    'write pro_until, so together they are an uncapped Pro faucet');
  assert.match(R, /reduce\(\(a, g\) => a \+ \(Number\(g\.days_granted\)/,
    'the cap must SUM the rolling window, not read one row');
  assert.match(R, /cap_exhausted/);
  const iCap = R.indexOf('cap_exhausted');
  const iGrant = R.indexOf('referral_rewards').valueOf();
  assert.ok(iCap > 0, 'no cap refusal');
  assert.doesNotMatch(R.slice(iCap, iCap + 200), /Math\.min|truncat/,
    'a one-hour "72-hour trial" reads as broken rather than generous');
});

test('ledger FIRST with provider_ok:false, then pro_until, then confirm', () => {
  const R = region();
  const iLedger = R.indexOf('provider_ok: false');
  const iProf = R.indexOf("from('profiles').update({ tier: 'pro'");
  const iOk = R.indexOf('provider_ok: true');
  assert.ok(iLedger > 0 && iProf > iLedger,
    'ledger row must exist before the grant, so a failure is visible');
  assert.ok(iOk > iProf, 'provider_ok flips only after the grant lands');
});

test('does NOT consume the free export', () => {
  // MATCH THE CALL, NOT THE WORD. The first version asserted the region had no
  // `usage_events` anywhere — and failed on the endpoint's own COMMENT saying it
  // writes none. A comment cannot spend an export; only a call can.
  const R = region().split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(R, /from\('usage_events'\)/,
    'the trial must not write a usage event — that would spend the free export');
  assert.doesNotMatch(R, /logUsageEvent|claimDailyUsage/,
    'and must not go through the charge helpers either');
});

test('CONTROL: the region is real and these assertions can fail', () => {
  const R = region();
  assert.ok(R.length > 1500, 'endpoint body actually captured');
  assert.doesNotMatch(R, /THIS_STRING_IS_NOT_PRESENT/);
});

test('a failed READ refuses rather than re-granting (the silent-zero trap)', () => {
  const R = region();
  // RLS is enabled on reverse_trial_grants with NO policies, so a non-service_role
  // client gets ZERO ROWS rather than an error. Ignoring `error` and testing only
  // `data` produces the same wrong answer from a plain query failure: null reads
  // as "no grant exists" and the endpoint grants again.
  assert.match(R, /error: priorErr/,
    'the prior-grant read must surface its error');
  assert.match(R, /prior_read_failed/,
    'a failed prior-grant read must REFUSE, not fall through to a grant');
  assert.match(R, /cap_read_failed/,
    'a failed cap read looks like "nothing granted in 30 days" and would let ' +
    'an uncapped grant through');
  const iErr = R.indexOf('prior_read_failed');
  const iGrant = R.indexOf('Date.now() + 72');
  assert.ok(iErr > 0 && iErr < iGrant, 'the refusal must precede the grant');
});

test('every DB call in the endpoint uses service_role', () => {
  const R = region();
  const clients = [...R.matchAll(/(\w+)\s*\n?\s*\.from\('([a-z_]+)'\)/g)].map((m) => m[1]);
  assert.ok(clients.length >= 6, `expected several DB calls, found ${clients.length}`);
  const bad = clients.filter((c) => c !== 'supabaseAdmin');
  assert.deepStrictEqual(bad, [],
    `non-service_role client(s) ${bad} would get ZERO ROWS under RLS-with-no-` +
    `policies — which reads as "no grant exists" and re-grants`);
});

'use strict';
// SMOKE — the manual CRD grant covers EVERY paying subscriber, and the credit
// tier has exactly one definition (2026-09-02).
//
// THE INCIDENT THIS PREVENTS. Arming CREDITS_DEBIT_ENABLED=1 while any paying
// subscriber holds a zero balance 402s them on every render. The first version
// of scripts/grant-credits.js took a hand-typed list of five users with distant
// renewals; the other fifteen would have been refused for up to four weeks, and
// five comped accounts would have been refused FOREVER — they are `comp_pro`
// rows with tier='free' and a NULL pro_until, which means:
//   - isUserPro() returns true for them (comp_pro short-circuits FIRST), so
//     every gate treats them as paid;
//   - the free monthly roll skips them (isPaid -> skip('paid_tier'));
//   - they have no subscription, so no renewal will ever grant them;
//   - and any enumeration written against `pro_until` cannot see them.
// Four of the five have rendered — 37 renders between them.
//
// SO THE ENUMERATION MUST GO THROUGH isUserPro, and that is what this pins.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const GRANT = fs.readFileSync(path.join(ROOT, 'scripts', 'grant-credits.js'), 'utf8');
const flatGrant = GRANT.replace(/\s+/g, ' ');
const fail = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); };

// ── 1. THE UNIT TESTS ACTUALLY RUN ─────────────────────────────────────────
// Until today tests/free-credits.test.js (26 tests) and tests/credits-tier.js
// were executed by NOTHING — not this gate, not CI. Tests that no runner
// invokes are the "absence rendered as success" shape: green forever, guarding
// nothing. Running them HERE makes them blocking.
const TESTS = ['tests/credits-tier.test.js', 'tests/free-credits.test.js'];
for (const t of TESTS) {
  ok(fs.existsSync(path.join(ROOT, t)), `${t} is missing — it is gate-enforced`);
}
try {
  execFileSync(process.execPath, ['--test', ...TESTS],
    { cwd: ROOT, stdio: 'pipe', timeout: 120000 });
} catch (e) {
  const out = `${(e.stdout || '')}${(e.stderr || '')}`.split('\n')
    .filter((l) => /not ok|AssertionError|Error:/.test(l)).slice(0, 6).join('\n     ');
  fail.push(`the credits unit tests FAILED:\n     ${out || e.message}`);
}

// ── 2. ONE DEFINITION OF THE CREDIT TIER ───────────────────────────────────
// The balance endpoint reports an allowance; the grant script deposits against
// one. Derived separately they drift, and the user-visible symptom is being
// told they have 1000 while holding a balance topped to 200.
ok(/tier = _credits\.creditTierFor\(/.test(SRC),
  'the balance endpoint does not derive its tier from _credits.creditTierFor — '
  + 'it and the grant script can then disagree about a user\'s allowance');
ok(/creditTierFor/.test(GRANT),
  'the grant script does not use creditTierFor — the amount it deposits could '
  + 'differ from the allowance /api/credits/balance reports');
ok(!/_dec\.plan === 'max' \? 'max' : 'pro'/.test(SRC),
  'the old inline tier derivation is still in server.js — two definitions again');

// ── 3. THE COHORT IS isUserPro, NOT pro_until ──────────────────────────────
ok(/require\('\.\.\/lib\/entitlement'\)/.test(GRANT) && /isUserPro/.test(GRANT),
  'the grant script does not import isUserPro — a reimplemented predicate is '
  + 'how the comped, pro_until-less cohort gets silently dropped');
ok(/\.filter\(\(r\) => isUserPro\(r\)\)/.test(GRANT),
  'the enumeration does not FILTER with isUserPro; whatever SQL runs, the '
  + 'shipped predicate must be what decides who is paid');

// The SQL prefilter must be a superset. A case-sensitive `tier.in.(...)` is
// not: isUserPro compares lower(trim(tier)), so a row written 'Pro' passes the
// predicate and is dropped by the query — a paying user omitted, silently.
ok(/tier\.ilike\.\*\$\{t\}\*/.test(GRANT) || /ilike/.test(flatGrant),
  'the enumeration prefilter is not case/whitespace tolerant — a tier written '
  + "'Pro' or ' pro ' would pass isUserPro and be excluded by the query");
ok(!/tier\.in\.\(pro,teams,premium,max\)/.test(GRANT),
  'the case-sensitive tier.in.(...) prefilter is back');

// ── 4. READ BEFORE WRITE, AND A NON-ZERO BALANCE IS A SKIP ─────────────────
ok(/before = await credits\.getBalance\(u\.id\)/.test(GRANT),
  'the script does not read the balance before granting — it would double-credit '
  + 'a subscriber whose renewal already landed a grant');
{
  const readIdx = GRANT.indexOf('await credits.getBalance(u.id)');
  const writeIdx = GRANT.indexOf('await credits.credit(u.id, amount)');
  ok(readIdx > 0 && writeIdx > 0 && readIdx < writeIdx,
    'the grant is written BEFORE the balance is read');
}
ok(/if \(before\.balance > 0\) \{/.test(GRANT),
  'a non-zero balance is not treated as already-granted — the discriminator '
  + 'between "RC has never seen this customer" and "the renewal already paid '
  + 'them" is exactly what stops a double-credit');

// THE LIFETIME OF THAT INFERENCE. "balance > 0 means already granted" is only
// true while nothing can spend. Once the debit is armed a spent-down user looks
// identical to a never-granted one, and re-running would grant a 2nd allowance.
// Anchored on the GUARD EXPRESSION and its exit, not on nearby prose. The
// first version of this assertion matched the words CREDITS_DEBIT_ENABLED and
// REFUSING, both of which survive replacing the condition with `if (false)` —
// it passed against a script with the guard disabled. A check that cannot fail
// is not yet a check.
ok(/if \(APPLY && DEBIT_ARMED && !FORCE\) \{[\s\S]{0,900}?process\.exit\(2\)/.test(GRANT),
  'the script does not refuse to --apply once CREDITS_DEBIT_ENABLED is armed — '
  + 'after arming, a zero balance no longer means "never granted", it also '
  + 'means "granted and spent", and re-running would issue a 2nd allowance');
ok(/const DEBIT_ARMED = \/\^\(1\|on\|true\|yes\)\$\/i\.test\(/.test(GRANT),
  'DEBIT_ARMED is not parsed with the same arm-only matcher /api/health uses — '
  + 'a mismatch would leave the guard silently off for a value like "on"');

// PostgREST caps a response at 1000 rows and says nothing about it, so a
// truncated page reads as a complete cohort with the overflow silently unpaid.
ok(/\.limit\(PAGE\)/.test(GRANT) && /rows \|\| \[\]\)\.length >= PAGE/.test(GRANT),
  'the enumeration does not detect a truncated page — past the row cap the '
  + 'cohort would silently omit paying users and still print as a full run');

// ── 5. A CLEAN ZERO IS GUILTY ──────────────────────────────────────────────
ok(/cohort\.length === 0[\s\S]{0,600}?process\.exit\(1\)/.test(flatGrant),
  'an empty cohort does not fail the run — zero paid users is a reader bug '
  + '(wrong project, non-service key), never a fact, and it would print as a '
  + 'successful no-op run');

// ── 6. THE UNLINKED COHORT IS REPORTED SEPARATELY ──────────────────────────
// Users with no rc_app_user_id have never been seen by RevenueCat, and whether
// the transactions endpoint creates a customer on first adjustment is not
// documented. Averaging their failures into one "failed N" line hides the fact
// that they need a DASHBOARD grant.
ok(/const unlinked = results\.filter\(\(r\) => !r\.linked\)/.test(GRANT),
  'the script does not separate the users RevenueCat has never seen');
ok(/DASHBOARD grant/i.test(GRANT),
  'an unlinked user whose grant is refused is not routed to a dashboard grant — '
  + 'the run would exit non-zero with no statement of what to do next');
ok(/process\.exit\(n\('failed'\) > 0 \? 1 : 0\)/.test(GRANT),
  'the script does not exit non-zero on failure — it could be run from a '
  + 'wrapper and its refusals ignored');

// ── 7. DRY RUN IS THE DEFAULT ──────────────────────────────────────────────
ok(/const APPLY = process\.argv\.includes\('--apply'\)/.test(GRANT),
  'writes are not opt-in — this script mutates real customer balances and a '
  + 'credit cannot be taken back from a paying user without another write');

if (fail.length) {
  console.error('grant-cohort smoke: FAIL');
  for (const f of fail) console.error(`   ✗ ${f}`);
  process.exit(1);
}
console.log('grant-cohort smoke: PASS (unit tests run, one tier definition, '
  + 'cohort is isUserPro over a superset query, read-before-write, armed guard, '
  + 'zero-cohort fails, unlinked reported separately, dry-run default)');

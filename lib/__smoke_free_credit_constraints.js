'use strict';
// SMOKE 1/2 — the free-credit guarantees that live in the DATABASE, and the
// fail-closed reads that guard them (2026-09-02).
//
// WHY BOTH GUARANTEES ARE CONSTRAINTS, NOT CODE. Two different things must be
// impossible, and they cannot be expressed by one key:
//   free_credit_grants   PK device_id          one install seeds ONE account
//   free_credit_periods  PK (user_id, period)  one account, one allowance/period
// Keyed only on device_id, a two-device user gets 60/month. Keyed only on
// user_id, one phone makes N accounts at 30 each. As primary keys, two
// concurrent requests cannot both insert and no code path can forget to check.
//
// WHY THE READS MATTER AS MUCH AS THE KEYS. Every read that decides whether to
// grant must FAIL CLOSED. A failed read returns null, which is indistinguishable
// from "no grant exists" — and "no grant exists" decides `grant`. That is the
// absence-versus-failure shape that produced the refund-leg loop, and RLS with
// no policies returns ZERO ROWS RATHER THAN AN ERROR to any non-service-role
// client, which is the same wrong answer by a second route.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SQL = fs.readFileSync(
  path.join(ROOT, 'migrations', '20260902_free_credit_grants.sql'), 'utf8');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');
const SQLF = flat(SQL);
const SRCF = flat(SRC);

const fail = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); };

// ── the two constraints ────────────────────────────────────────────────────
ok(/CREATE TABLE IF NOT EXISTS free_credit_grants \( device_id text PRIMARY KEY/.test(SQLF),
  'free_credit_grants.device_id is not the PRIMARY KEY — "once per install" '
  + 'becomes application logic, and one phone can seed N accounts at 30 each');
ok(/CREATE TABLE IF NOT EXISTS free_credit_periods[\s\S]*?PRIMARY KEY \(user_id, period\)/.test(SQLF),
  'free_credit_periods has no PRIMARY KEY (user_id, period) — the allowance '
  + 'stops being once-per-account-per-period, and a two-device user gets 60/month');
ok(/provider_ok boolean NOT NULL DEFAULT false/.test(SQLF),
  'free_credit_periods.provider_ok is missing or defaults true — the row must be '
  + 'written BEFORE the RevenueCat credit and default to NOT-landed, so a failed '
  + 'grant is a visible row rather than nothing');

// ── fail-closed on every read that gates a grant ───────────────────────────
// ANCHOR ON CODE TOKENS, NOT PROSE. The first version of these matched the
// explanatory log text, and one of them failed against correct code because the
// message is split across a line-wrapped string concatenation
// ('…refusing rather ' + 'than re-granting') so the prose is not contiguous in
// the source. A false RED is as broken as a false green: it would have sent
// someone hunting a fail-closed bug that did not exist. Error identifiers and
// status codes are what the guarantee actually rests on, and they do not wrap.
for (const [label, re] of [
  // ANCHORED ON free_credit_grants. Without that anchor this matched the
  // REVERSE-TRIAL endpoint, which uses byte-identical `if (priorErr)` and
  // `reason: 'prior_read_failed'` strings — so the assertion passed while
  // testing someone else's code, and stayed green when this endpoint's guard
  // was removed. Mutation testing is the only reason that was ever noticed.
  ['device-claim read (free-grant endpoint)',
    /from\('free_credit_grants'\)[\s\S]{0,500}?if \(priorErr\) \{[\s\S]{0,900}?reason: 'prior_read_failed'/],
  ['device-claim read (lazy roll)',
    /if \(claimErr\) \{[\s\S]{0,900}?return skip\('claim_read_failed'\)/],
  ['period read (lazy roll)',
    /if \(perErr\) \{[\s\S]{0,900}?return skip\('period_read_failed'\)/],
]) {
  ok(re.test(SRCF), `${label} does not FAIL CLOSED — a failed read reads as `
    + '"no grant exists" and re-grants');
}

// ── the conflict is a refusal, not a grant ─────────────────────────────────
ok(/decision\.action === 'conflict'[\s\S]{0,300}?return sendJson\(res, 409, \{ error: 'already_used'/.test(SRCF),
  "a device claimed by ANOTHER user must return 409 already_used — this is the "
  + 'multi-account case the device PK exists for');

// A lost insert race must be resolved by RE-READING the winner, never by
// assuming the caller won. The winner may be a different user, which is a 409.
ok(/if \(insErr\) \{[\s\S]{0,400}?\.eq\('device_id', deviceId\)[\s\S]{0,200}?won\.user_id !== authUser\.id[\s\S]{0,120}?409/.test(SRCF),
  'a lost device-claim race does not re-read the winner — the loser could be '
  + 'told it claimed a device that now belongs to someone else');

// ── the build floor ────────────────────────────────────────────────────────
// identifierForVendor cached in UserDefaults does NOT survive reinstall. Keyed
// on that, this endpoint is a delete-and-reinstall faucet for 30 credits.
ok(/FREE_CREDITS_MIN_BUILD/.test(SRC),
  'the free-grant endpoint has no build floor — a non-Keychain device_id makes '
  + 'it a delete-and-reinstall faucet');
// WINDOW WIDENED 2026-09-05 (160 -> 700), NOT the property. The refusal must
// still live INSIDE the `!Number.isInteger(_minBuild)` block — that is what
// makes unset mean REFUSE — but an observeDarkRefusal() call and its comment
// now sit between the guard and the return. The old window measured DISTANCE,
// which is a proxy for containment, and instrumenting the path broke the proxy
// while the property held. Both halves are asserted separately below so the
// widening cannot quietly admit a refusal from somewhere else.
ok(/parseInt\(process\.env\.FREE_CREDITS_MIN_BUILD \|\| '', 10\);[\s\S]{0,200}?if \(!Number\.isInteger\(_minBuild\)\) \{[\s\S]{0,700}?reason: 'min_build_unset'/.test(SRCF),
  'FREE_CREDITS_MIN_BUILD unset must REFUSE (ship dark), not default to open — '
  + 'otherwise it goes live against a weak key by accident');
// CONTAINMENT, by BRACE BALANCE rather than by text. The first version of this
// matched an indented `}` and was a FALSE GREEN — it passed against a mutation
// that moved the refusal outside the guard entirely. Indentation is a proxy for
// structure; balance is the structure. A regex reasons about text, and
// containment is not text.
{
  // ANCHORED TO THIS ENDPOINT. `if (!Number.isInteger(_minBuild)) {` appears at
  // BOTH the reverse-trial and free-credits endpoints — they share the variable
  // name — so a bare indexOf finds the reverse-trial one and this assertion
  // silently validated the wrong site. It passed against a mutation of the site
  // it was written to protect. Anchor on the FREE_CREDITS parseInt, then take
  // the guard that follows it.
  // THIRD TIME FOR THIS CLASS: `parseInt(process.env.FREE_CREDITS_MIN_BUILD`
  // ALSO appears at the DEBIT site, which comes first in the file. Anchor on
  // the assignment TARGET, which is unique to this endpoint (`_minBuild` here,
  // `_debitFloor` at the debit site).
  const anchor = SRCF.indexOf("_minBuild = parseInt(process.env.FREE_CREDITS_MIN_BUILD");
  const g = SRCF.indexOf("if (!Number.isInteger(_minBuild)) {", anchor);
  const open = SRCF.indexOf("{", g);
  ok(anchor !== -1 && g !== -1 && g - anchor < 200,
     'the free-credits build floor and its unset guard are no longer adjacent — '
     + 'this assertion may be validating a different endpoint');
  let depth = 0, endOfBlock = -1;
  for (let k = open; k < SRCF.length; k++) {
    if (SRCF[k] === '{') depth++;
    else if (SRCF[k] === '}') { depth--; if (depth === 0) { endOfBlock = k; break; } }
  }
  const refusal = SRCF.indexOf("reason: 'min_build_unset'", open);
  ok(g !== -1 && endOfBlock !== -1 && refusal !== -1 && refusal < endOfBlock,
     'the min_build_unset refusal is not INSIDE the unset guard block — the '
     + 'endpoint would fall through and grant on an unset floor');
}


if (fail.length) {
  console.error('free-credit constraints smoke: FAIL');
  for (const f of fail) console.error(`   ✗ ${f}`);
  process.exit(1);
}
console.log('free-credit constraints smoke: PASS (device_id PK + (user_id,period) PK, '
  + 'provider_ok ledger-first, 3 fail-closed reads, 409 on a claimed device, '
  + 'race re-reads the winner, build floor ships dark)');

'use strict';
// ── THE CREDIT SEED'S GATE ───────────────────────────────────────────────────
//
// Covers Zac's (a)-(e) of 2026-09-25 as PROPERTIES, driven by importing the
// shipped module and calling it — not by grepping for the code that would do it.
// "Source is where code might be; runtime is where it is."
//
// Legs 1-9 RUN the rules. Legs 10-12 are source properties about
// ensureCompSeedGrant, which lives inside server.js and cannot be imported
// (requiring server.js starts a listener). Those three say so rather than
// pretending to execute.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const seed = require('./credit-seed');
const free = require('./free-credits');
const credits = require('./credits');

let legs = 0;
const leg = (name, fn) => { fn(); legs += 1; console.log(`  ok  ${name}`); };

// ── 1. THE RESERVED PERIOD CANNOT BE A CALENDAR MONTH ───────────────────────
// If it could, the seed would consume a user's monthly grant slot and the
// symptom would be a MISSING TOP-UP a month later, on accounts nobody watches.
// Driven over the real periodKey across 21 years, not asserted in a comment.
leg('seed period is disjoint from every calendar period', () => {
  assert.strictEqual(seed.assertSeedPeriodDistinct(free.periodKey), true);
  assert.strictEqual(seed.SEED_PERIOD, 'comp-seed');
  // And the shape of today's real key, so a periodKey that started returning
  // something else would fail here rather than silently collide later.
  assert.ok(/^\d{4}-\d{2}$/.test(free.periodKey()),
    `periodKey() returned ${free.periodKey()}, not YYYY-MM`);
});

// ── 2. THE KEY ZAC NAMED IS THE KEY THE CODE USES ──────────────────────────
leg('seedKey is comp-seed:<user_id>', () => {
  assert.strictEqual(seed.seedKey('abc123'), 'comp-seed:abc123');
  assert.ok(seed.seedKey('x').startsWith(`${seed.SEED_PERIOD}:`),
    'the log key and the row period must not drift apart');
});

// ── 3-6. seedNeed's FOUR STATES, each with a real profile shape ─────────────
const isPro = require('./entitlement').isUserPro;

leg('a comp account unknown to RC is seeded', () => {
  const r = seed.seedNeed(
    { comp_pro: true, tier: 'pro', pro_until: '2099-12-31T23:59:59Z',
      rc_product_id: null, rc_app_user_id: null }, isPro);
  assert.deepStrictEqual(r, { seed: true, reason: 'entitled_by_us' });
});

leg('a pro_until-only account unknown to RC is seeded', () => {
  // 2efb75dd's live shape: tier=pro, comp_pro=FALSE, pro_until 2030, no RC.
  // It is not a comp, and it still can never receive an RC grant.
  const r = seed.seedNeed(
    { comp_pro: false, tier: 'pro', pro_until: '2030-12-31T00:00:00Z',
      rc_product_id: null, rc_app_user_id: null }, isPro);
  assert.deepStrictEqual(r, { seed: true, reason: 'entitled_by_us' });
});

leg('a REAL subscriber is NOT seeded — either RC column disqualifies', () => {
  // THE DOUBLE-GRANT GUARD, and the leg that matters most: RC grants these
  // accounts on renewal, so seeding them stacks a second allowance on top.
  // BOTH columns are tested INDEPENDENTLY, because a case that trips both arms
  // of a two-arm rule proves neither — deleting either half of the `||` must
  // turn one of these red.
  const byProduct = seed.seedNeed(
    { comp_pro: false, tier: 'pro', pro_until: '2030-01-01T00:00:00Z',
      rc_product_id: 'promptly_pro_monthly', rc_app_user_id: null }, isPro);
  assert.deepStrictEqual(byProduct, { seed: false, reason: 'provider_grants' },
    'rc_product_id alone must disqualify');
  const byUser = seed.seedNeed(
    { comp_pro: false, tier: 'pro', pro_until: '2030-01-01T00:00:00Z',
      rc_product_id: null, rc_app_user_id: 'ec702499-...' }, isPro);
  assert.deepStrictEqual(byUser, { seed: false, reason: 'provider_grants' },
    'rc_app_user_id alone must disqualify — a purchase whose webhook has not '
    + 'yet written rc_product_id is still a purchase RC will grant');
});

leg('a free user is left to the monthly roll, and an absent row cannot spend', () => {
  assert.deepStrictEqual(
    seed.seedNeed({ comp_pro: false, tier: 'free', pro_until: null,
                    rc_product_id: null, rc_app_user_id: null }, isPro),
    { seed: false, reason: 'not_entitled' });
  // ABSENT IS NOT A VALUE. A profile we could not read must not be seeded, and
  // it must not read as 'not_entitled' either — the two are different facts.
  assert.deepStrictEqual(seed.seedNeed(null, isPro),
    { seed: false, reason: 'unreadable' });
  // And the predicate is REQUIRED, so a caller cannot end up with a second
  // definition of "paid" by forgetting to pass one.
  assert.throws(() => seed.seedNeed({ comp_pro: true }), /isUserPro/);
});

// ── 7. decideSeed: exactly once, and retry what never landed ───────────────
leg('decideSeed seeds once, retries unlanded, never re-grants landed', () => {
  assert.deepStrictEqual(seed.decideSeed({ row: null }),
    { action: 'seed', reason: 'never_seeded' });
  assert.deepStrictEqual(seed.decideSeed({ row: { provider_ok: false } }),
    { action: 'retry', reason: 'seeded_not_landed' });
  assert.deepStrictEqual(seed.decideSeed({ row: { provider_ok: true } }),
    { action: 'skip', reason: 'already_landed' });
  // A row whose provider_ok is neither true nor false (a column that went
  // missing, a null) must RETRY, not skip. Skipping would strand an account
  // forever on an unreadable flag.
  assert.strictEqual(seed.decideSeed({ row: { provider_ok: null } }).action, 'retry');
});

// ── 8. THE TOP-UP IS BOUNDED BY THE PRO ALLOWANCE, AND NEVER CONFISCATES ───
leg('topUpDelta against the Pro allowance tops up to, never adds or lowers', () => {
  const pro = credits.TIER_ALLOWANCE.pro;
  assert.strictEqual(pro, 200, 'the seed grants the Pro allowance; if this moved, so did the seed');
  assert.strictEqual(free.topUpDelta(0, pro), pro);
  assert.strictEqual(free.topUpDelta(150, pro), 50);
  assert.strictEqual(free.topUpDelta(pro, pro), 0, 'a second pass must grant nothing');
  assert.strictEqual(free.topUpDelta(500, pro), 0,
    'an account above the allowance holds credits it was given; never claw back');
});

// ── 9. THE SPEND GUARD: told no vs could not ask ───────────────────────────
leg('rollBlocksDebit blocks only on OUR failures', () => {
  for (const r of ['rc_unreachable', 'claim_read_failed', 'period_read_failed',
                   'period_claim_lost', 'exception', 'no_db', 'credits_not_configured']) {
    assert.strictEqual(free.rollBlocksDebit(r), true, `${r} must block the debit`);
  }
  // THE OUTAGE LEG. paid_tier is the reason EVERY paid render's roll returns.
  // If it ever blocked, the guard would 503 every paying customer — a total
  // outage wearing a safety check's clothes.
  for (const r of ['paid_tier', 'already_granted', 'not_current_period',
                   'no_device_claim', 'unseen_device', 'same_user']) {
    assert.strictEqual(free.rollBlocksDebit(r), false, `${r} must NOT block the debit`);
  }
  // An unreadable outcome fails CLOSED on a spend path.
  assert.strictEqual(free.rollBlocksDebit(undefined), true);
  assert.strictEqual(free.rollBlocksDebit(null), true);
  assert.strictEqual(free.rollBlocksDebit(''), true);
});

// ── 10-12. SOURCE PROPERTIES OF ensureCompSeedGrant ───────────────────────
// Stated as source checks because server.js cannot be imported without starting
// a listener. Each says what it reads, so a failure names the file and the line
// rather than making the next run the debugger.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// WHEN A LEG MOVES, ITS TARGET MOVES WITH IT. These three were written against
// an inline ensureCompSeedGrant in server.js. Hoisting the sequence into
// lib/credit-seed.js runSeed left them resolving perfectly against a function
// that no longer contains the property — the stale-target class, and it fired
// on the first run after the refactor rather than passing quietly, only because
// the assertion named what it read.
const SEEDSRC = fs.readFileSync(path.join(__dirname, 'credit-seed.js'), 'utf8');

function runSeedBody() {
  const start = SEEDSRC.indexOf('async function runSeed(');
  assert.ok(start > 0, 'runSeed is GONE from lib/credit-seed.js');
  const rest = SEEDSRC.slice(start + 10);
  const endRel = rest.search(/\nmodule\.exports|\n(?:async function |function )/);
  assert.ok(endRel > 0, 'could not bound runSeed');
  return SEEDSRC.slice(start, start + 10 + endRel);
}

leg('provider_ok=true is written AFTER the RC credit, not before', () => {
  const body = runSeedBody();
  const iClaim  = body.indexOf('insertSeedRow(');
  const iCredit = body.indexOf('deps.credit(userId, delta)');
  const iLand   = body.indexOf('deps.markLanded(');
  assert.ok(iClaim > 0, 'runSeed no longer claims the row — the PK gate is gone');
  assert.ok(iCredit > 0, 'runSeed no longer calls credit — it grants nothing');
  assert.ok(iLand > 0, 'runSeed no longer marks the row landed');
  assert.ok(iClaim < iCredit,
    'the provider_ok:false claim must precede the credit, or a failed credit '
    + 'leaves silence instead of a queryable row');
  assert.ok(iCredit < iLand,
    'ORDERING IS THE LANDED FLAG. markLanded above the credit would mark a grant '
    + 'landed that RevenueCat never accepted — the exact defect this path exists '
    + 'to make impossible. Legs 14-15 prove the outcome; this proves the shape.');
});

leg('runSeed refuses on a failed read and on an unreachable provider', () => {
  const body = runSeedBody();
  assert.ok(/seed_read_failed/.test(body),
    'a failed read must not fall through as "no row" — that grants twice');
  assert.ok(/deps\.rcHealthy !== true/.test(body),
    'runSeed must refuse to write to a provider it has not reached');
  assert.ok(/decideSeed\(\{ row:/.test(body),
    'runSeed must use the hoisted decision, not an inline copy');
  assert.ok(/balance >= allowance \? 0 : allowance - balance/.test(body),
    'the delta must come from the LIVE balance — that is what makes a retry safe '
    + 'without an idempotency key RevenueCat does not offer');
});

// ── 12. THE isUserPro / isProfilePro CLASS ────────────────────────────────
// THE DEFECT THIS LEG EXISTS FOR, made while writing this file: server.js
// imports lib/entitlement's `isUserPro` RENAMED as `isProfilePro`. The first
// draft called `isUserPro(...)`. node --check accepts it; it throws at runtime
// INSIDE runSeed's own try/catch, so the seed would have returned
// skip('exception:isUserPro is not defined') on every account, forever, while
// every gate stayed green and the code read as wired.
//
// Same family as the `{ jobId }` ReferenceError at the video_jobs insert.
// "Mechanical rewrites require a semantic check, not just a shape check" is a
// standing rule here, and scope is not text — so this resolves the adapter's
// dependencies against server.js's OWN bindings rather than trusting spelling.
leg('every binding the adapter hands runSeed exists in server.js', () => {
  const start = SRC.indexOf('async function ensureCompSeedGrant(');
  assert.ok(start > 0, 'ensureCompSeedGrant is GONE from server.js');
  const rest = SRC.slice(start + 10);
  const endRel = rest.search(/\n(?:\/\*\*|async function |function |const server = )/);
  assert.ok(endRel > 0, 'could not bound ensureCompSeedGrant');
  const adapter = SRC.slice(start, start + 10 + endRel);

  // NAMED, NOT DISCOVERED. Each of these is load-bearing on its own, and a
  // check that counted them in aggregate would let one vanish behind the total
  // — the floor-on-a-sum defect this repo has already paid for twice.
  const NEEDED = ['isProfilePro', '_credits', '_creditSeed', '_rcHealthProbe', 'supabaseAdmin'];
  for (const name of NEEDED) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(adapter),
      `the adapter no longer references ${name} — the seed has lost a dependency`);
    const bound = new RegExp(
      `(?:const|let|var|function|async function)\\s+${name}\\b`
      + `|:\\s*${name}\\s*,`                                 // { isUserPro: isProfilePro }
      + `|\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*require`);   // destructured import
    assert.ok(bound.test(SRC),
      `the adapter passes ${name}, which server.js does not bind. node --check `
      + 'cannot see this; it throws at runtime inside runSeed\'s try/catch and '
      + "returns skip('exception:...') silently.");
  }
  // AND THE WRONG NAME MUST NOT REAPPEAR. lib/entitlement's export is
  // `isUserPro`; server.js has no such binding. A bare call to it here is the
  // exact regression this leg was written for.
  assert.ok(!/(^|[^.\w$])isUserPro\s*\(/.test(adapter),
    'the adapter calls isUserPro(), which server.js does not bind — it imports '
    + 'it renamed as isProfilePro. This throws at runtime and fails silently.');
});

// ── 13. THE SWEEP IS DARK BY DEFAULT AND CANNOT FAN OUT ───────────────────
leg('the sweep ships dark, is capped, and reports UNMEASURED not zero', () => {
  assert.ok(/CREDIT_SEED_SWEEP/.test(SRC), 'the sweep lost its switch');
  assert.ok(/SWEEP_HARD_CAP\s*=\s*(\d+)/.test(SRC), 'the sweep lost its cap');
  const cap = Number(SRC.match(/SWEEP_HARD_CAP\s*=\s*(\d+)/)[1]);
  assert.ok(cap > 0 && cap <= 500, `SWEEP_HARD_CAP=${cap} is not a bound`);
  assert.ok(/SWEEP_SPACING_MS\s*=\s*(\d+)/.test(SRC), 'the sweep lost its RC spacing');
  // A sweep that could not reach RC must not render as "nothing to do".
  assert.ok(/out\.state = 'UNMEASURED'/.test(SRC),
    'an unreachable provider must produce UNMEASURED, never a clean zero');
  // And it must not reimplement a grant.
  assert.ok(/await ensureCompSeedGrant\(/.test(SRC) && /await ensureFreePeriodGrant\(/.test(SRC),
    'both passes must call the shipped grant path, not a copy of the rule');
});

// ── 14-16. THE BEHAVIOURAL PROOF — runSeed driven, not read ───────────────
//
// THIS IS THE LEG ZAC ASKED FOR: "RED-prove that an RC failure leaves landed_at
// null and the retry lands exactly once." Leg 10 proves the two lines are in the
// right ORDER. Only this proves the OUTCOME.
//
// A fake table and a scriptable RevenueCat. The table is a Map, so "the row
// stays provider_ok=false" is something the test can look at rather than infer.

function harness({ creditThrows = false, startBalance = 0, readError = null } = {}) {
  const table = new Map();                 // key -> { provider_ok, amount, balance_before }
  const calls = { credit: [], getBalance: 0, insert: 0, markLanded: 0 };
  let balance = startBalance;
  const key = (uid, period) => `${uid}|${period}`;
  return {
    table, calls,
    get balance() { return balance; },
    deps: {
      isPro: (p) => p && p.comp_pro === true,
      creditTierFor: () => 'pro',
      tierAllowance: credits.TIER_ALLOWANCE,
      rcHealthy: true,
      readSeedRow: async (uid, period) => {
        if (readError) return { error: { message: readError } };
        return { row: table.get(key(uid, period)) || null };
      },
      insertSeedRow: async (uid, period) => {
        calls.insert += 1;
        if (table.has(key(uid, period))) return { error: { message: 'duplicate key' } };
        table.set(key(uid, period), { provider_ok: false, amount: 0, balance_before: null });
        return {};
      },
      markLanded: async (uid, period, { amount, balanceBefore }) => {
        calls.markLanded += 1;
        const r = table.get(key(uid, period));
        if (!r) return { error: { message: 'no row' } };
        r.provider_ok = true; r.amount = amount; r.balance_before = balanceBefore;
        return {};
      },
      getBalance: async () => { calls.getBalance += 1; return { balance, found: balance > 0 }; },
      credit: async (uid, amount) => {
        calls.credit.push(amount);
        if (creditThrows) {
          // The real shape: lib/credits.js throws with a code on any non-2xx.
          const e = new Error('credits_rc_error_500'); e.code = 'RC_ERROR'; throw e;
        }
        balance += amount;   // RevenueCat is authoritative; the fake mirrors it
        return { ok: true };
      },
    },
  };
}

const COMP = { comp_pro: true, tier: 'pro', pro_until: '2099-12-31T23:59:59Z',
               rc_product_id: null, rc_app_user_id: null };
const UID = 'ec702499-0000-0000-0000-000000000000';

// The three behavioural legs below are async, so they cannot use the sync `leg`
// wrapper — they register themselves as they pass. Deliberately NOT converting
// the twelve sync legs to async: those must keep failing immediately and loudly.
(async () => {
  // 14. RC FAILS -> the row exists, provider_ok is FALSE, no marker written.
  {
    const h = harness({ creditThrows: true });
    const r = await credseedRun(h, UID);
    const row = h.table.get(`${UID}|${seed.SEED_PERIOD}`);
    assert.ok(row, 'the claim row must exist BEFORE the money — a failed credit '
      + 'must leave a queryable row, not silence');
    assert.strictEqual(row.provider_ok, false,
      'RC threw and the row was marked landed anyway — that is the exact defect '
      + 'this path exists to make impossible');
    assert.strictEqual(h.calls.markLanded, 0, 'markLanded must not be reached after a throw');
    assert.strictEqual(h.calls.credit.length, 1, 'exactly one credit attempt');
    assert.strictEqual(r.seeded, false);
    assert.ok(/^exception/.test(r.reason), `reason was ${r.reason}, expected exception:*`);
    assert.strictEqual(h.balance, 0, 'no credits landed');
    legs += 1; console.log('  ok  an RC failure leaves the row UNLANDED and grants nothing');
  }

  // 15. THE RETRY LANDS EXACTLY ONCE, and a third pass grants nothing.
  {
    const h = harness({ creditThrows: true });
    await credseedRun(h, UID);                       // pass 1: RC fails
    h.deps.credit = harness().deps.credit;           // (rebind below instead)
    legs += 0;
    // Rebuild with the SAME table so the retry sees the unlanded row, and let RC
    // succeed this time. This is the retry the live path performs on its next
    // call, driven rather than described.
    const h2 = harness({ creditThrows: false });
    for (const [k, v] of h.table) h2.table.set(k, v);
    const r2 = await credseedRun(h2, UID);
    const row2 = h2.table.get(`${UID}|${seed.SEED_PERIOD}`);
    assert.strictEqual(h2.calls.insert, 0,
      'the retry must NOT insert again — the PK is the one-shot gate and a second '
      + 'insert would mean the claim was lost');
    assert.deepStrictEqual(h2.calls.credit, [credits.TIER_ALLOWANCE.pro],
      `the retry must credit the Pro allowance exactly once, got ${JSON.stringify(h2.calls.credit)}`);
    assert.strictEqual(row2.provider_ok, true, 'the retry must land the row');
    assert.strictEqual(row2.amount, credits.TIER_ALLOWANCE.pro);
    assert.strictEqual(row2.balance_before, 0);
    assert.strictEqual(r2.seeded, true);
    assert.strictEqual(h2.balance, credits.TIER_ALLOWANCE.pro);

    // A THIRD PASS. The row is landed, so decideSeed skips and nothing is spent.
    const before = h2.calls.credit.length;
    const r3 = await credseedRun(h2, UID);
    assert.strictEqual(r3.reason, 'already_landed');
    assert.strictEqual(h2.calls.credit.length, before,
      'a landed row must never credit again — EXACTLY ONCE is the whole property');
    legs += 1; console.log('  ok  the retry lands exactly once, and a third pass grants nothing');
  }

  // 16. A FAILED READ MUST NOT GRANT, and the never-granted shape is refused
  //     rather than spent against.
  {
    const h = harness({ readError: 'connection reset' });
    const r = await credseedRun(h, UID);
    assert.strictEqual(r.reason, 'seed_read_failed');
    assert.strictEqual(h.calls.credit.length, 0,
      'a read we could not make must never become a grant — absence and failure '
      + 'are different, and only one of them may spend');
    assert.strictEqual(h.calls.insert, 0);

    // And an unlanded row whose balance ALREADY equals the allowance credits 0.
    // This is why a retry is safe with no idempotency key from RevenueCat: the
    // delta comes from the live balance, so a credit that actually succeeded but
    // failed to be marked lands nothing on the retry.
    const h2 = harness({ startBalance: credits.TIER_ALLOWANCE.pro });
    h2.table.set(`${UID}|${seed.SEED_PERIOD}`,
      { provider_ok: false, amount: 0, balance_before: null });
    const r2 = await credseedRun(h2, UID);
    assert.strictEqual(r2.granted, 0,
      'a retry against a balance that is already full must grant NOTHING');
    assert.strictEqual(h2.calls.credit.length, 0);
    assert.strictEqual(h2.table.get(`${UID}|${seed.SEED_PERIOD}`).provider_ok, true,
      'and it must still mark the row landed, or the account retries forever');
    legs += 1; console.log('  ok  a failed read never grants, and a full balance credits nothing');
  }

  console.log(`__smoke_credit_seed: ${legs}/16 legs green`);
  assert.strictEqual(legs, 16, `expected 16 legs, ran ${legs}`);
})().catch((e) => {
  console.error(`__smoke_credit_seed FAILED: ${e && e.message}`);
  process.exit(1);
});

function credseedRun(h, uid) {
  return seed.runSeed({ userId: uid, profileRow: COMP, deps: h.deps,
                        log: { log() {}, error() {} } });
}


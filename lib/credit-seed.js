'use strict';

// ── CREDIT SEED — the allowance for accounts RevenueCat will never grant ─────
//
// WHY THIS EXISTS, AND WHY IT IS NOT THE FREE ROLL.
//
// lib/free-credits.js grants the monthly free allowance to FREE users. It skips
// paid tiers on a sound rule: a paid tier's allowance comes from RevenueCat's
// recurring virtual-currency grant, which fires at purchase and at each renewal,
// and topping a Pro up to the free 10 would REPLACE 200 with 10.
//
// THE RULE HAS A HOLE AND THE HOLE IS NAMED IN lib/credits.js ALREADY:
//
//     "a comped account with tier='free' and a NULL pro_until is fully paid
//      everywhere in this server ... because the free monthly roll also skips
//      them (isPaid -> skip('paid_tier')) and they have no subscription to
//      renew, they are the one cohort that would sit at zero FOREVER once the
//      debit arms."
//
// That comment was written and the cohort was never served. MEASURED
// 2026-09-25 on the live table: 10 profiles are entitled by US and unknown to
// RevenueCat (rc_product_id IS NULL AND rc_app_user_id IS NULL) — 7 comp_pro,
// 3 pro_until-only — and ZERO of the 10 has ever had a free_credit_periods row.
// Two of them are the demo accounts.
//
// THE SYMPTOM IS A BLANK, NOT A ZERO, which is why it went unseen. RC omits a
// currency with no transactions from GET /virtual_currencies, so getBalance
// returns found:false, and a client that renders a number only on found:true
// renders nothing at all.
//
// ── WHY THE IDEMPOTENCY KEY IS A ROW AND NOT A HEADER ───────────────────────
//
// lib/credits.js states the constraint outright: "IDEMPOTENCY KEYS ARE NOT
// DOCUMENTED on this endpoint. So exactly-once cannot come from RC and MUST
// come from our claim marker." The free roll already solved this — the
// free_credit_periods (user_id, period) PRIMARY KEY is the one-shot gate, and
// provider_ok records whether the money actually landed.
//
// So the seed reuses that table with a RESERVED period key rather than
// inventing a second mechanism:
//
//     free_credit_periods(user_id, 'comp-seed', amount, balance_before,
//                         provider_ok)
//
// That buys, for free, every property this seed needs and none of which would
// be right first time in new code:
//   - EXACTLY ONCE, forever, enforced by the existing primary key. Two
//     concurrent boots race; one inserts, the loser takes the duplicate-key
//     error and grants nothing.
//   - THE LANDED FLAG. provider_ok is written only after RC returns 2xx, so a
//     credit that failed leaves a queryable row rather than nothing.
//   - RETRY ON UNLANDED, with no double-grant risk, because the amount is
//     computed from the LIVE balance at retry time (topUpDelta), so a retry
//     after a credit that actually succeeded computes 0.
//   - NO MIGRATION. `period` is text and the table is live.
//
// THE RESERVED KEY MUST NOT COLLIDE WITH A REAL MONTH. periodKey() returns
// 'YYYY-MM'; 'comp-seed' cannot be produced by it, and assertSeedPeriodDistinct
// below proves that rather than asserting it in a comment. If the two ever
// collided, the seed would consume a user's monthly grant slot — and the
// symptom would be a missing monthly top-up, a month later, on ten accounts
// nobody is watching.

const SEED_PERIOD = 'comp-seed';

/**
 * The key Zac named for this path: `comp-seed:<user_id>`.
 *
 * It is not sent to RevenueCat — RC documents no idempotency key on the
 * transactions endpoint — it is the (user_id, period) row this seed claims,
 * spelled out. Present as a function so the log line and the row can never
 * drift apart, and so a reader looking for the key Zac specified finds it.
 */
function seedKey(userId) {
  return `${SEED_PERIOD}:${userId}`;
}

/**
 * Proof, not assertion, that the reserved key cannot be a calendar period.
 *
 * Driven by the smoke over the real periodKey. A comment claiming two
 * namespaces are disjoint is exactly the kind of note this repo has learned to
 * distrust — "a stale comment is read as fact by the next person, including the
 * person who wrote it".
 */
function assertSeedPeriodDistinct(periodKeyFn) {
  // Every month boundary for a decade either side of today, plus today.
  for (let y = 2020; y <= 2040; y += 1) {
    for (let m = 0; m < 12; m += 1) {
      if (periodKeyFn(new Date(Date.UTC(y, m, 1))) === SEED_PERIOD) {
        throw new Error(`SEED_PERIOD ${SEED_PERIOD} collides with a calendar period`);
      }
    }
  }
  return true;
}

/**
 * Is this account one RevenueCat will never grant to?
 *
 * Returns a STATE and a REASON, never a bare boolean, because the three answers
 * are acted on differently and a bool collapses two of them:
 *
 *   { seed: false, reason: 'not_entitled'    } — a free user. The monthly roll
 *                                               owns them; do not touch.
 *   { seed: false, reason: 'provider_grants' } — RevenueCat knows this account
 *                                               and grants it on renewal.
 *                                               SEEDING WOULD DOUBLE-GRANT.
 *   { seed: false, reason: 'unreadable'      } — no row. Cannot ask, so do not
 *                                               spend. Fail closed on a money
 *                                               path.
 *   { seed: true,  reason: 'entitled_by_us'  } — paid by our own hand, unknown
 *                                               to RC, will never be granted.
 *
 * BOTH RC COLUMNS MUST BE EMPTY, not just rc_product_id. A subscriber whose
 * purchase has landed but whose webhook has not yet written rc_product_id is
 * momentarily indistinguishable from a comp on that column alone — and RC WILL
 * grant them at purchase, so seeding them adds 200 on top. rc_app_user_id is
 * written by the entitlement sync the client calls right after a purchase, so
 * requiring both empty means "RevenueCat has never seen this account at all",
 * which is the property that actually justifies the grant.
 *
 * `isUserPro` is passed in rather than required here so this module stays pure
 * and the caller cannot end up with a second definition of "paid".
 */
function seedNeed(profile, isUserPro) {
  if (!profile) return { seed: false, reason: 'unreadable' };
  if (typeof isUserPro !== 'function') {
    throw new Error('seedNeed requires the isUserPro predicate');
  }
  if (!isUserPro(profile)) return { seed: false, reason: 'not_entitled' };
  const hasProduct = Boolean(String(profile.rc_product_id || '').trim());
  const hasRcUser = Boolean(String(profile.rc_app_user_id || '').trim());
  if (hasProduct || hasRcUser) return { seed: false, reason: 'provider_grants' };
  return { seed: true, reason: 'entitled_by_us' };
}

/**
 * What to do with the seed row this account already has, or does not.
 *
 * Deliberately the same shape and the same three answers as
 * free-credits.decidePeriodGrant, because it is the same problem: a row that
 * exists without the money having landed must RETRY, and a row that landed must
 * never grant again.
 *
 * `row` is the free_credit_periods row for (user_id, SEED_PERIOD) or null.
 * CALLERS MUST DISTINGUISH A NULL ROW FROM A FAILED READ before calling — a
 * failed read arriving here as null reads as 'seed' and grants a second time.
 * Same rule, same reason, as the free roll: only the caller can see the error.
 */
function decideSeed({ row }) {
  if (!row) return { action: 'seed', reason: 'never_seeded' };
  if (row.provider_ok === true) return { action: 'skip', reason: 'already_landed' };
  return { action: 'retry', reason: 'seeded_not_landed' };
}

/**
 * THE SEED, AS A DRIVABLE FUNCTION.
 *
 * HOISTED OUT OF server.js ON PURPOSE, and the reason is a standing rule here:
 * "a rule that lives inside a dispatch cannot be driven by a check — hoist it,
 * or the check tests a copy." The first version of this lived inline in
 * server.js, which cannot be imported without starting a listener, so the only
 * available check was source ORDER — `provider_ok: true` appears after
 * `_credits.credit(...)`. That proves the lines are in that order. It does NOT
 * prove that an RC failure leaves the row unlanded, and it does not prove that
 * the retry credits exactly once, which is what Zac asked to be RED-proven.
 *
 * So every side effect arrives as an injected dependency and the whole sequence
 * can be run against a failing RevenueCat in a test. server.js supplies the real
 * implementations and adds nothing — if it added a rule, that rule would be
 * unchecked again.
 *
 * deps:
 *   readSeedRow(userId, period)   -> { row } | { error }   never throws
 *   insertSeedRow(userId, period) -> { error } | {}        PK collision = error
 *   markLanded(userId, period, { amount, balanceBefore }) -> { error } | {}
 *   getBalance(userId)            -> { balance, found }    may throw
 *   credit(userId, amount)        -> any                   THROWS on non-2xx
 *   isPro(profile)                -> boolean
 *   creditTierFor(profile)        -> 'free' | 'pro' | 'max'
 *   tierAllowance                 -> { free, pro, max }
 *   rcHealthy                     -> boolean
 *
 * NEVER THROWS. Every call site is on a path a user is waiting on.
 */
async function runSeed({ userId, profileRow, deps, log = console } = {}) {
  const skip = (reason) => ({ granted: 0, reason, seeded: false });
  try {
    if (!userId) return skip('no_user');
    if (!deps) return skip('no_deps');
    // Never write to a project we have not reached. A set key is not a working
    // key, and the seed must not learn that by spending.
    if (deps.rcHealthy !== true) return skip('rc_unreachable');

    const need = seedNeed(profileRow, deps.isPro);
    if (!need.seed) return skip(need.reason);

    // ONE DEFINITION OF THE ALLOWANCE, injected rather than restated: the same
    // creditTierFor that /api/credits/balance reports from and
    // scripts/grant-credits.js deposits against. A third derivation is how a
    // user comes to be told 200 while holding 10.
    const tier = deps.creditTierFor(profileRow);
    const allowance = (deps.tierAllowance || {})[tier];
    if (!Number.isInteger(allowance) || allowance <= 0) {
      return skip(`no_allowance_for_tier:${tier}`);
    }

    const read = await deps.readSeedRow(userId, SEED_PERIOD);
    if (read && read.error) {
      // FAIL CLOSED, and this is the dangerous direction: a failed read reads as
      // "no row", which decides 'seed', which grants a SECOND time. decideSeed
      // refuses to accept a null it cannot distinguish from an error, so the
      // distinction has to be made here, where the error is visible.
      log.error('[credit-seed] seed-row read FAILED — refusing to grant');
      return skip('seed_read_failed');
    }

    const decision = decideSeed({ row: (read && read.row) || null });
    if (decision.action === 'skip') return skip(decision.reason);

    // CLAIM BEFORE CREDITING. The (user_id, period) PK is the one-shot gate: two
    // passes race, one inserts, the loser takes the duplicate-key error and
    // grants nothing. provider_ok=false means the row exists before the money
    // does, so a credit that fails is a QUERYABLE ROW rather than silence.
    if (decision.action === 'seed') {
      const ins = await deps.insertSeedRow(userId, SEED_PERIOD);
      if (ins && ins.error) return skip('seed_claim_lost');
    }

    // TOP UP TO, NEVER ADD, computed from the LIVE balance. This is what makes
    // retrying an unlanded row safe without an idempotency key RevenueCat does
    // not offer: if the credit actually succeeded last time, the balance already
    // reflects it and the delta is 0.
    const bal = await deps.getBalance(userId);
    const balance = (bal && Number.isFinite(bal.balance)) ? bal.balance : 0;
    const delta = balance >= allowance ? 0 : allowance - balance;

    // THE CREDIT IS THE LAST THING THAT CAN FAIL BEFORE THE ROW IS MARKED
    // LANDED, and it throws on any non-2xx. Nothing below this line runs unless
    // RevenueCat accepted the transaction — that ordering IS the landed flag,
    // and red_proof_credit_seed.js drives a throwing credit to prove the row
    // stays provider_ok=false and the retry then lands exactly once.
    if (delta > 0) await deps.credit(userId, delta);

    const upd = await deps.markLanded(userId, SEED_PERIOD,
      { amount: delta, balanceBefore: balance });
    if (upd && upd.error) {
      // THE MONEY LANDED AND THE MARKER DID NOT. Report it as its own state:
      // the next pass will read provider_ok=false, recompute the delta from the
      // live balance, get 0, and mark it landed with no second grant. Silence
      // here would make a granted account look ungranted forever.
      log.error('[credit-seed] granted but could not mark landed — next pass will reconcile');
      return { granted: delta, reason: 'landed_unmarked', seeded: true,
               tier, allowance, balance_before: balance,
               balance_after: balance + delta, found_before: !!(bal && bal.found) };
    }

    log.log('  [credit-seed] %s tier=%s allowance=%s granted=%s balance_before=%s balance_after=%s found_before=%s customer_absent=%s',
      seedKey(String(userId).slice(0, 8)), tier, allowance, delta,
      balance, balance + delta, !!(bal && bal.found), !!(bal && bal.customerAbsent));
    return { granted: delta, reason: decision.reason, seeded: true,
             tier, allowance, balance_before: balance,
             balance_after: balance + delta, found_before: !!(bal && bal.found) };
  } catch (e) {
    // A FAILURE MUST CARRY ITS EVIDENCE. The first live run printed
    //   [credit-seed] seed failed (non-fatal): RC_ERROR
    // twice, and RC_ERROR spans 401, 404, 429 and every 5xx — so the log could
    // not distinguish "this customer does not exist" (fixable, and the actual
    // cause) from "RevenueCat is down" (wait). lib/credits.js already puts
    // `status` and `rcMessage` on the error; not printing them made the next run
    // the debugger.
    const _st = e && e.status ? ` status=${e.status}` : '';
    const _msg = e && e.rcMessage ? ` rc="${String(e.rcMessage).slice(0, 120)}"` : '';
    log.error('[credit-seed] seed failed (non-fatal): %s%s%s',
      (e && (e.code || e.message)) || 'unknown', _st, _msg);
    return skip(`exception:${(e && (e.code || e.message)) || 'unknown'}`
      + (e && e.status ? `_${e.status}` : '').slice(0, 60));
  }
}

module.exports = {
  SEED_PERIOD,
  seedKey,
  assertSeedPeriodDistinct,
  seedNeed,
  decideSeed,
  runSeed,
};

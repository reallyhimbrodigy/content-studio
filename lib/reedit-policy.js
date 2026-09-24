'use strict';
// THE RE-EDIT DECISION, AS A FUNCTION THE ROUTE CALLS.
//
// Module level and PURE so a test can drive it. A rule that lives inline in a
// route handler can only be exercised by reimplementing it, and then the test
// proves the reimplementation while the shipped path goes untested — already
// paid for twice in this repo (spec_shortfall, the re-edit merge).
//
// ── THE THREE RULES ────────────────────────────────────────────────────────
//   FREE      402 pro_required. Free has no re-edit at all, so the cap is
//             never consulted — a free user is refused BEFORE the count is
//             read, because "you have used 10 of 10" tells them a limit
//             applies to them that does not.
//   PRO/MAX   0 credits up to the cap, then a normal edit's price.
//   ALWAYS    a new version row; the parent is never mutated.
//
// ── THE CAP IS CONFIG AND ITS ABSENCE IS NOT ZERO ──────────────────────────
// A missing or unreadable cap falls back to DEFAULT_CAP, never to 0. Zero
// would mean "every re-edit is charged" and would arrive silently the first
// time the config read failed — charging users because a row could not be
// read is the expensive direction to be wrong in.

const DEFAULT_CAP = 10;
const PAID_TIERS = new Set(['pro', 'max']);

// ── THE SCOPE IS PER ROOT VIDEO ──────────────────────────────────────────
// Not per day and not per account. capFrom() reads `per_video` off the flag,
// and `used` is re-edits already COMPLETED for this video — so ten included
// re-edits means ten on THIS video, and a new video starts again at zero.
// Named as a constant because it travels to the client in the 402 body and
// the client renders its copy from it: a scope the server means and the
// client guesses is two products.
const SCOPE = 'video';

// THE PRICE COMES FROM THE TABLE, NEVER FROM THIS ROUTE. Zac 2026-09-24:
// "It comes from the same pricing table as every other price, never a
// constant inside the route." lib/credit-prices.json is generated from
// credit_prices.py in the worker lane, and smoke_credit_prices L9 asserts the
// two agree — so a price moved on one side cannot be quoted from the other.
//
// A MISSING PRICE IS NOT ZERO. If the table cannot answer, the quote is
// UNKNOWN and the caller must not charge — quoting 0 for a price we could not
// find gives the work away and nothing ever surfaces it, which is the same
// shape as a rate rounded down.
function postCapPrice(table = null) {
  let t = table;
  if (!t) {
    try { t = require('./credit-prices.json'); } catch (_) { t = null; }
  }
  const row = t && t.our_prices && t.our_prices.reedit_post_cap;
  const n = row && Number(row.credits);
  return Number.isFinite(n) && n >= 0
    ? { price: n, state: 'MEASURED', why: row.why || null }
    : { price: null, state: 'ABSENT',
        why: 'lib/credit-prices.json has no our_prices.reedit_post_cap — '
             + 'regenerate it from credit_prices.py' };
}

/** -> a positive integer cap. Never 0 from an absent value. */
function capFrom(flagValue) {
  const n = flagValue && typeof flagValue === 'object'
    ? Number(flagValue.per_video) : Number(flagValue);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CAP;
}

/**
 * -> { allow, charge, reason, cap, used } or a 402/409 shape.
 *
 * `used` is re-edits ALREADY COMPLETED for this video. In-flight is handled
 * by the database, not here — see conflictFrom().
 */
function decideReedit({ tier, used, capValue, now }) {
  const t = String(tier || '').toLowerCase();
  // FREE IS REFUSED BEFORE THE COUNT IS READ.
  if (!PAID_TIERS.has(t)) {
    return { allow: false, status: 402, error: 'payment_required',
             reason: 'pro_required', actions: ['upgrade'] };
  }
  const cap = capFrom(capValue);
  const n = Number.isInteger(used) && used >= 0 ? used : 0;
  if (n < cap) {
    return { allow: true, charge: 0, reason: 'within_free_reedits', cap, used: n,
             remaining: cap - n };
  }
  // PAST THE CAP IS NOT A REFUSAL. It is a price, and the caller quotes it the
  // same way it quotes any edit — a re-edit that costs money is still a
  // re-edit, and 402ing here would end the path at ten.
  const p = postCapPrice();
  return { allow: true, charge: p.price, chargeState: p.state,
           reason: 'cap_reached', cap, used: n, remaining: 0 };
}

/**
 * THE 402 BODY, exactly as Zac specified it 2026-09-24: reason, scope,
 * included, used, price, balance. The client renders its copy from these
 * fields — so every one of them is a fact the server knows, and none of them
 * is copy.
 *
 * NO `message`. This contract exists because the client owns the wording; a
 * server-side sentence here would be a second authority saying the same thing
 * slightly differently, and the two would drift.
 *
 * BALANCE IS A NUMBER OR null, AND null MEANS WE DID NOT READ IT — not zero.
 * RevenueCat deducts atomically and does not report a balance on its 422, so
 * there are real paths where the server never learns it. Rendering an unknown
 * balance as 0 tells a user they have nothing when they may have plenty; that
 * is the confident-zero mistake, told to the customer.
 */
function capRefusalBody({ decision, balance = null } = {}) {
  const d = decision || {};
  const p = Number.isFinite(d.charge) ? d.charge : postCapPrice().price;
  return {
    reason: d.reason || 'cap_reached',
    scope: SCOPE,
    included: Number.isInteger(d.cap) ? d.cap : DEFAULT_CAP,
    used: Number.isInteger(d.used) ? d.used : 0,
    price: Number.isFinite(p) ? p : null,
    // `balance == null` FIRST. Number(null) is 0 and Number.isFinite(0) is
    // true, so the obvious spelling renders an unread balance as ZERO — the
    // exact mistake the paragraph above this function warns about, two lines
    // below it. Written wrong, then caught by printing the output instead of
    // reasoning about it.
    balance: (balance == null || !Number.isFinite(Number(balance)))
      ? null : Number(balance),
  };
}

/**
 * Translate the serialization constraint into an answer the client can act on.
 *
 * THE DATABASE IS THE GATE, and this only names what it said. Postgres reports
 * a partial-unique violation as 23505; PostgREST surfaces it with that code.
 * Returning 500 for it would read as an outage for a condition that is
 * ORDINARY — the user tapped twice, or two tabs are open.
 */
function conflictFrom(error) {
  const code = String((error && (error.code || error.status)) || '');
  const msg = String((error && error.message) || '');
  const isDup = code === '23505'
    || /duplicate key|unique constraint/i.test(msg);
  if (!isDup) return null;
  const mine = /one_inflight_reedit_per_project/i.test(msg)
    || /video_jobs_one_inflight/i.test(msg);
  return {
    status: 409,
    error: 'reedit_in_flight',
    // NAMED ONLY WHEN THE INDEX NAME CONFIRMS IT. A different unique
    // violation on the same insert is NOT "a re-edit is already running" —
    // saying so would send someone to wait for a render that is not there.
    reason: mine ? 'one_reedit_at_a_time' : 'conflict',
    retryable: true,
  };
}

module.exports = { decideReedit, capFrom, conflictFrom, capRefusalBody,
                   postCapPrice, DEFAULT_CAP, PAID_TIERS, SCOPE };

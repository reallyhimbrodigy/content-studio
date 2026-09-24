'use strict';
// WHICH PIPELINE DOES THIS JOB GO TO, AND WHY.
//
// Zac 2026-09-24: "A job goes to the ChatCut path only when the state is OK
// and the balance is above the reserve. Otherwise it goes to the existing
// pipeline, and the job row records why. A customer job never fails because of
// our credit or plan state. UNKNOWN routes to the existing pipeline, never to
// ChatCut on a guess."
//
// THE SIZE OF THE PROBLEM, in his words: at August's volume, 2,000 credits
// last DAYS, not a month. So the fallback is not an edge case to be tidy
// about — it is the normal operating mode once the pool runs down, and it has
// to be invisible to the customer.
//
// ── THIS MODULE NEVER THROWS AND NEVER REFUSES ───────────────────────────
// It returns a ROUTE, always. Every failure it can have — B1's endpoint down,
// a malformed body, a stale record, a missing secret — resolves to the
// existing pipeline with a reason attached. A guard that can fail a customer
// job to protect our credit balance has inverted the thing it is protecting.
//
// ── FOUR REASONS, AND UNKNOWN IS ITS OWN ─────────────────────────────────
//   chatcut            OK and funded — the only route to ChatCut
//   chatcut_low_credits  OK, but at or below the reserve
//   chatcut_inactive     the account is not in a state that can spend
//   chatcut_unknown      we could not find out, for ANY reason
//
// UNKNOWN IS NOT INACTIVE AND NOT LOW. Folding it into either would make an
// outage in B1's publisher read as a fact about the account — and the whole
// reason a state is returned instead of a number is that "we could not
// measure" and "we measured zero" are different answers. B1's own service
// already holds this line: a STALE record reports UNKNOWN and refuses to hand
// back the balance it is holding.

// The floor we do not spend below. NOT a ruled constant — I picked it, and it
// is the one number in this file Zac should overrule if it is wrong. It exists
// so the pool cannot be drained to exactly zero mid-job, which would turn a
// routing decision into a mid-render failure.
const DEFAULT_RESERVE = 500;

const ROUTE_CHATCUT = 'chatcut';
const ROUTE_EXISTING = 'existing';

function reserveFrom(env = process.env) {
  const n = Number(env.CHATCUT_CREDIT_RESERVE);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RESERVE;
}

/**
 * -> { route, reason, state, balance, reserve }
 *
 * `status` is B1's account_status body: { state, burn, alerts, ... }. Anything
 * else — null, a string, a rejected fetch's absence — is UNKNOWN.
 *
 * THE BALANCE IS READ FROM THE RECORD, NOT ASSUMED PRESENT. B1's service
 * withholds it on a stale record precisely so a caller cannot route on a
 * number that is no longer true, so a missing balance on an otherwise-OK
 * record is UNKNOWN, not zero. `balance` null + route to ChatCut would be the
 * confident-zero mistake with money attached.
 */
function decideRoute(status, { env = process.env, reserve = null } = {}) {
  const res = reserve == null ? reserveFrom(env) : reserve;
  const out = (route, reason, extra = {}) => ({
    route, reason, reserve: res, state: null, balance: null, ...extra,
  });

  if (!status || typeof status !== 'object') {
    return out(ROUTE_EXISTING, 'chatcut_unknown');
  }
  const state = typeof status.state === 'string' ? status.state.toUpperCase() : null;
  if (!state) return out(ROUTE_EXISTING, 'chatcut_unknown');

  // Everything that is not an explicit OK routes away. An allowlist, not a
  // denylist: a state name we have never seen must not fall through to
  // ChatCut because nobody thought to list it.
  if (state !== 'OK') {
    const reason = state === 'UNKNOWN' || state === 'STALE'
      ? 'chatcut_unknown' : 'chatcut_inactive';
    return out(ROUTE_EXISTING, reason, { state });
  }

  const balance = Number(status.balance ?? status.credits ?? NaN);
  if (!Number.isFinite(balance)) {
    // OK but no readable balance. We cannot tell whether it is above the
    // reserve, so we do not guess in the direction that spends money.
    return out(ROUTE_EXISTING, 'chatcut_unknown', { state });
  }
  if (balance <= res) {
    return out(ROUTE_EXISTING, 'chatcut_low_credits', { state, balance });
  }
  return out(ROUTE_CHATCUT, 'chatcut', { state, balance });
}

/**
 * Ask B1's service, and turn EVERY failure into UNKNOWN rather than an error.
 *
 * The deadline is short and deliberate: this sits on the render door, and a
 * slow answer about our own credit balance must never become the customer's
 * latency. A timeout is UNKNOWN, which routes to the pipeline that has always
 * worked.
 */
async function fetchAccountStatus({ url = process.env.CHATCUT_ACCOUNT_STATUS_URL,
  secret = process.env.CHATCUT_ACCOUNT_STATUS_SECRET,
  timeoutMs = 2000, fetchImpl = fetch, log = console } = {}) {
  if (!url) return { status: null, why: 'no_url' };
  try {
    const headers = { 'content-type': 'application/json' };
    if (secret) headers['x-promptly-secret'] = secret;
    const r = await fetchImpl(url, {
      method: 'POST', headers, body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r || !r.ok) return { status: null, why: `http_${r && r.status}` };
    const body = await r.json();
    return { status: body, why: 'ok' };
  } catch (e) {
    log.warn('[chatcut-route] account_status unavailable — routing to the existing '
      + `pipeline: ${(e && e.message) || 'unknown'}`);
    return { status: null, why: `error:${((e && e.message) || 'unknown').slice(0, 60)}` };
  }
}

module.exports = {
  decideRoute, fetchAccountStatus, reserveFrom,
  DEFAULT_RESERVE, ROUTE_CHATCUT, ROUTE_EXISTING,
};

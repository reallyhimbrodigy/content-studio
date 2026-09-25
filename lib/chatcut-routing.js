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

// ── TWO FLOORS, NOT ONE (Zac 2026-09-24) ─────────────────────────────────
//
// A NEW video has a fallback: the existing pipeline can serve it, so stopping
// at 500 costs the customer nothing.
//
// A RE-EDIT OF A CHATCUT-MADE VIDEO HAS NO FALLBACK. This repo already settled
// the principle for the handler/agentic split: a re-edit INHERITS the parent's
// `pipeline` as a stored fact, deliberately, because "re-resolving would let a
// job created under one route be re-edited under another the moment the flag
// flipped, handing an agentic plan to handler or the reverse." A ChatCut
// project can only be re-edited in ChatCut, for exactly that reason. So the
// new-job reserve must not refuse it — it continues down to a hard floor.
const DEFAULT_REEDIT_FLOOR = 50;

const ROUTE_CHATCUT = 'chatcut';
const ROUTE_EXISTING = 'existing';
// BELOW THE HARD FLOOR THERE IS NOWHERE TO SEND IT. Routing a ChatCut re-edit
// to the existing pipeline would hand handler a plan it cannot read, which is
// worse than refusing: the customer gets a wrong edit instead of an honest no.
// So the third route is NONE, and it PAGES — an empty pool that is silently
// turning away paying re-edits is an outage wearing a routing decision's
// clothes.
const ROUTE_NONE = 'none';

function reserveFrom(env = process.env) {
  const n = Number(env.CHATCUT_CREDIT_RESERVE);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RESERVE;
}

function reeditFloorFrom(env = process.env) {
  const n = Number(env.CHATCUT_REEDIT_FLOOR);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_REEDIT_FLOOR;
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
function decideRoute(status, { env = process.env, reserve = null,
  isChatcutReedit = false, reeditFloor = null } = {}) {
  // WHICH FLOOR APPLIES IS DECIDED BY WHETHER THERE IS A FALLBACK, not by the
  // job's name. A re-edit of an OLD-pipeline video is an ordinary job here: the
  // existing pipeline made it and can re-edit it, so it takes the 500.
  const newRes = reserve == null ? reserveFrom(env) : reserve;
  const reRes = reeditFloor == null ? reeditFloorFrom(env) : reeditFloor;
  const res = isChatcutReedit ? reRes : newRes;
  // A ChatCut re-edit has nowhere else to go, so its "away" is NONE, not the
  // existing pipeline.
  const away = isChatcutReedit ? ROUTE_NONE : ROUTE_EXISTING;
  const out = (route, reason, extra = {}) => ({
    route, reason, reserve: res, floorKind: isChatcutReedit ? 'reedit' : 'new',
    // PAGE ONLY WHEN A CUSTOMER IS ACTUALLY TURNED AWAY. A new video that
    // falls back is invisible to the customer and must not wake anyone; a
    // ChatCut re-edit that cannot run is an outage.
    page: route === ROUTE_NONE,
    state: null, balance: null, ...extra,
  });

  if (!status || typeof status !== 'object') {
    return out(away, 'chatcut_unknown');
  }
  const state = typeof status.state === 'string' ? status.state.toUpperCase() : null;
  if (!state) return out(away, 'chatcut_unknown');

  // Everything that is not an explicit OK routes away. An allowlist, not a
  // denylist: a state name we have never seen must not fall through to
  // ChatCut because nobody thought to list it.
  // ── route_ok IS THE ANSWER WHEN IT IS PRESENT (Zac ruling 1, 2026-09-25) ──
  //
  // "DEGRADED = cancelAtPeriodEnd true with status active: keep routing to
  // ChatCut until period_end minus 24 h, and page so Zac fixes billing.
  // Status not active -> existing pipeline. A cancelling subscription with
  // credits in hand is still a working account, and the old pipeline is a
  // quality cut customers would notice."
  //
  // That decision needs the subscription period and a clock, and both live on
  // B1's side. So he computes it and publishes `route_ok` with `route_why`
  // and `chatcut_until`; re-deriving it here from a period_end I would have to
  // be handed anyway is two implementations of one ruling, and they drift.
  //
  // STILL AN ALLOWLIST: `=== true`, not truthy. A missing field, a string
  // "false", a null — anything that is not the boolean true routes away. He
  // cannot break this by changing the shape; he can only make it conservative.
  // PRESENT, not well-typed. Gating on `typeof === 'boolean'` let a malformed
  // value FALL THROUGH to the state path — route_ok: "true" as a string then
  // routed to ChatCut on state alone, which is the exact inversion of an
  // allowlist. If the field is there at all, it is the answer, and anything
  // that is not the boolean true is a no.
  if ('route_ok' in status) {
    if (status.route_ok !== true) {
      return out(away, status.route_why || 'chatcut_inactive',
        { state, routeWhy: status.route_why || null, chatcutUntil: status.chatcut_until || null });
    }
    // route_ok true still meets the credit floor below — the ruling is about
    // WHETHER the account may route, never about whether it can pay.
  } else if (state !== 'OK' && state !== 'LIVE') {
    const reason = (state === 'UNKNOWN' || state === 'STALE' || state === 'UNREACHABLE')
      ? 'chatcut_unknown' : 'chatcut_inactive';
    return out(away, reason, { state });
  }

  const balance = Number(status.balance ?? status.credits ?? NaN);
  if (!Number.isFinite(balance)) {
    // OK but no readable balance. We cannot tell whether it is above the
    // floor, so we do not guess in the direction that spends money.
    return out(away, 'chatcut_unknown', { state });
  }
  if (balance <= res) {
    // THE REASON NAMES WHICH FLOOR. `chatcut_low_credits` on a new video means
    // "use the other pipeline"; `chatcut_exhausted` on a ChatCut re-edit means
    // "there is no other pipeline and the pool is empty", and those need
    // completely different responses from us.
    return out(away, isChatcutReedit ? 'chatcut_exhausted' : 'chatcut_low_credits',
      { state, balance });
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
// ── THE TIMEOUT IS SIZED TO A COLD CONTAINER, NOT TO A WARM ONE ─────────
//
// It was 2000ms, chosen when this call sat in the job-create path for EVERY
// job. B1 2026-09-25: "a cold container on this image cannot answer in 2s."
// At 2s a cold start reads as a timeout, the guard reads UNKNOWN, and Zac's
// own ruling correctly sends UNKNOWN to the existing pipeline — so the demo
// would route to handler and it would look like the flag did not work. A
// timeout that turns a slow answer into a wrong one is not a safety margin.
//
// IT IS AFFORDABLE NOW BECAUSE THE READ IS LAZY. routeForJob only resolves the
// status for a job the ramp has ALREADY admitted, so at percent 0 with a
// four-account allowlist this is the demo accounts and nobody else. The same
// 5s on every job would be a latency regression; on four accounts it is the
// difference between routing and not.
//
// B1 is setting min_containers=1 on the endpoint, which should make this
// moot — this is the belt for the window before that lands and for the day it
// scales to zero again.
const STATUS_TIMEOUT_MS = 5000;

// ── ONE SECRET, NOT TWO NAMES FOR IT (B1, 2026-09-25) ───────────────────
//
// This read CHATCUT_ACCOUNT_STATUS_SECRET, which is NOT set on this server. B1's
// endpoint compares `x-promptly-secret` against MODAL_CALLBACK_SECRET — a value
// both sides already hold. With the old name unset my call sent NO header at
// all, and his side would have served it as auth OPEN: a silent downgrade
// nobody chose, on the endpoint that gates a spend path.
//
// The dedicated name still WINS when it is set, because the day somebody wants
// to rotate this independently they should be able to. It must then equal
// MODAL_CALLBACK_SECRET or B1's side refuses — recorded here because a fallback
// whose precedence is undocumented is the next person's outage.
async function fetchAccountStatus({ url = process.env.CHATCUT_ACCOUNT_STATUS_URL,
  secret = process.env.CHATCUT_ACCOUNT_STATUS_SECRET
    || process.env.MODAL_CALLBACK_SECRET,
  timeoutMs = STATUS_TIMEOUT_MS, fetchImpl = fetch, log = console } = {}) {
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

/**
 * THE WHOLE DECISION, IN ONE PLACE: ramp, then account guard.
 *
 * THE ORDER IS THE RULING. The ramp answers "are we sending NEW work there at
 * all" and the account guard answers "can that account pay for it". Reversing
 * them would burn an account_status read on every job while the ramp is at 0,
 * and — worse — would let a funded account through a switch that is off.
 *
 * A CHATCUT RE-EDIT SKIPS THE RAMP AND NOT THE GUARD. It cannot run anywhere
 * else, so the ramp must never strand it; but it still spends, so the hard
 * floor still stops it. That is the one combination worth reading twice:
 * kill ON + ChatCut re-edit + funded = ChatCut, deliberately.
 */
async function routeForJob({ userId, isChatcutReedit = false, rampAllows,
  accountStatus = null, env = process.env, log = console } = {}) {
  const ramp = await rampAllows({ userId, isChatcutReedit, log });
  if (!ramp.allowed) {
    // THE RAMP'S "NO" IS NOT THE GUARD'S "NO", and the job row must be able to
    // say which. `routed_by` carries the ramp reason verbatim.
    return { route: ROUTE_EXISTING, reason: ramp.reason, stage: 'ramp',
             rampSource: ramp.source, dbState: ramp.dbState };
  }
  // ── accountStatus MAY BE A THUNK, AND THAT IS WHAT MAKES THE ORDER REAL.
  // The docblock above says reversing ramp and guard "would burn an
  // account_status read on every job while the ramp is at 0". It said so while
  // taking the status as an already-resolved VALUE — which means the caller had
  // to fetch it before calling, so the read happened on every job regardless
  // and the stated property was true of this function and false of the system.
  // A 2 s HTTP call in the job-create path, at percent 0, forever.
  //
  // Passing a function defers it to exactly the branch that needs it. A plain
  // value still works, because every test and the whole existing contract pass
  // one.
  const status = typeof accountStatus === 'function'
    ? await accountStatus() : accountStatus;
  const guard = decideRoute(status, { isChatcutReedit, env });
  return { ...guard, stage: 'guard', rampReason: ramp.reason, rampSource: ramp.source };
}

/**
 * ── RULING 2 (Zac, 2026-09-25), verbatim ────────────────────────────────
 * "Re-edit on a dead session: the server returns a retryable 503, no charge,
 * the client keeps the words with Send live (Frontend's failure state), and
 * it pages. Never a generic failure. The alarms at T-48/24/2 h are what make
 * this rare."
 *
 * A re-edit whose parent ran on ChatCut cannot run anywhere else, so when the
 * session is dead there is no route — and the customer must not be told their
 * edit failed. A 503 with `retryable` is the only shape that leaves their
 * words on screen with Send live; a 402 asks them to pay for our outage and a
 * 500 tells them it is broken.
 *
 * NO CHARGE IS STRUCTURAL, NOT A PROMISE: this returns BEFORE the debit, and
 * there is no path from here to one.
 *
 * -> { status, body, page } or null when the route is fine.
 */
function reeditUnroutable(decision) {
  if (!decision || decision.route !== ROUTE_NONE) return null;
  return {
    status: 503,
    body: {
      // TYPED, and deliberately NOT 'chatcut_exhausted' or a bare error: the
      // client switches on `error` and needs to reach its keep-the-words state
      // rather than any generic failure.
      error: 'reedit_temporarily_unavailable',
      kind: 'reedit',
      retryable: true,
      reason: decision.reason || 'chatcut_unknown',
      // NO price, NO balance, NO videos_limit. Nothing here is about money —
      // putting a number in would invite a paywall on our own outage.
      //
      // THE COPY SPLITS BY CAUSE, because one of these is not transient.
      // A dead or unreachable session is a minutes-long outage and "try again
      // in a moment" is true. An EXHAUSTED credit pool is not: retrying
      // changes nothing until somebody tops it up, and promising a moment
      // would be a sentence we know to be false at the time we send it. Both
      // are ours, both charge nothing, both page — they differ only in what
      // we can honestly tell the customer to do.
      message: decision.reason === 'chatcut_exhausted'
        ? 'Changes to this video are paused while we sort something out on our '
          + 'end. Your changes are saved and nothing has been charged.'
        : 'We could not reach the editor for this video just now. '
          + 'Your changes are saved — try sending again in a moment.',
    },
    // EVERY ONE OF THESE PAGES. A customer turned away because our session
    // died is an outage, and the ruling says so; the T-48/24/2h alarms are
    // what should make it never fire.
    page: true,
  };
}

module.exports = {
  decideRoute, fetchAccountStatus, reserveFrom, reeditFloorFrom, routeForJob,
  reeditUnroutable,
  DEFAULT_RESERVE, DEFAULT_REEDIT_FLOOR,
  ROUTE_CHATCUT, ROUTE_EXISTING, ROUTE_NONE,
};

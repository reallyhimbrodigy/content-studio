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
    // balancePath NAMES WHICH SHAPE ANSWERED, on every outcome. A route that
    // worked because the number was found at an unexpected path is something the
    // next reader needs to see BEFORE it stops working — and a healthy account
    // turned away because the number was NOT found is what cost job 839bd13b.
    state: null, balance: null, balancePath: null, ...extra,
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
    // AN AUTH REFUSAL IS NOT AN INACTIVE ACCOUNT, and it was being reported as
    // one. Measured 2026-09-26: B1's /account_status answers HTTP 200 with
    //   {"state":"REFUSED","auth":"REQUIRED","why":"this container carries a
    //    caller secret and the request did not match it"}
    // to any caller whose secret does not match. That fell into the `else` below
    // and read as `chatcut_inactive` — "the account is not active" — when the
    // truth is "we were not allowed to ask". Those have different owners: one is
    // ChatCut's billing, the other is a secret on our side, and sending someone
    // to the wrong one is the whole cost of a bad label.
    //
    // It routes away either way, so this changes no behaviour — only what the
    // next person reads. Which is the point.
    const refusedForAuth = state === 'REFUSED'
      || String(status.auth || '').toUpperCase() === 'REQUIRED';
    const reason = refusedForAuth ? 'chatcut_refused_auth'
      : ((state === 'UNKNOWN' || state === 'STALE' || state === 'UNREACHABLE')
        ? 'chatcut_unknown' : 'chatcut_inactive');
    return out(away, reason, { state });
  }

  const _bal = readBalance(status);
  const balance = _bal.balance;
  if (!Number.isFinite(balance)) {
    // OK but no readable balance. We cannot tell whether it is above the
    // floor, so we do not guess in the direction that spends money.
    //
    // AND THE REASON NOW SAYS WHICH KIND OF UNKNOWN IT IS. Job 839bd13b came
    // through at 06:45:49Z with why=ok state=LIVE and still fell back as
    // `chatcut_unknown` — the transport was fine, ChatCut said LIVE, and this
    // line turned the job away. Reporting that identically to "we could not
    // reach them" sent the previous four failures' diagnosis back to the network
    // for a problem that was a SHAPE MISMATCH on our side of the seam.
    return out(away, 'chatcut_no_balance', { state, balancePath: null });
  }
  // The path that answered rides every outcome from here, not just the failure:
  // a route that worked because the number was found at an unexpected place is
  // something the next reader needs to see BEFORE it stops working.
  if (balance <= res) {
    // THE REASON NAMES WHICH FLOOR. `chatcut_low_credits` on a new video means
    // "use the other pipeline"; `chatcut_exhausted` on a ChatCut re-edit means
    // "there is no other pipeline and the pool is empty", and those need
    // completely different responses from us.
    return out(away, isChatcutReedit ? 'chatcut_exhausted' : 'chatcut_low_credits',
      { state, balance, balancePath: _bal.path });
  }
  return out(ROUTE_CHATCUT, 'chatcut', { state, balance, balancePath: _bal.path });
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

// ── TWO NUMBERS, AND THEY DO DIFFERENT JOBS ─────────────────────────────────
//
// TTL IS HOW STALE A BALANCE MAY BE BEFORE WE REFUSE TO SPEND ON IT. Past it the
// cached value is NOT served — the guard fails closed onto the existing pipeline.
// It is a ceiling on wrongness, not a cache-eviction convenience.
//
// REFRESH IS HOW OFTEN A BACKGROUND TIMER GOES AND GETS A NEW ONE. It is much
// shorter than the TTL on purpose: at 15s under a 60s ceiling, THREE CONSECUTIVE
// REFRESHES MUST FAIL before routing changes. One blip — a timeout, a cold
// container, a redeploy on B1's side — costs nothing, and a real outage still
// stops us inside a minute. Equal numbers would make every single miss flip the
// route, which is the failure mode the timer exists to avoid.
//
// 60s OF DRIFT CANNOT CARRY THIS ACCOUNT ACROSS THE RESERVE: it moves by about a
// job's cost at a time, and sat at 1868 against a 150 floor. If it ever runs near
// the floor these come down — that is the condition to watch, and it is why both
// are env-overridable rather than baked.
const STATUS_TTL_MS = (() => {
  const n = Number(process.env.CHATCUT_STATUS_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();
const STATUS_REFRESH_MS = (() => {
  const n = Number(process.env.CHATCUT_STATUS_REFRESH_MS);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
})();

// Module-level, so every request this process serves shares one read — which is
// the whole point. Injectable so a check can drive expiry without waiting.
const _statusCache = new Map();

// ── WHY THE LAST FAILURE IS KEPT, NOT JUST THE LAST SUCCESS ─────────────────
//
// When the route fails closed on an empty or stale cache, `why=cache_empty` on its
// own is the same unusable answer `chatcut_unknown` was on job 7eb3df03: it says
// we do not know, from a server that DID find out, in the background, and kept no
// record. So the refresher's outcome is kept beside the value and the fail-closed
// envelope names it — `cache_empty(http_401)` tells you the secret is wrong;
// `cache_empty(no_url)` tells you the var is unset. Same fix as status_why.
const _statusLastFail = new Map();
// SINGLE-FLIGHT. Without this, a burst of jobs on a cold cache each start their
// own refresh — N concurrent calls to a single-container endpoint to answer one
// question. The promise is the lock; it is deleted in a finally so a failed
// refresh cannot wedge the key permanently.
const _statusInFlight = new Map();

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
// THE RESOLUTION MOVED TO lib/chatcut-secret.js, and the reason is job 5af26805:
// this function resolved the secret and its neighbour in agentic-dispatch.js did
// not, so /account_status authenticated and /run_agentic went anonymous to the
// SAME container. Two copies of "which env var holds the caller secret" is how one
// gets updated and the other does not. One resolver now, two callers.
// The parameter stays overridable so checks can drive it explicitly.
async function fetchAccountStatus({ url = process.env.CHATCUT_ACCOUNT_STATUS_URL,
  secret = require('./chatcut-secret').callerSecret(),
  timeoutMs = STATUS_TIMEOUT_MS, fetchImpl = fetch, log = console } = {}) {
  // THE NETWORK READ, AND ONLY THAT. It does not touch the cache and nothing on
  // the job path calls it any more — the refresher does, and /healthz's probe does
  // because a probe that read the cache would be testing the cache and not the
  // endpoint. Keeping it pure is what lets the probe stay honest.
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
 * ── THE BACKGROUND REFRESH. NOTHING ON THE JOB PATH AWAITS THIS. ────────────
 *
 * Zac, 2026-09-26: "cache account_status: short TTL, refresh in the background,
 * fail closed if the cached read is stale or failed. Make the route decision read
 * the cache, not the network."
 *
 * So the ONE call that used to sit in the job-create path now happens on a timer
 * and on a due-but-fresh read, and the route only ever looks at what this left
 * behind. The job path's cost for a route decision goes from an HTTP round trip to
 * a Map lookup.
 *
 * NEVER THROWS AND NEVER REJECTS. It is called without `await` from a timer and
 * from a read; an unhandled rejection there takes the process down on modern Node.
 * Every outcome — including a bad url and a thrown fetch — lands in the cache or
 * the failure record, and the promise resolves.
 *
 * A FAILED REFRESH DOES NOT CLEAR THE VALUE IN HAND. It records the failure and
 * leaves the last good read alone, so a single blip is absorbed by the TTL rather
 * than flipping the route immediately. What a failure can never do is EXTEND that
 * value's life — the TTL is measured from when the read actually happened, so a
 * value stops being servable at a fixed wall-clock age no matter how many refreshes
 * failed after it. That is the fail-closed half, and it is the reason the timestamp
 * is stamped here at fetch time and never touched again.
 */
async function refreshAccountStatus({ url = process.env.CHATCUT_ACCOUNT_STATUS_URL,
  cache = _statusCache, fails = _statusLastFail, inFlight = _statusInFlight,
  now = Date.now, log = console, fetchAccountStatusImpl = fetchAccountStatus,
  ...rest } = {}) {
  const key = `${url}`;
  // SINGLE-FLIGHT: a second caller joins the first call rather than starting one.
  const already = inFlight.get(key);
  if (already) return already;
  const p = (async () => {
    try {
      const env = await fetchAccountStatusImpl({ url, log, ...rest });
      if (env && env.why === 'ok') {
        // STAMPED AT READ TIME. See the docblock: this timestamp is what makes the
        // staleness ceiling real.
        cache.set(key, { at: now(), envelope: { status: env.status, why: 'ok' } });
        fails.delete(key);
      } else {
        // ONLY A GOOD READ IS EVER CACHED. A 401 or a timeout must not become the
        // answer every job gets for the next minute; it becomes the REASON a
        // fail-closed decision can name.
        fails.set(key, { at: now(), why: (env && env.why) || 'unknown' });
      }
      return env;
    } catch (e) {
      // A REFRESHER THAT CAN THROW IS A CRASH ON A TIMER. fetchAccountStatus
      // already catches, so reaching here means something above it broke; it is
      // still recorded as a cause rather than raised.
      fails.set(key, { at: now(), why: `refresh_threw:${((e && e.message) || 'unknown').slice(0, 40)}` });
      return { status: null, why: 'refresh_threw' };
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

/**
 * ── WHAT THE ROUTE READS. SYNCHRONOUS, NO NETWORK, NO await. ────────────────
 *
 * Three outcomes, and each is a STATE rather than a value, because a guard written
 * against the number alone silently accepts the other two — the rule this repo
 * earned on 2026-09-08 and the exact shape of the bug that put job 839bd13b on the
 * handler with a healthy account.
 *
 *   FRESH  -> the status, why=ok, cached=true. The guard decides normally.
 *   STALE  -> status NULL, why=cache_stale(<cause>). Past the ceiling. FAIL CLOSED.
 *   EMPTY  -> status NULL, why=cache_empty(<cause>). Never read, or never landed.
 *             FAIL CLOSED.
 *
 * FAIL CLOSED HERE MEANS THE EXISTING PIPELINE, WHICH ALWAYS WORKS. decideRoute
 * turns a null status into ROUTE_EXISTING, so a cold or broken cache costs a job
 * its ChatCut route and costs the customer nothing. That direction is not
 * negotiable: serving a stale balance is how we would spend against money that is
 * no longer there.
 *
 * AND IT KICKS THE REFRESH WHEN ONE IS DUE — without awaiting it. This is what
 * makes a low-traffic process self-heal: the timer keeps it warm, and a read that
 * finds the value past its refresh age starts the next one for the job after it.
 * The caller's latency is unchanged either way.
 */
function readAccountStatusCached({ url = process.env.CHATCUT_ACCOUNT_STATUS_URL,
  cache = _statusCache, fails = _statusLastFail, now = Date.now,
  ttlMs = STATUS_TTL_MS, refreshMs = STATUS_REFRESH_MS,
  refresh = refreshAccountStatus, log = console, ...rest } = {}) {
  if (!url) return { status: null, why: 'no_url', cached: false };
  const key = `${url}`;
  const hit = cache.get(key);
  const age = hit ? (now() - hit.at) : null;

  // THE CAUSE, FOR WHICHEVER FAIL-CLOSED ANSWER FOLLOWS. A bare cache_empty is
  // 'we do not know' from a process that does know.
  const f = fails.get(key);
  const cause = f ? f.why : 'never_read';

  const due = !hit || age >= refreshMs;
  if (due) {
    // FIRE AND FORGET, WITH A CATCH. No await: the job path must not pay for this.
    // The .catch is not decoration — an unhandled rejection is fatal on Node 18+,
    // and this call site is the one that runs on a customer's request.
    try {
      const p = refresh({ url, cache, fails, now, log, ...rest });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) { /* a refresher that cannot even start must not fail a job */ }
  }

  if (!hit) return { status: null, why: `cache_empty(${cause})`, cached: false };
  if (age >= ttlMs) {
    return { status: null, why: `cache_stale(${cause})`, cached: true, age_ms: age };
  }
  return { ...hit.envelope, cached: true, age_ms: age };
}

/**
 * ── THE TIMER, SO A QUIET PROCESS IS STILL WARM ─────────────────────────────
 *
 * Without this the cache is only ever filled by a read that has already failed
 * closed. For the Sunday demo that is the worst possible shape: jobs arrive minutes
 * apart, so every one of them would find an expired entry, route to the handler,
 * and warm the cache for a job that comes too late to use it. The first job would
 * miss every time — a cache that makes the demo slower AND wrong.
 *
 * unref() SO IT NEVER HOLDS THE PROCESS OPEN. A ref'd interval keeps Node alive
 * through a shutdown and turns a deploy into a hang.
 *
 * IDEMPOTENT: one timer per process. Called twice, the second call is a no-op
 * rather than a second timer doubling the request rate at B1's endpoint.
 */
// THE TIMER LIVES IN A SLOT, NOT A BARE MODULE VARIABLE. A bare one is shared by
// every check in the process, so the second check to call this gets
// already_running and asserts against a state its own leg never created — which is
// how a check ends up testing the order the legs happen to run in. The slot is
// injectable, so each leg gets its own.
const _timerSlot = { timer: null };
function startAccountStatusRefresher({ intervalMs = STATUS_REFRESH_MS,
  url = process.env.CHATCUT_ACCOUNT_STATUS_URL, log = console,
  setIntervalImpl = setInterval, refresh = refreshAccountStatus,
  slot = _timerSlot } = {}) {
  // NO URL IS CHECKED FIRST, and the order is the ruling: "there is no url
  // configured" is a fact about this server, and it must be reported as that
  // whatever else is running. Asking about the timer first would answer a
  // configuration question with a lifecycle one.
  if (!url) return { started: false, why: 'no_url' };
  if (slot.timer) return { started: false, why: 'already_running' };
  const t = setIntervalImpl(() => {
    try {
      const p = refresh({ url, log });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) { /* never let the timer throw into the event loop */ }
  }, intervalMs);
  if (t && typeof t.unref === 'function') t.unref();
  slot.timer = t;
  // PRIME IMMEDIATELY. setInterval's first tick is one full interval away, so
  // without this the process spends its first 15s with an empty cache — and on a
  // deploy that is exactly when the first verification job arrives.
  try {
    const p = refresh({ url, log });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) { /* ignore */ }
  return { started: true, intervalMs };
}

function _statusCacheStateForDisplay({ url = process.env.CHATCUT_ACCOUNT_STATUS_URL,
  cache = _statusCache, fails = _statusLastFail, now = Date.now } = {}) {
  // NO VALUES, NO SECRET, NO URL QUERY — ages and reasons only. This is what
  // /healthz prints so a person can tell a warm cache from a cold one without
  // firing a job.
  const key = `${url}`;
  const hit = cache.get(key);
  const f = fails.get(key);
  return {
    present: !!hit,
    age_ms: hit ? (now() - hit.at) : null,
    ttl_ms: STATUS_TTL_MS,
    refresh_ms: STATUS_REFRESH_MS,
    fresh: !!hit && (now() - hit.at) < STATUS_TTL_MS,
    timer_running: !!_timerSlot.timer,
    last_fail_why: f ? f.why : null,
    last_fail_age_ms: f ? (now() - f.at) : null,
  };
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
 * WHERE THE BALANCE IS, AS AN ORDERED LIST OF DECLARED SHAPES.
 *
 * THIS WAS `Number(status.balance ?? status.credits ?? NaN)` — a top-level read —
 * AND IT TURNED AWAY A HEALTHY ACCOUNT. Job 839bd13b, 2026-09-26 06:45:49Z:
 * why=ok, state=LIVE, route_ok true, and ChatCut holding ~1898 credits, refused
 * because the number was not at the path we looked. A shape mismatch on the one
 * check that decides whether a job may spend.
 *
 * A TOLERANT READER ON A MONEY CHECK IS A HAZARD, so this is not `find any number
 * called balance anywhere`. It is an EXPLICIT, ORDERED list of paths, each of
 * which someone has a reason to expect, and the names are restricted to `balance`
 * and `credits`. A recursive search could pick up `samples`, or an allowance, or
 * some other account's figure, and spend against it.
 *
 * AND IT RETURNS WHICH PATH ANSWERED, which is the part that stops this recurring.
 * `balancePath` reaches the decision, the ring and the printed line, so the day
 * ChatCut moves the field the log says `balancePath=published.balance` one day and
 * `chatcut_no_balance` the next, instead of two identical-looking unknowns.
 *
 * NOT A GUESS AT THE CURRENT SHAPE: the first path that yields a finite number
 * wins and is NAMED, so whichever one is real becomes visible on the first job
 * rather than assumed here.
 */
// MEASURED FROM THE LIVE BODY 2026-09-26 (B1), not guessed. Top-level keys are:
//   account, alerts, auth, burn, chatcut_until, cost_p95_credits, now_ms,
//   published, reserve_credits, route_ok, route_why, session, state, why
// There is NO top-level `balance` and NO top-level `credits`, which is why
// Number(status.balance ?? status.credits ?? NaN) was NaN on a healthy account.
//
// account.balance IS FIRST because it is the one that is real today. The rest are
// tolerance for a shape that moves, ordered so the measured path always wins.
//
// `burn.balance` IS DELIBERATELY ABSENT AND MUST STAY ABSENT. It exists, it holds
// the same number today, and it is the burn-rate calculator's latest sample — a
// SERIES value, not the account's balance. A reader that accepted it would spend
// against a statistic, and the day the series lags or empties it would spend
// against a stale one. This is why the list is explicit rather than a search for
// any key called `balance`: a recursive walk would have found burn.balance too,
// and `samples`, and `cost_p95_credits`.
const BALANCE_PATHS = [
  ['account', 'balance'],
  ['account', 'credits'],
  ['balance'], ['credits'],
  ['published', 'balance'], ['published', 'credits'],
];

function readBalance(status) {
  if (!status || typeof status !== 'object') return { balance: NaN, path: null };
  for (const path of BALANCE_PATHS) {
    let v = status;
    for (const k of path) {
      v = (v && typeof v === 'object') ? v[k] : undefined;
    }
    // STRICT: null, '', true and [] all coerce to a finite Number in JS, and each
    // of them would be a fabricated balance. Only a real number or a numeric
    // string counts.
    if (typeof v === 'number' && Number.isFinite(v)) return { balance: v, path: path.join('.') };
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
      return { balance: Number(v), path: path.join('.') };
    }
  }
  return { balance: NaN, path: null };
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
  refreshAccountStatus, readAccountStatusCached, startAccountStatusRefresher,
  _statusCacheStateForDisplay, STATUS_TTL_MS, STATUS_REFRESH_MS,
  reeditUnroutable,
  DEFAULT_RESERVE, DEFAULT_REEDIT_FLOOR,
  ROUTE_CHATCUT, ROUTE_EXISTING, ROUTE_NONE,
};

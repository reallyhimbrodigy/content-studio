'use strict';
// ── THE ROUTE DECISION MUST NOT TOUCH THE NETWORK ───────────────────────────
//
// WHY THIS FILE EXISTS. Job f7da43ea, 2026-09-26: the dispatch fix was proven —
// it routed and spawned with no 401 — and post_to_dispatch_ms read 3974. Inside
// that, the route decision alone cost 1.41s on job 5af26805, ~0.4s of which was a
// synchronous account_status HTTP call made on every allowlisted job to re-read a
// balance in the thousands against a 150 floor.
//
// Zac, 2026-09-26, verbatim: "Cache account_status: short TTL, refresh in the
// background, fail closed if the cached read is stale or failed. Make the route
// decision read the cache, not the network."
//
// SO THERE ARE TWO PROPERTIES HERE, AND THEY PULL AGAINST EACH OTHER.
//   FAST:   the job path does a Map lookup and never awaits a socket.
//   CLOSED: a value past its ceiling is NOT served, however convenient it is.
// A cache that serves stale money is worse than no cache, because the number it
// serves looks exactly like a good one. Every leg below is about which of those
// two wins in a specific state, and the answer is never "whichever is faster".
//
// THE ONE LEG THAT WOULD HAVE CAUGHT THE WHOLE CLASS is 'no fetch before the
// return' — it counts calls to the fetch impl at the instant the read returns,
// because a cache that quietly awaits a refresh on a miss is indistinguishable
// from the code it replaced except in a timing number nobody reads.

const assert = require('assert');
const R = require('./chatcut-routing');

// ── THE LEGS ARE QUEUED AND AWAITED IN ORDER ────────────────────────────────
//
// The first draft called `legAsync` at the top level without awaiting, so nine
// promises were still pending when the file's final count assertion ran: 3/12,
// reported as a failure. It was right — and the useful part is WHICH shape failed.
// Had the file only asserted per-leg, all nine would have resolved silently after
// the process finished its synchronous work and the file would have printed
// nothing and exited 0: a smoke that runs almost none of its legs and passes.
// The count is what makes an un-awaited leg a failure instead of a no-op.
let legs = 0;
const _queue = [];
const leg = (name, fn) => { _queue.push([name, fn]); };
const legAsync = (name, fn) => { _queue.push([name, fn]); };

const URL = 'https://chatcut.example/account_status';
// B1's MEASURED top-level shape (2026-09-26), not an invented one — the standing
// law, and the exact reason job 839bd13b's guard bug survived a dozen green legs.
const liveBody = () => ({
  state: 'LIVE', route_ok: true, route_why: 'ok', reserve_credits: 150,
  account: { balance: 1868.89 },
  published: { age_h: 0.4 },
});

// A harness that hands back a fresh cache/fails/inFlight triple per leg, plus a
// counting fetch. Shared state across legs is how one leg's cached value silently
// makes the next leg's assertion pass.
function harness({ body = liveBody(), why = 'ok', t0 = 1_000_000 } = {}) {
  const h = {
    cache: new Map(), fails: new Map(), inFlight: new Map(),
    t: t0, calls: 0,
    now: () => h.t,
    advance: (ms) => { h.t += ms; },
    // Stands in for fetchAccountStatus (already-caught envelopes), so the legs
    // exercise the cache layer rather than re-testing the HTTP reader.
    impl: async () => { h.calls += 1; return why === 'ok' ? { status: body, why: 'ok' } : { status: null, why }; },
  };
  h.read = (extra = {}) => R.readAccountStatusCached({
    url: URL, cache: h.cache, fails: h.fails, inFlight: h.inFlight, now: h.now,
    fetchAccountStatusImpl: h.impl, log: { warn() {}, error() {} }, ...extra,
  });
  h.refresh = (extra = {}) => R.refreshAccountStatus({
    url: URL, cache: h.cache, fails: h.fails, inFlight: h.inFlight, now: h.now,
    fetchAccountStatusImpl: h.impl, log: { warn() {}, error() {} }, ...extra,
  });
  return h;
}

legAsync('a warm cache answers with the balance, and says it was cached', async () => {
  const h = harness();
  await h.refresh();
  const r = h.read();
  assert.strictEqual(r.why, 'ok');
  assert.strictEqual(r.cached, true, 'a hit must declare itself cached');
  assert.strictEqual(r.status.account.balance, 1868.89);
  // AND THE GUARD ACTUALLY ROUTES ON IT. A cached envelope that decideRoute cannot
  // read would be a fast wrong answer — the 839bd13b failure with a cache in front.
  assert.strictEqual(R.decideRoute(r.status, { env: {} }).route, 'chatcut');
});

legAsync('the read makes NO fetch before it returns — the job path never waits', async () => {
  const h = harness();
  await h.refresh();               // warm: 1 call
  assert.strictEqual(h.calls, 1);
  h.advance(20_000);               // past refresh (15s), inside TTL (60s)
  const before = h.calls;
  const r = h.read();
  // THE SHAPE CHECK COMES FIRST, AND THE ORDER IS THE POINT. Every assertion below
  // dereferences `r`; if the function were made async, `r` would be a Promise and
  // `r.cached` would be undefined — so the leg failed on "still serves the cache"
  // and the red pointed at the wrong property. A thenable here IS the defect ("the
  // job path awaits a socket"), so it must be named before anything reads a field.
  assert.ok(typeof r.then !== 'function',
    'readAccountStatusCached must not be async — an awaited read is the HTTP call '
    + 'in the job-create path that this whole change removes');
  // THEN: at the instant of return, no new call has been awaited. The refresh this
  // read kicked off is fire-and-forget, so its own fetch may or may not have
  // STARTED, but the caller cannot have waited on it — and the value handed back is
  // the one already in hand.
  assert.strictEqual(r.cached, true, 'a due-but-fresh read still serves the cache');
  assert.strictEqual(r.status.account.balance, 1868.89);
  assert.ok(h.calls - before <= 1, 'a read must start at most one refresh');
});

legAsync('past the TTL the value is NOT served — fail closed, stale is not spendable',
  async () => {
    const h = harness();
    await h.refresh();
    h.advance(R.STATUS_TTL_MS + 1);
    const r = h.read();
    assert.strictEqual(r.status, null,
      'a value past the staleness ceiling must not reach the guard — serving it is '
      + 'how we spend against money that is no longer there');
    assert.ok(/^cache_stale\(/.test(r.why), `why must name the state: ${r.why}`);
    // FAIL CLOSED MEANS THE EXISTING PIPELINE, and that is the property — not
    // merely that the status was null.
    assert.strictEqual(R.decideRoute(r.status, { env: {} }).route, 'existing');
  });

leg('an empty cache fails closed and names why it is empty', () => {
  const h = harness();
  const r = h.read();
  assert.strictEqual(r.status, null);
  assert.strictEqual(r.why, 'cache_empty(never_read)',
    'a bare cache_empty is the 7eb3df03 mistake: "we do not know" from a process '
    + 'that does know');
  assert.strictEqual(r.cached, false);
  assert.strictEqual(R.decideRoute(r.status, { env: {} }).route, 'existing');
});

legAsync('a failed refresh is never cached, and the cause reaches the read',
  async () => {
    const h = harness({ why: 'http_401' });
    await h.refresh();
    assert.strictEqual(h.cache.size, 0, 'a 401 must never become the cached answer');
    const r = h.read();
    assert.strictEqual(r.status, null);
    assert.strictEqual(r.why, 'cache_empty(http_401)',
      'the fail-closed envelope must carry the transport cause, so the log says '
      + '"the secret is wrong" rather than "no value"');
  });

legAsync('a single failed refresh does NOT flip the route — the blip is absorbed',
  async () => {
    const h = harness();
    await h.refresh();                       // one good read
    h.impl = async () => { h.calls += 1; return { status: null, why: 'error:timeout' }; };
    h.advance(R.STATUS_REFRESH_MS + 1);
    await h.refresh();                       // fails
    const r = h.read();
    assert.strictEqual(r.cached, true, 'the last good value survives one failure');
    assert.strictEqual(r.status.account.balance, 1868.89);
    // This is why refresh (15s) is much shorter than TTL (60s): three consecutive
    // failures, not one, before routing changes.
    assert.ok(R.STATUS_REFRESH_MS * 2 <= R.STATUS_TTL_MS,
      `refresh ${R.STATUS_REFRESH_MS}ms must leave room for a retry inside the `
      + `${R.STATUS_TTL_MS}ms ceiling, or every single miss flips the route`);
  });

legAsync('a failed refresh cannot EXTEND a good value past the ceiling', async () => {
  const h = harness();
  await h.refresh();
  h.impl = async () => { h.calls += 1; return { status: null, why: 'error:timeout' }; };
  // Fail repeatedly across the whole TTL. The timestamp is stamped at READ time and
  // never touched again, so the value must die on schedule however many refreshes
  // failed after it. A cache that re-stamped on failure would keep a dead balance
  // alive forever exactly when the endpoint is broken.
  for (let i = 0; i < 6; i += 1) { h.advance(15_000); await h.refresh(); }
  const r = h.read();
  assert.strictEqual(r.status, null, 'failures must not renew the value they failed to replace');
  assert.ok(/^cache_stale\(/.test(r.why), r.why);
});

legAsync('concurrent refreshes collapse to one fetch (single-flight)', async () => {
  const h = harness();
  let release;
  const gate = new Promise((res) => { release = res; });
  h.impl = async () => { h.calls += 1; await gate; return { status: liveBody(), why: 'ok' }; };
  const a = h.refresh(); const b = h.refresh(); const c = h.refresh();
  release();
  await Promise.all([a, b, c]);
  assert.strictEqual(h.calls, 1,
    'a burst of jobs on a cold cache must not each open their own call to a '
    + 'single-container endpoint');
  // AND THE LOCK CLEARS: a wedged in-flight key would freeze the cache forever.
  assert.strictEqual(h.inFlight.size, 0, 'the single-flight lock must be released');
  h.advance(R.STATUS_REFRESH_MS + 1);
  await h.refresh();
  assert.strictEqual(h.calls, 2, 'a later refresh must actually run');
});

legAsync('a refresh that THROWS is recorded, not raised', async () => {
  const h = harness();
  h.impl = async () => { h.calls += 1; throw new Error('socket exploded'); };
  const out = await h.refresh();   // must not reject: it runs on a timer
  assert.strictEqual(out.why, 'refresh_threw');
  assert.strictEqual(h.inFlight.size, 0);
  const r = h.read();
  assert.ok(/refresh_threw/.test(r.why), `the cause must survive: ${r.why}`);
});

leg('the timer is single, unref\'d, and primes immediately', () => {
  let made = 0; let unrefd = 0; let primed = 0;
  const fakeInterval = () => { made += 1; return { unref() { unrefd += 1; } }; };
  const refresh = () => { primed += 1; return Promise.resolve({ why: 'ok' }); };
  const slot = {};   // this leg's own timer slot, so leg order cannot decide the result
  const first = R.startAccountStatusRefresher({ url: URL, setIntervalImpl: fakeInterval, refresh, slot });
  assert.strictEqual(first.started, true);
  assert.strictEqual(made, 1);
  assert.strictEqual(unrefd, 1, 'a ref\'d interval turns a deploy into a hang');
  assert.strictEqual(primed, 1,
    'without an immediate prime the process spends its first interval cold — which '
    + 'is exactly when the post-deploy verification job arrives');
  const second = R.startAccountStatusRefresher({ url: URL, setIntervalImpl: fakeInterval, refresh, slot });
  assert.strictEqual(second.started, false, 'two timers would double the request rate');
  assert.strictEqual(made, 1);
});

leg('with no url configured the timer starts nothing', () => {
  // A server with the feature off must make no outbound calls on a timer.
  let made = 0;
  const r = R.startAccountStatusRefresher({ url: '', slot: {},
    setIntervalImpl: () => { made += 1; return { unref() {} }; } });
  assert.strictEqual(r.started, false);
  assert.strictEqual(r.why, 'no_url');
  assert.strictEqual(made, 0);
});

legAsync('routeForJob end to end: cached status routes to ChatCut with no fetch',
  async () => {
    const h = harness();
    await h.refresh();
    const before = h.calls;
    const d = await R.routeForJob({
      userId: 'u1',
      rampAllows: async () => ({ allowed: true, reason: 'allowlist', source: 'allowlist' }),
      accountStatus: () => h.read().status,
      env: {},
    });
    assert.strictEqual(d.route, 'chatcut');
    assert.strictEqual(d.balancePath, 'account.balance');
    assert.strictEqual(h.calls, before, 'the decision must not have called out');
  });

leg('server.js\'s route thunk reads the cache and calls NO network reader', () => {
  // ── THE PROPERTY ZAC STATED IS ABOUT THE WIRING, NOT THE LIBRARY ──────────
  //
  // "Make the route decision read the cache, not the network." Every leg above
  // proves the cache behaves; none of them proves server.js USES it. This one does,
  // and it is the leg that would catch the regression that actually happens: a
  // future edit re-adds `await fetchAccountStatus()` to the thunk for a "fresher"
  // number and the route silently pays 400ms a job again, with all 12 legs green.
  //
  // INDENTATION-BOUNDED, NOT A BYTE WINDOW. Seven times this session a check
  // compared indexes inside a fixed character window and called it containment;
  // position is not containment. The thunk is extracted by its own brace depth.
  //
  // AND COMMENTS ARE STRIPPED FIRST, because this file's own prose says
  // "fetchAccountStatus" repeatedly — a check satisfied by its own comment has
  // happened three times here, and the server's thunk is thick with commentary
  // naming exactly the call it no longer makes.
  const { stripComments } = require('./__gate_strip');
  const src = stripComments(require('fs').readFileSync(
    require('path').join(__dirname, '..', 'server.js'), 'utf8'));
  const at = src.indexOf('accountStatus:');
  assert.ok(at > 0, 'server.js must still pass accountStatus to routeForJob');
  // Walk from the first brace of the thunk body to its match — the body itself,
  // whatever its length, with no window to get wrong.
  const open = src.indexOf('{', at);
  assert.ok(open > at && open - at < 200, 'the thunk body must follow accountStatus:');
  let depth = 0; let end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > open, 'unbalanced braces while extracting the thunk');
  const body = src.slice(open, end + 1);
  assert.ok(/readAccountStatusCached\s*\(/.test(body),
    'the job path must read the cache');
  assert.ok(!/fetchAccountStatus\s*\(/.test(body),
    'the job path must NOT call the network reader — that is the 400ms this whole '
    + 'change removes, and re-adding it would leave every other leg green');
  assert.ok(!/\bawait\b/.test(body),
    'an await in the route thunk is a socket in the job-create path however it is '
    + 'spelled');
});

// ── SMOKE_ONLY EXISTS SO A RED PROOF CAN NAME ITS LEG ───────────────────────
//
// Without it, a mutation that breaks an EARLY leg proves nothing about a LATER
// leg's assertion: two of the six mutations in this file's first RED proof went
// red on leg 1 and read as evidence for leg 2 and leg 13. A red that is not about
// the property is as wrong as a green that is not.
//
// THE COUNT ASSERTION IS NOT WEAKENED BY IT. Unfiltered — every real run, the gate
// included — all 13 must run. Filtered, it demands at least one leg matched, so a
// typo'd filter is a failure and not a silent empty pass.
const ONLY = process.env.SMOKE_ONLY || '';
(async () => {
  for (const [name, fn] of _queue) {
    if (ONLY && !name.includes(ONLY)) continue;
    await fn();
    legs += 1;
    console.log(`  ok  ${name}`);
  }
  if (ONLY) {
    assert.ok(legs > 0, `SMOKE_ONLY=${ONLY} matched no leg`);
    console.log(`[smoke] chatcut status cache: ${legs} leg(s) matching "${ONLY}" green`);
    return;
  }
  console.log(`[smoke] chatcut status cache: ${legs}/13 legs green `
    + '(warm hit routes, no fetch before the return, stale and empty BOTH fail '
    + 'closed with a named cause, one failure absorbed but none extends the '
    + 'ceiling, single-flight, timer single+unref\'d+primed)');
  assert.strictEqual(legs, 13, `expected 13 legs, ran ${legs}`);
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  // exitCode, NOT process.exit: an explicit exit truncates a large record on a
  // pipe, which is how a failing check has printed nothing before now.
  process.exitCode = 1;
});

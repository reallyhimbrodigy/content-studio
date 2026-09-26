'use strict';
// Gate for the ChatCut routing guard (Zac 2026-09-24).
//
// "A job goes to the ChatCut path only when the state is OK and the balance is
// above the reserve. Otherwise it goes to the existing pipeline, and the job
// row records why. A customer job never fails because of our credit or plan
// state. UNKNOWN routes to the existing pipeline, never to ChatCut on a guess."
//
// At August's volume, 2,000 credits last DAYS. So the fallback is the normal
// operating mode once the pool runs down, not an edge case — and it has to be
// invisible to the customer.

const assert = require('assert');
const R = require('./chatcut-routing');

const quiet = { warn() {}, error() {}, log() {} };
const d = (s, o) => R.decideRoute(s, { reserve: 500, ...o });

// A THROW ANYWHERE IN L1-L5 IS AN L6 VIOLATION. Without this wrapper a
// mutation that makes decideRoute throw escapes to the outer catch and prints
// "smoke FAILED: <the raw error>" — naming no leg, which makes the next run
// the debugger. Two of my red proofs failed for exactly this reason before it
// was here.
try {

// ── L1: OK AND FUNDED ROUTES TO CHATCUT. The only route that does.
{
  const r = d({ state: 'OK', balance: 4000 });
  assert.strictEqual(r.route, R.ROUTE_CHATCUT, 'L1: OK above the reserve goes to ChatCut');
  assert.strictEqual(r.reason, 'chatcut');
  assert.strictEqual(r.balance, 4000, 'L1: and the balance it decided on is reported');
}

// ── L2: LOW CREDITS FALLS BACK, AND SAYS SO.
{
  for (const bal of [0, 1, 499, 500]) {
    const r = d({ state: 'OK', balance: bal });
    assert.strictEqual(r.route, R.ROUTE_EXISTING, `L2: balance ${bal} must not reach ChatCut`);
    assert.strictEqual(r.reason, 'chatcut_low_credits', `L2: and the reason at ${bal}`);
  }
  // AT the reserve is below, not above. "Above the reserve" is the ruling, and
  // an off-by-one here spends the floor the reserve exists to protect.
  assert.strictEqual(d({ state: 'OK', balance: 501 }).route, R.ROUTE_CHATCUT,
    'L2: and one credit above it does route');
}

// ── L3: AN INACTIVE ACCOUNT FALLS BACK, AND IS NOT CALLED UNKNOWN.
for (const state of ['INACTIVE', 'SUSPENDED', 'CANCELLED', 'inactive']) {
  const r = d({ state, balance: 10000 });
  assert.strictEqual(r.route, R.ROUTE_EXISTING, `L3: ${state} must not reach ChatCut`);
  assert.strictEqual(r.reason, 'chatcut_inactive',
    `L3: ${state} is inactive, not unknown — folding them would make a plan `
    + 'problem and an outage the same line');
}

// ── L4: UNKNOWN ROUTES AWAY, NEVER TO CHATCUT ON A GUESS. Every way of not
// knowing, including the ones that are not a state at all.
{
  const cases = [
    ['explicit UNKNOWN', { state: 'UNKNOWN' }, 'chatcut_unknown'],
    ['a STALE record', { state: 'STALE' }, 'chatcut_unknown'],
    ['no body at all', null, 'chatcut_unknown'],
    ['a string body', 'OK', 'chatcut_unknown'],
    // THE EXPECTED REASON IS NOW PER-CASE, and the split is the point.
    //
    // This loop asserted `chatcut_unknown` for all four. That was CORRECT when
    // written and the design moved under it: job 839bd13b proved that "we could
    // not find out whether they are live" and "they are live and we could not
    // parse their balance" need different words, because the first sends you to
    // the network and the second to your own parser — and one word sent four
    // diagnoses to the wrong place.
    //
    // THE SAFETY PROPERTY IS UNCHANGED AND STILL ASSERTED FOR ALL FOUR: none of
    // them reaches ChatCut. Only the label splits.
    ['no state field', { balance: 9999 }, 'chatcut_unknown'],
    ['a non-string state', { state: 7, balance: 9999 }, 'chatcut_unknown'],
    ['OK with no balance', { state: 'OK' }, 'chatcut_no_balance'],
    ['OK with an unreadable balance', { state: 'OK', balance: 'lots' }, 'chatcut_no_balance'],
  ];
  for (const [why, body, expected] of cases) {
    // A CASE WITH NO EXPECTATION IS A HARNESS FAULT, NOT A PASS. When this loop
    // gained a third element, the four older entries silently had `expected ===
    // undefined` and strictEqual compared a real reason against undefined — which
    // failed loudly here, but the same omission on a `!==` or a truthy check would
    // have passed and asserted nothing.
    assert.ok(typeof expected === 'string' && expected,
      `L4: case "${why}" has no expected reason — every case must name one`);
    const r = d(body);
    assert.strictEqual(r.route, R.ROUTE_EXISTING, `L4: ${why} must not reach ChatCut`);
    assert.strictEqual(r.reason, expected, `L4: ${why} must read as ${expected}`);
  }
  // AND THE TWO KINDS MUST NOT COLLAPSE BACK INTO ONE. Asserted as a distinctness
  // property rather than only per-case, so a future edit that maps both to the
  // same word fails here instead of silently costing the next diagnosis.
  assert.notStrictEqual(d({ balance: 9999 }).reason,
    d({ state: 'OK' }).reason,
    'an unreadable STATE and an unreadable BALANCE must not share a reason — that '
    + 'collapse is what made job 839bd13b look like the four transport failures '
    + 'before it');
  // THE ONE THAT WOULD SPEND MONEY. B1's service withholds the balance on a
  // stale record precisely so a caller cannot route on a number that is no
  // longer true. OK-with-no-balance must therefore be UNKNOWN, not zero and
  // not "probably fine".
  assert.strictEqual(d({ state: 'OK' }).balance, null,
    'L4: and we never invent the balance we could not read');
}

// ── L4b: B1's SESSION-DETECTOR VOCABULARY (2026-09-25). LIVE routes; DEAD is
// a fact about the account; UNREACHABLE is an outage on our side. Keeping the
// last two apart is what lets one page and the other not.
assert.strictEqual(d({ state: 'LIVE', balance: 9999 }).route, R.ROUTE_CHATCUT,
  'L4b: LIVE is a routing state, like OK');
assert.strictEqual(d({ state: 'DEAD', balance: 9999 }).reason, 'chatcut_inactive',
  'L4b: a dead session is INACTIVE — the account cannot spend');
assert.strictEqual(d({ state: 'UNREACHABLE', balance: 9999 }).reason, 'chatcut_unknown',
  'L4b: an unreachable detector is UNKNOWN — our outage, not their state');
assert.strictEqual(d({ state: 'DEAD', balance: 9999 }).route, R.ROUTE_EXISTING);
assert.strictEqual(d({ state: 'UNREACHABLE', balance: 9999 }).route, R.ROUTE_EXISTING);

// ══ ZAC'S TWO RULINGS, 2026-09-25 ══════════════════════════════════════
//
// R1: "DEGRADED = cancelAtPeriodEnd true with status active: keep routing to
// ChatCut until period_end minus 24 h... A cancelling subscription with
// credits in hand is still a working account, and the old pipeline is a
// quality cut customers would notice."
//
// The period and the clock live on B1's side, so he computes it and publishes
// route_ok / route_why / chatcut_until. Re-deriving it here would be two
// implementations of one ruling, and they drift.
assert.strictEqual(d({ state: 'LIVE', route_ok: true, balance: 4000 }).route, R.ROUTE_CHATCUT,
  'R1: route_ok true routes — a cancelling account with credits still works');
assert.strictEqual(d({ state: 'LIVE', route_ok: false, route_why: 'chatcut_cancelling_cutoff',
  balance: 4000 }).reason, 'chatcut_cancelling_cutoff',
  'R1: route_ok false carries HIS reason, not a reason I invented');
assert.strictEqual(d({ state: 'LIVE', route_ok: true, balance: 100 }).reason, 'chatcut_low_credits',
  'R1: and route_ok true still meets the credit floor — the ruling is about '
  + 'whether an account MAY route, never about whether it can pay');

// R1b: PRESENT, NOT WELL-TYPED. Gating on `typeof === "boolean"` let a
// malformed value FALL THROUGH to the state path — route_ok: "true" as a
// string then routed to ChatCut on state alone, the exact inversion of an
// allowlist. If the field is there, it is the answer.
for (const bad of ['true', 1, null, 0, '', {}]) {
  assert.notStrictEqual(d({ state: 'LIVE', route_ok: bad, balance: 4000 }).route, R.ROUTE_CHATCUT,
    `R1b: route_ok=${JSON.stringify(bad)} is not the boolean true and must not route`);
}
assert.strictEqual(d({ state: 'LIVE', balance: 4000 }).route, R.ROUTE_CHATCUT,
  'R1b control: an ABSENT field still falls back to the state path');

// R2: "Re-edit on a dead session: the server returns a retryable 503, no
// charge, the client keeps the words with Send live, and it pages. Never a
// generic failure."
{
  const dead = R.reeditUnroutable({ route: R.ROUTE_NONE, reason: 'chatcut_unknown' });
  assert.strictEqual(dead.status, 503, 'R2: 503, not 402 — never ask them to pay for our outage');
  assert.strictEqual(dead.body.retryable, true, 'R2: retryable, so the client keeps Send live');
  assert.strictEqual(dead.page, true, 'R2: and it pages');
  assert.ok(!('price' in dead.body) && !('balance' in dead.body) && !('needed' in dead.body),
    'R2: NO money field — a number here invites a paywall on our own outage');
  assert.ok(/saved/.test(dead.body.message), 'R2: and it tells them their words are safe');
  assert.strictEqual(dead.body.error, 'reedit_temporarily_unavailable',
    'R2: typed so the client reaches its keep-the-words state, never a generic failure');

  // THE COPY SPLITS BY CAUSE. An exhausted pool is not transient: retrying
  // changes nothing until someone tops it up, so "try again in a moment"
  // would be a sentence we know to be false as we send it.
  const out = R.reeditUnroutable({ route: R.ROUTE_NONE, reason: 'chatcut_exhausted' });
  assert.notStrictEqual(out.body.message, dead.body.message,
    'R2: an exhausted pool must not be told to try again in a moment');
  assert.ok(!/in a moment/.test(out.body.message));
  assert.strictEqual(out.status, 503);
  assert.strictEqual(out.page, true, 'R2: both page');

  // A ROUTED JOB GETS NOTHING. The helper must not manufacture a refusal for
  // a decision that succeeded.
  assert.strictEqual(R.reeditUnroutable({ route: R.ROUTE_CHATCUT, reason: 'chatcut' }), null);
  assert.strictEqual(R.reeditUnroutable({ route: R.ROUTE_EXISTING, reason: 'ramp_off' }), null);
  assert.strictEqual(R.reeditUnroutable(null), null);
}

// ── L5: AN UNRECOGNISED STATE IS NOT A ROUTE TO CHATCUT. An allowlist, not a
// denylist: a state name nobody thought to list must not fall through to the
// path that spends.
for (const state of ['OKAY', 'OK_ISH', 'ACTIVE', 'GREEN', '']) {
  assert.notStrictEqual(d({ state, balance: 9999 }).route, R.ROUTE_CHATCUT,
    `L5: "${state}" is not OK and must not reach ChatCut`);
}

} catch (e) {
  if (e && e.code === 'ERR_ASSERTION') throw e;
  assert.fail(`L6: decideRoute THREW during L1-L5 (${e && e.message}). A guard that `
    + 'can fail a customer job to protect our credit balance has inverted the thing '
    + 'it is protecting.');
}

// ── L6: THE GUARD NEVER THROWS. A guard that can fail a customer job to
// protect our credit balance has inverted the thing it is protecting.
for (const junk of [undefined, null, 0, '', [], NaN, { state: null },
  { state: {} }, Object.create(null)]) {
  let r;
  assert.doesNotThrow(() => { r = R.decideRoute(junk, { reserve: 500 }); },
    `L6: decideRoute(${JSON.stringify(junk)}) must never throw`);
  assert.ok(r && (r.route === R.ROUTE_EXISTING || r.route === R.ROUTE_CHATCUT),
    'L6: and it always returns a route');
}

// ── L7: EVERY FETCH FAILURE IS UNKNOWN, NOT AN ERROR. This sits on the render
// door; a slow answer about OUR credit balance must not become the customer's
// latency or the customer's failure.
(async () => {
  const bad = [
    ['a rejected fetch', async () => { throw new Error('ECONNREFUSED'); }],
    ['a timeout', async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; }],
    ['a 500', async () => ({ ok: false, status: 500 })],
    ['a 401', async () => ({ ok: false, status: 401 })],
    ['unparseable json', async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })],
  ];
  for (const [why, impl] of bad) {
    let status;
    try {
      ({ status } = await R.fetchAccountStatus({
        url: 'http://x', fetchImpl: impl, log: quiet, timeoutMs: 50 }));
    } catch (e) {
      assert.fail(`L7: fetchAccountStatus THREW on ${why} (${e && e.message}) instead of `
        + 'returning UNKNOWN. This sits on the render door.');
    }
    assert.strictEqual(status, null, `L7: ${why} yields no status`);
    const r = R.decideRoute(status, { reserve: 500 });
    assert.strictEqual(r.route, R.ROUTE_EXISTING, `L7: ${why} routes to the existing pipeline`);
    assert.strictEqual(r.reason, 'chatcut_unknown', `L7: ${why} is UNKNOWN`);
  }
  // No URL configured is the pre-wiring state, and it must behave the same.
  const { status: s2 } = await R.fetchAccountStatus({ url: '', log: quiet });
  assert.strictEqual(s2, null, 'L7: an unconfigured URL is UNKNOWN, not an error');

  // ── L8: A GOOD ANSWER STILL WORKS. Without this every leg above is
  // satisfied by a function that returns UNKNOWN unconditionally — the
  // always-refuses shape that passes every refusal test.
  const { status: ok } = await R.fetchAccountStatus({
    url: 'http://x', log: quiet,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ state: 'OK', balance: 3000 }) }),
  });
  assert.deepStrictEqual(ok, { state: 'OK', balance: 3000 },
    'L8: a healthy response must come back intact, or the guard is a no-op that refuses everything');
  assert.strictEqual(R.decideRoute(ok, { reserve: 500 }).route, R.ROUTE_CHATCUT,
    'L8: and it must actually route to ChatCut');

  // ── L9: THE SECRET IS SENT WHEN THERE IS ONE, AND ITS ABSENCE IS NOT AN
  // ERROR. B1's posture is OPEN unless a caller secret is in the container.
  let sawHeaders = null;
  await R.fetchAccountStatus({ url: 'http://x', secret: 's3cr3t', log: quiet,
    fetchImpl: async (u, o) => { sawHeaders = o.headers; return { ok: true, status: 200, json: async () => ({ state: 'OK', balance: 1 }) }; } });
  assert.strictEqual(sawHeaders['x-promptly-secret'], 's3cr3t', 'L9: the secret rides when set');
  sawHeaders = null;
  await R.fetchAccountStatus({ url: 'http://x', secret: '', log: quiet,
    fetchImpl: async (u, o) => { sawHeaders = o.headers; return { ok: true, status: 200, json: async () => ({ state: 'OK', balance: 1 }) }; } });
  assert.ok(!('x-promptly-secret' in sawHeaders), 'L9: and no empty header is sent when there is none');

  // ══ TWO FLOORS (Zac 2026-09-24) ═══════════════════════════════════════
  // "A 500 reserve is fine for NEW videos. But a re-edit of a ChatCut-made
  // video can only run in ChatCut, so the new-job reserve must not refuse it.
  // New videos stop at 500; re-edits continue down to a hard floor."
  //
  // This repo already settled the principle: a re-edit INHERITS the parent's
  // `pipeline` as a stored fact, because re-resolving would hand an agentic
  // plan to handler or the reverse. A ChatCut project is the same case.
  const re = (b, o = {}) => R.decideRoute(b == null ? { state: 'UNKNOWN' }
    : { state: 'OK', balance: b }, { isChatcutReedit: true, ...o });
  const nw = (b, o = {}) => R.decideRoute({ state: 'OK', balance: b }, o);

  // ── F1: THE BAND BETWEEN THE FLOORS IS THE WHOLE POINT. A balance that
  // stops a new video must still serve a ChatCut re-edit.
  for (const b of [51, 100, 400, 499, 500]) {
    assert.strictEqual(nw(b).route, R.ROUTE_EXISTING, `F1: a NEW video at ${b} falls back`);
    assert.strictEqual(re(b).route, R.ROUTE_CHATCUT,
      `F1: a ChatCut RE-EDIT at ${b} must still run — it has nowhere else to go`);
  }

  // ── F2: THE HARD FLOOR HOLDS, and "above" means above.
  assert.strictEqual(re(R.DEFAULT_REEDIT_FLOOR + 1).route, R.ROUTE_CHATCUT,
    'F2: one above the hard floor still runs');
  assert.strictEqual(re(R.DEFAULT_REEDIT_FLOOR).route, R.ROUTE_NONE,
    'F2: AT the hard floor is below it — the floor is what we do not spend');
  assert.strictEqual(re(0).route, R.ROUTE_NONE);

  // ── F3: BELOW THE HARD FLOOR THERE IS NOWHERE TO SEND IT, and we do not
  // pretend there is. Routing a ChatCut re-edit to the existing pipeline hands
  // handler a plan it cannot read — a wrong edit instead of an honest no.
  assert.notStrictEqual(re(10).route, R.ROUTE_EXISTING,
    'F3: a ChatCut re-edit must NEVER be routed to the existing pipeline');
  assert.strictEqual(re(10).reason, 'chatcut_exhausted',
    'F3: and the reason distinguishes an empty pool from a fallback');
  assert.notStrictEqual(re(10).reason, 'chatcut_low_credits',
    'F3: `low_credits` means "use the other pipeline" and there is no other one');

  // ── F4: IT PAGES, AND ONLY WHEN A CUSTOMER IS TURNED AWAY. A new video
  // falling back is invisible to the customer and must wake nobody.
  assert.strictEqual(re(10).page, true, 'F4: a re-edit we cannot serve is an outage');
  assert.strictEqual(nw(10).page, false, 'F4: a new video falling back is not');
  assert.strictEqual(nw(9999).page, false);
  assert.strictEqual(re(9999).page, false);

  // ── F5: A NON-OK STATE ON A CHATCUT RE-EDIT ALSO HAS NO FALLBACK.
  for (const st of ['UNKNOWN', 'STALE', 'INACTIVE', 'SUSPENDED']) {
    const r = R.decideRoute({ state: st, balance: 99999 }, { isChatcutReedit: true });
    assert.strictEqual(r.route, R.ROUTE_NONE, `F5: ${st} on a ChatCut re-edit is NONE`);
    assert.strictEqual(r.page, true, `F5: and it pages`);
    assert.notStrictEqual(r.route, R.ROUTE_CHATCUT, `F5: and never a guess`);
  }

  // ── F6: A RE-EDIT OF AN OLD-PIPELINE VIDEO IS AN ORDINARY JOB HERE. The
  // flag is about whether a FALLBACK EXISTS, not about the word "re-edit" —
  // the existing pipeline made that video and can re-edit it.
  assert.strictEqual(nw(400).route, R.ROUTE_EXISTING,
    'F6: isChatcutReedit=false takes the 500 reserve and the normal fallback');
  assert.strictEqual(nw(400).floorKind, 'new');
  assert.strictEqual(re(400).floorKind, 'reedit');

  // ── F7: BOTH FLOORS ARE CONFIGURABLE AND NEITHER DEFAULTS TO ZERO.
  assert.ok(R.DEFAULT_REEDIT_FLOOR > 0, 'F7: the hard floor must not be zero');
  assert.ok(R.DEFAULT_REEDIT_FLOOR < R.DEFAULT_RESERVE,
    'F7: the re-edit floor must be BELOW the new-job reserve, or it is not a '
    + 'second floor at all — that inversion would refuse exactly the jobs it exists to admit');
  assert.strictEqual(R.reeditFloorFrom({ CHATCUT_REEDIT_FLOOR: '75' }), 75,
    'F7: the hard floor is configurable too');
  assert.strictEqual(R.reeditFloorFrom({ CHATCUT_REEDIT_FLOOR: 'x' }), R.DEFAULT_REEDIT_FLOOR,
    'F7: and an unreadable one falls back to the default, never to 0');

  // ── L10: THE RESERVE IS CONFIGURABLE AND ITS DEFAULT IS POSITIVE. A zero
  // reserve drains the pool to exactly nothing mid-job, which turns a routing
  // decision into a mid-render failure.
  assert.ok(R.DEFAULT_RESERVE > 0, 'L10: the default reserve must not be zero');
  assert.strictEqual(R.reserveFrom({ CHATCUT_CREDIT_RESERVE: '1200' }), 1200,
    'L10: the env knob must actually be read — a reserve nobody can move is a '
    + 'constant with a misleading name');
  assert.strictEqual(R.reserveFrom({ CHATCUT_CREDIT_RESERVE: 'abc' }), R.DEFAULT_RESERVE,
    'L10: an unreadable reserve falls back to the default, never to 0');
  assert.strictEqual(R.reserveFrom({}), R.DEFAULT_RESERVE,
    'L10: and an unset env falls back to the default');


  // ── AN AUTH REFUSAL IS NOT AN INACTIVE ACCOUNT (2026-09-26) ──────────────
  //
  // MEASURED: B1's /account_status answers HTTP 200 with
  //   {"state":"REFUSED","auth":"REQUIRED","why":"this container carries a caller
  //    secret and the request did not match it"}
  // to any caller whose secret does not match. That fell through to the generic
  // else and reported chatcut_inactive — "the account is not active" — when the
  // truth is "we were not allowed to ask". Different owners: one is ChatCut's
  // billing, the other is a secret on our side, and sending someone to the wrong
  // one is the entire cost of a bad label. It routes away either way, so this
  // changes no behaviour, only what the next reader is told.
  {
    const refusedByState = R.decideRoute({ state: 'REFUSED', auth: 'REQUIRED' }, {});
    assert.strictEqual(refusedByState.reason, 'chatcut_refused_auth',
      `state REFUSED must name the auth refusal, got ${refusedByState.reason}`);
    assert.notStrictEqual(refusedByState.route, 'chatcut',
      'a refused read must never route to ChatCut');

    // EITHER SIGNAL ALONE. A case that trips both arms of a two-arm rule proves
    // neither, so each is driven where the other is absent.
    assert.strictEqual(R.decideRoute({ state: 'WHATEVER', auth: 'REQUIRED' }, {}).reason,
      'chatcut_refused_auth', 'auth:REQUIRED alone must name the auth refusal');
    assert.strictEqual(R.decideRoute({ state: 'REFUSED' }, {}).reason,
      'chatcut_refused_auth', 'state REFUSED alone must name the auth refusal');

    // AND IT MUST NOT SWALLOW THE NEIGHBOURS. Widening this label would hide the
    // billing case it was carved out of.
    assert.strictEqual(R.decideRoute({ state: 'INACTIVE' }, {}).reason, 'chatcut_inactive');
    assert.strictEqual(R.decideRoute({ state: 'CANCELLED' }, {}).reason, 'chatcut_inactive');
    assert.strictEqual(R.decideRoute({ state: 'STALE' }, {}).reason, 'chatcut_unknown');
    assert.strictEqual(R.decideRoute({ state: 'UNREACHABLE' }, {}).reason, 'chatcut_unknown');
    console.log('  ok  a 200 carrying REFUSED/auth=REQUIRED reads as '
      + 'chatcut_refused_auth; inactive and unknown keep theirs');
  }

  // ── THE GUARD'S EVIDENCE REACHES THE PRINTED LINE ───────────────────────
  //
  // Job 7eb3df03 fell back with reason=chatcut_unknown and nothing said why.
  // fetchAccountStatus computes the transport outcome exactly — http_NNN, no_url,
  // error:… — and the call site discarded it with `(await …).status`. A server
  // that KNEW the status code logged "we could not find out", and a hand-run curl
  // then got a DIFFERENT answer than the server had, which is how one failure
  // became two hypotheses.
  {
    const rdSrc = require('fs').readFileSync(
      require('path').join(__dirname, 'route-decisions.js'), 'utf8');
    assert.ok(rdSrc.includes('status_why=${r.statusWhy}'),
      'statusWhy must appear in the PRINTED line — the ring is in-memory per '
      + 'instance, so a field that reaches the ring and not the log is gone the '
      + 'moment the process rolls, which it did between the job and my reading it');
    assert.ok(rdSrc.includes('state=${r.state}'), 'state must appear in the printed line');

    // TRANSPORT AND CONTENT ARE SEPARATE FIELDS, on purpose: a 200 carrying
    // REFUSED and a 502 carrying nothing are different problems with different
    // owners, and one field cannot say both. Driven through record().
    const rd = require('./route-decisions');
    const a = rd.record({ jobId: 'j1', userId: 'u', pipeline: 'handler',
      route: 'existing', reason: 'chatcut_refused_auth', stage: 'guard',
      source: 'allowlist', statusWhy: 'ok', state: 'REFUSED' });
    assert.strictEqual(a.statusWhy, 'ok', 'a 200 must record as reached');
    assert.strictEqual(a.state, 'REFUSED', 'and the refusal as content');
    const b = rd.record({ jobId: 'j2', userId: 'u', pipeline: 'handler',
      route: 'existing', reason: 'chatcut_unknown', stage: 'guard',
      source: 'allowlist', statusWhy: 'http_502', state: null });
    assert.strictEqual(b.statusWhy, 'http_502',
      'a non-2xx must record its code — the field whose absence made 7eb3df03 '
      + 'undiagnosable from the log alone');
    assert.strictEqual(b.state, null, 'and no state, because none was served');
    console.log('  ok  the ring and the log carry statusWhy AND state, separately');
  }

  console.log('[smoke] chatcut routing: ALL PASS (OK+funded is the only route to ChatCut, '
    + 'low credits / inactive / unknown each fall back with their own reason, an '
    + 'unrecognised state never reaches ChatCut, the guard never throws, every fetch '
    + 'failure is UNKNOWN, a healthy answer still routes, the secret rides when set, '
    + 'the reserve is configurable and never 0, TWO FLOORS: a re-edit runs in the '
    + 'band that stops a new video, the hard floor holds, below it is NONE and never '
    + 'the existing pipeline, and it pages)');
  process.exit(0);
})().catch((e) => {
  console.error('chatcut-routing smoke FAILED:', e && e.message);
  process.exit(1);
});

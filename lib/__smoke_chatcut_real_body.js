'use strict';
// ── THE REAL BODY SHAPE, FED TO THE SHIPPED GUARD ───────────────────────────
//
// WHY THIS FILE EXISTS. Job 839bd13b, 2026-09-26 06:45:49Z, user 2efb75dd:
//
//   route=existing reason=chatcut_unknown stage=guard source=allowlist
//   status_why=ok state=LIVE
//
// The fetch SUCCEEDED, ChatCut said LIVE with route_ok true and ~1898 credits in
// hand, and the guard sent the job to the handler anyway. The cause was entirely
// on our side of the seam: decideRoute read
//
//   Number(status.balance ?? status.credits ?? NaN)
//
// at the TOP LEVEL, and ChatCut publishes the number at `account.balance`. There
// is no top-level `balance` and no top-level `credits`, so that expression was
// NaN on a perfectly healthy account, and "OK with no readable balance is
// UNKNOWN" — a correct rule — turned every allowlisted job away.
//
// EVERY OTHER CHECK IN THIS REPO FED THE GUARD A BODY WE INVENTED. That is why a
// dozen legs passed while the live path could not route at all: the fixtures were
// written from the same wrong assumption as the reader. "Fixtures are sampled from
// production, not invented — that is a standing law", and this is the file that
// obeys it for this seam.
//
// The shape below is B1's measured top-level key set and the account sub-object
// verbatim, with values only where they have already been disclosed.

const assert = require('assert');
const R = require('./chatcut-routing');

let legs = 0;
const leg = (name, fn) => { fn(); legs += 1; console.log(`  ok  ${name}`); };

// ── THE BODY, AS MEASURED ──────────────────────────────────────────────────
// Top-level keys, exactly as B1 reported them:
//   account, alerts, auth, burn, chatcut_until, cost_p95_credits, now_ms,
//   published, reserve_credits, route_ok, route_why, session, state, why
function liveBody(over = {}) {
  return {
    state: 'LIVE',
    route_ok: true,
    route_why: 'active',
    auth: 'VERIFIED',
    why: 'ok',
    alerts: [],
    reserve_credits: 500,
    cost_p95_credits: 12.5,
    chatcut_until: null,
    now_ms: 1790000000000,
    session: { state: 'LIVE' },
    // published carries NO money — {age_h, samples, samples_unreadable, state, why}.
    // My probe's `published_present: true` was about the object existing, and I
    // read it as evidence the balance might be in there. It was not.
    published: { age_h: 0.29, samples: 15, samples_unreadable: 0, state: 'FRESH', why: 'ok' },
    // account keys in full, as measured.
    account: {
      balance: 1897.85, cached: false, cancel_at_period_end: false,
      period_end: '2026-10-23', plan: 'pro', read_at: 1790000000000,
      reasons: [], state: 'ACTIVE', status: 'OK', why: 'ok',
    },
    // THE DECOY. Same number today, different meaning: the burn series' latest
    // sample. A reader that accepted it would spend against a statistic.
    burn: { balance: 1897.85, rate: 0.4 },
    ...over,
  };
}

const ALL_TOP_LEVEL = ['account', 'alerts', 'auth', 'burn', 'chatcut_until',
  'cost_p95_credits', 'now_ms', 'published', 'reserve_credits', 'route_ok',
  'route_why', 'session', 'state', 'why'];

leg('the fixture IS the measured shape, not one we invented', () => {
  const keys = Object.keys(liveBody()).sort();
  assert.deepStrictEqual(keys, [...ALL_TOP_LEVEL].sort(),
    'the fixture has drifted from the key set B1 measured — re-measure before '
    + 'editing this, because a fixture invented from the same assumption as the '
    + 'reader is how a dozen legs passed while nothing could route');
  // AND THE TRAP IS PRESENT. Without burn.balance in the fixture, a reader that
  // wrongly accepted it would pass this file.
  assert.strictEqual(liveBody().burn.balance, liveBody().account.balance,
    'burn.balance must hold the SAME number as account.balance in the fixture, or '
    + 'the decoy is not a decoy and the exclusion is untested');
  assert.ok(!('balance' in liveBody()) && !('credits' in liveBody()),
    'there must be NO top-level balance or credits — that absence IS the bug');
});

leg('a healthy live account routes to ChatCut', () => {
  const d = R.decideRoute(liveBody(), { reserve: 500 });
  assert.strictEqual(d.route, 'chatcut',
    `a LIVE account with route_ok true and 1897.85 credits must route to ChatCut, `
    + `got route=${d.route} reason=${d.reason}. This is job 839bd13b.`);
  assert.strictEqual(d.reason, 'chatcut');
  assert.strictEqual(d.balance, 1897.85);
  assert.strictEqual(d.balancePath, 'account.balance',
    'the decision must NAME where it found the number, so the next shape change '
    + 'is visible in the log before it turns into a silent fallback');
});

leg('the balance comes from account.balance and NEVER from burn.balance', () => {
  // The decoy alone must not satisfy the reader. If account.balance vanishes and
  // only burn.balance remains, that is NO readable balance — not 1897.85.
  const b = liveBody();
  delete b.account.balance;
  const d = R.decideRoute(b, { reserve: 500 });
  assert.notStrictEqual(d.route, 'chatcut',
    'burn.balance satisfied the reader — that is the burn-rate series latest '
    + 'sample, not the account balance, and spending against a statistic is worse '
    + 'than refusing');
  assert.strictEqual(d.reason, 'chatcut_no_balance');
  assert.strictEqual(d.balancePath, null);
});

leg('a missing balance is chatcut_no_balance, NOT chatcut_unknown', () => {
  // The distinction that cost this diagnosis: "we could not reach them" and "we
  // reached them and could not parse them" are different problems with different
  // owners, and they were the same word.
  const b = liveBody();
  delete b.account.balance;
  delete b.burn;
  const d = R.decideRoute(b, { reserve: 500 });
  assert.strictEqual(d.reason, 'chatcut_no_balance',
    'a 200 we cannot parse must not report as the same reason as an unreachable '
    + 'provider — that collapse sent four failures diagnosis to the network');
  assert.strictEqual(d.state, 'LIVE', 'and it must still report the state it DID read');
});

leg('the floor still binds, read from the right place', () => {
  // A real low balance must still fall back — the fix must not route everything.
  const low = liveBody(); low.account.balance = 12;
  const d = R.decideRoute(low, { reserve: 500 });
  assert.strictEqual(d.route, 'existing');
  assert.strictEqual(d.reason, 'chatcut_low_credits');
  assert.strictEqual(d.balancePath, 'account.balance',
    'even a refusal must name where the number came from');
  // And a ChatCut re-edit below the floor is the other reason, not this one.
  const r = R.decideRoute(low, { reserve: 500, isChatcutReedit: true });
  assert.strictEqual(r.reason, 'chatcut_exhausted');
});

leg('route_ok false still refuses, even with money in the account', () => {
  // B1 publishes the routing decision and we honour it; a funded account he has
  // ruled out must not route because the balance now parses.
  const no = liveBody({ route_ok: false, route_why: 'cancelling' });
  const d = R.decideRoute(no, { reserve: 500 });
  assert.notStrictEqual(d.route, 'chatcut',
    'route_ok false must beat a healthy balance — fixing the parse must not '
    + 'weaken the allowlist that route_ok is');
  assert.strictEqual(d.reason, 'cancelling');
});

leg('a string balance parses; null, true and [] do not', () => {
  // null, '', true and [] all coerce to a finite Number in JS, and every one of
  // them would be a fabricated balance on a spend path.
  const asString = liveBody(); asString.account.balance = '1897.85';
  assert.strictEqual(R.decideRoute(asString, { reserve: 500 }).route, 'chatcut');
  for (const bad of [null, true, [], '', {}]) {
    const b = liveBody(); b.account.balance = bad; delete b.burn;
    const d = R.decideRoute(b, { reserve: 500 });
    assert.strictEqual(d.reason, 'chatcut_no_balance',
      `account.balance=${JSON.stringify(bad)} must NOT read as a balance — it `
      + 'coerces to a finite Number and would be a fabricated one');
  }
});

console.log(`[smoke] chatcut real body: ${legs}/7 legs green `
  + '(the measured shape routes, account.balance not burn.balance, no_balance is '
  + 'its own reason, the floor still binds, route_ok still wins)');
assert.strictEqual(legs, 7, `expected 7 legs, ran ${legs}`);

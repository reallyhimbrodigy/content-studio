'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/credits');

// Every test drives the REAL module and stubs only global fetch, so the request
// SHAPE (method, path, body) is asserted against what RC documents rather than
// against a mock of my own design.
function withFetch(handler, fn) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  const restore = () => { global.fetch = real; };
  return fn(calls).then((v) => { restore(); return v; },
                        (e) => { restore(); throw e; });
}
const res = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

process.env.REVENUECAT_SECRET_KEY = 'sk_test';
process.env.REVENUECAT_PROJECT_ID = 'proj_test';
process.env.REVENUECAT_CREDITS_CODE = 'CRD';

test('re-edits NEVER debit, on any tier (ruling 3)', () => {
  // The ruling is tier-independent, so tier is not even an input.
  assert.strictEqual(C.shouldDebit({ mode: 'full' }), true);
  assert.strictEqual(C.shouldDebit({}), true, 'a plain create debits');
  for (const m of ['tweak', 'reinterpret', 'render_only', 'guided_redraft']) {
    assert.strictEqual(C.shouldDebit({ mode: m }), false, `${m} must not debit`);
  }
  assert.strictEqual(C.shouldDebit({ isReEdit: true }), false);
  assert.strictEqual(C.shouldDebit({ mode: 'full', isReEdit: true }), false,
    'an explicit re-edit flag wins over mode');
});

test('debit spends a NEGATIVE adjustment at the documented path', async () => {
  await withFetch((url, init) => {
    assert.match(url, /\/v2\/projects\/proj_test\/customers\/u1\/virtual_currencies\/transactions$/);
    assert.strictEqual(init.method, 'POST');
    assert.deepStrictEqual(JSON.parse(init.body), { adjustments: { CRD: -10 } });
    assert.match(init.headers.Authorization, /^Bearer sk_test$/);
    return res(200, { object: 'transaction' });
  }, async () => {
    const r = await C.debit('u1', 10);
    assert.deepStrictEqual(r, { ok: true, spent: 10 });
  });
});

test('a 422 is INSUFFICIENT — and nothing was deducted', async () => {
  // RC documents: validates the balance, and on failure returns 422 with
  // retryable:false having deducted NOTHING. That is what makes debit-first
  // correct instead of read-then-debit.
  await withFetch(() => res(422, {
    message: "Customer's balance is not enough to perform the transaction.",
    retryable: false,
  }), async () => {
    await assert.rejects(() => C.debit('u1', 10), (e) => {
      assert.strictEqual(e.code, 'INSUFFICIENT');
      assert.match(e.rcMessage, /not enough/i);
      return true;
    });
  });
});

test('a refusal is DISTINGUISHABLE from an outage', async () => {
  // "RC said no" is the user's problem; "RC did not answer" is ours. Collapsing
  // them would either free-render on an outage or paywall on a blip.
  await withFetch(() => { throw new Error('socket hang up'); }, async () => {
    await assert.rejects(() => C.debit('u1', 10),
      (e) => e.code === 'UNREACHABLE');
  });
  await withFetch(() => res(500, { message: 'boom' }), async () => {
    await assert.rejects(() => C.debit('u1', 10),
      (e) => e.code === 'RC_ERROR' && e.status === 500);
  });
});

test('credit gives back a POSITIVE adjustment', async () => {
  await withFetch((url, init) => {
    assert.deepStrictEqual(JSON.parse(init.body), { adjustments: { CRD: 10 } });
    return res(200, {});
  }, async () => {
    assert.deepStrictEqual(await C.credit('u1', 10), { ok: true, granted: 10 });
  });
});

test('amounts must be positive integers, and REJECTED BEFORE any RC call', async () => {
  // A sign slip would invert the operation — debit(-10) is a GRANT. So the
  // guard must fire before the request is built, not be caught by RC.
  //
  // The stub THROWS if reached: an unstubbed run made a real outbound request
  // to RevenueCat with a fake key and failed with 401 instead of the validation
  // error, which is both a wrong assertion and a live network call from a unit
  // test.
  await withFetch(() => { throw new Error('RC MUST NOT BE CALLED for a bad amount'); },
    async (calls) => {
      for (const bad of [0, -10, 1.5, '10', null, NaN]) {
        await assert.rejects(() => C.debit('u1', bad), /positive integer/,
          `debit(${JSON.stringify(bad)})`);
        await assert.rejects(() => C.credit('u1', bad), /positive integer/,
          `credit(${JSON.stringify(bad)})`);
      }
      // credit has NO default, so omitting the amount is also invalid...
      await assert.rejects(() => C.credit('u1'), /positive integer/);
      assert.strictEqual(calls.length, 0, 'no RC call may be made for a bad amount');
    });
  // ...whereas debit DELIBERATELY defaults to COST_PER_RENDER, so omitting it is
  // valid and spends exactly 10. Asserted rather than assumed, because the two
  // functions differing here is easy to misread as a bug.
  await withFetch((url, init) => {
    assert.deepStrictEqual(JSON.parse(init.body), { adjustments: { CRD: -10 } });
    return res(200, {});
  }, async () => {
    assert.deepStrictEqual(await C.debit('u1'), { ok: true, spent: 10 });
  });
});

test('getBalance reads through and never invents a number', async () => {
  await withFetch((url, init) => {
    assert.match(url, /\/customers\/u1\/virtual_currencies$/);
    assert.strictEqual(init.method, 'GET');
    return res(200, { items: [{ currency_code: 'CRD', balance: 42 },
                               { currency_code: 'GLD', balance: 9 }] });
  }, async () => {
    const b = await C.getBalance('u1');
    assert.strictEqual(b.balance, 42, 'picks OUR currency, not the first row');
    assert.strictEqual(b.found, true);
  });
  // A customer with no row for our currency reads 0 and says so — not "unknown".
  await withFetch(() => res(200, { items: [] }), async () => {
    const b = await C.getBalance('u1');
    assert.strictEqual(b.balance, 0);
    assert.strictEqual(b.found, false, 'found=false distinguishes 0 from absent');
  });
  // On failure it THROWS rather than returning a stale/zero balance.
  await withFetch(() => res(503, { message: 'down' }), async () => {
    await assert.rejects(() => C.getBalance('u1'), (e) => e.code === 'RC_ERROR');
  });
});

test('CONTROL: the module refuses to operate unconfigured', async () => {
  // Without this the suite would pass just as happily against a module that
  // silently no-ops when the key is missing — which is how a feature ships
  // "working" and charges nobody.
  const s = process.env.REVENUECAT_SECRET_KEY;
  delete process.env.REVENUECAT_SECRET_KEY;
  assert.strictEqual(C.isConfigured(), false);
  await assert.rejects(() => C.debit('u1', 10), (e) => e.code === 'NOT_CONFIGURED');
  await assert.rejects(() => C.getBalance('u1'), (e) => e.code === 'NOT_CONFIGURED');
  process.env.REVENUECAT_SECRET_KEY = s;
  assert.strictEqual(C.isConfigured(), true);
});

test('CONTROL: the stub is actually reached', async () => {
  // If fetch were never called, every assertion above about request shape would
  // be vacuous and the suite would still be green.
  await withFetch(() => res(200, {}), async (calls) => {
    await C.debit('u1', 10);
    assert.strictEqual(calls.length, 1, 'debit must make exactly one RC call');
  });
});

// ── WIRING TESTS ────────────────────────────────────────────────────────────
// The module can be perfect and the feature still do nothing if it is never
// called. These assert the SEAMS, because "credits are wired" and "credits
// exist as a file" look identical from the module's own tests.
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const LEG = fs.readFileSync(path.join(__dirname, '../lib/refund-leg.js'), 'utf8');

// STRIP COMMENTS BEFORE ASSERTING ON CODE. Three separate assertions in this
// campaign have failed on a COMMENT that happened to contain the token they
// forbade — a note saying "no usage_events write", and one saying "NOT a
// balance:". A comment cannot spend an export or promise a field. Any
// doesNotMatch over source must run on code only.
const codeOnly = (src) => src.split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');

test('the debit runs BEFORE the job insert, and demos are exempt', () => {
  const iDebit = SRC.indexOf('_credits.debit(authUser.id');
  const iInsert = SRC.indexOf('const created = await createQueuedVideoJob({');
  assert.ok(iDebit > 0, 'no debit call in the dispatch path — credits are inert');
  assert.ok(iInsert > 0);
  assert.ok(iDebit < iInsert,
    'debit must precede the insert/spawn; spawn-then-debit spends GPU on a ' +
    'render the user cannot pay for');
  const window = SRC.slice(iDebit - 700, iDebit);
  assert.match(window, /!isDemo/,
    'a demo is quota-exempt and must be credit-exempt too, or the first-run ' +
    'sample clip charges the user 10');
  assert.match(window, /isConfigured\(\)/,
    'must not attempt a debit when credits are unconfigured');
});

test('402 carries needed ONLY — never a balance we did not read', () => {
  const CODE = codeOnly(SRC);
  const i = CODE.indexOf("error: 'insufficient_credits'");
  assert.ok(i > 0, 'no insufficient_credits response');
  const body = CODE.slice(i, i + 300);
  assert.match(body, /needed:/);
  assert.doesNotMatch(body, /\bbalance:/,
    'with no pre-read the server never learns the balance on this path; ' +
    'promising one is a contract that cannot be kept');
  assert.match(body, /balanceKnown: false/,
    'and it should SAY so, rather than leaving the client to infer it from ' +
    'an absent field');
});

test('an outage does NOT free-render', () => {
  // SCOPED TO THE DISPATCH REGION. `credits_unavailable` also appears in
  // /api/credits/balance, so a bare indexOf finds THAT one and validates
  // against the wrong site — deleting the dispatch branch entirely still went
  // green until this was scoped. Same family as matching a short token against
  // unrelated source.
  const iDebit = SRC.indexOf('_credits.debit(authUser.id');
  assert.ok(iDebit > 0, 'no debit call — nothing to guard');
  const region = SRC.slice(iDebit, iDebit + 1800);
  assert.match(region, /credits_unavailable/,
    'the dispatch debit has no outage branch — an RC outage would fall ' +
    'through and spawn a free render');
  assert.match(region, /503/, 'an outage must refuse, not render for free');
  assert.match(region, /INSUFFICIENT/,
    'a refusal must be distinguished from an outage at the dispatch site');
});

test('the replay path unwinds the debit', () => {
  assert.match(SRC, /replay unwind refunded/,
    'a replayed job that kept its debit charges 10 for a render that never runs');
});

test('the credits refund CLAIMS before calling RC, and unclaims on failure', () => {
  const iClaim = LEG.indexOf("credits_refunded_at: new Date().toISOString()");
  const iCall = LEG.indexOf('await credits.credit(userId, amount)');
  assert.ok(iClaim > 0 && iCall > 0);
  assert.ok(iClaim < iCall,
    'claim must precede the RC call; claiming after would drop refunds on a ' +
    'transient RC error');
  assert.match(LEG, /credits_refunded_at: null/,
    'a failed RC call must UNCLAIM so the next sweep retries');
});

test('a NULL receipt is skipped, not defaulted', () => {
  assert.match(LEG, /noop-never-debited/,
    'assuming a default amount would invent credits nobody spent');
});

test('the refund event carries a CODE, not a sentence', () => {
  assert.match(LEG, /type: 'credits_refunded'/);
  assert.match(LEG, /reason_code:/);
  const i = LEG.indexOf("type: 'credits_refunded'");
  const payload = LEG.slice(i, i + 300);
  assert.doesNotMatch(payload, /message:|"You |'You /,
    'a server-authored sentence renders English to every reader');
});

test('CONTROL: these seam assertions can fail', () => {
  // Guards the guards. If the file were empty every indexOf would be -1 and the
  // assertions above would need to fail, not pass vacuously.
  assert.ok(SRC.length > 10000 && LEG.length > 2000, 'sources actually loaded');
  assert.strictEqual(SRC.indexOf('_credits.debit_THAT_DOES_NOT_EXIST'), -1);
});

// ── REACHABILITY ────────────────────────────────────────────────────────────
// The check that was missing. My earlier tests asserted refundJobCredits'
// INTERNALS — claim before RC, unclaim on failure — and every one passed while
// the function had ZERO CALLERS. The credits refund was dead code and the event
// went nowhere. Frontend found it trying to wire CreditsRefundedMessage.
//
// Testing what a function does is not testing that it runs.
test('refundJobCredits is actually CALLED by the sweep', () => {
  const calls = (LEG.match(/await refundJobCredits\(/g) || []).length;
  assert.ok(calls >= 1,
    'refundJobCredits has no caller — the credits refund is dead code and the ' +
    'refund event goes nowhere, however correct the function is');
  const iSweep = LEG.indexOf('async function sweepRefundLeg');
  const iCall = LEG.indexOf('await refundJobCredits(');
  assert.ok(iCall > iSweep,
    'the call must be inside the sweep, not merely somewhere in the file');
});

test('the sweep SELECTS the columns the credits refund reads', () => {
  // credits_debited is the receipt. If the sweep does not select it, every job
  // reads undefined and the refund no-ops as "never debited" — green tests,
  // zero refunds.
  const iSel = LEG.indexOf(".select('id, user_id");
  const sel = LEG.slice(iSel, iSel + 260);
  assert.match(sel, /credits_debited/,
    'without this column every refund no-ops as never-debited');
  assert.match(sel, /credits_refunded_at/);
});

test('the SSE frame carries a type discriminator', () => {
  assert.match(SRC, /type: 'job_status'/,
    'an untagged frame cannot be routed — a refund frame would parse as a ' +
    'status update');
  assert.match(SRC, /creditsRefunded: data\.credits_refunded_at/,
    'the refund must be surfaced from the row; the sweep runs outside any ' +
    'request so there is no stream to push to');
});

test('the 402 and the export wall are typed too', () => {
  assert.match(SRC, /type: 'insufficient_credits'/);
  assert.match(SRC, /type: 'free_export_spent'/);
  assert.match(SRC, /freeExportSpent: true/,
    'the client was inferring "spent" by comparing two counters, which breaks ' +
    'silently when FREE_EXPORT_LIMIT moves');
});

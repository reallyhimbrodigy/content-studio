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

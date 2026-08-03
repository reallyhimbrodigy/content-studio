'use strict';

// Smoke: the spend-guard makes its own regression impossible — per-account cap
// blocks, global halt blocks + takes precedence, global alert does NOT halt, and
// ANY DB error fails OPEN (a counting bug must never block a legit render).
// Run: node lib/__smoke_spend_guard.js

const assert = require('assert');
const { checkSpendGuards } = require('./spend-guard');

// Minimal thenable mock of the supabase query builder. head:true count queries
// resolve {count}; the .eq(user) variant returns userCount, else globalCount.
// select('user_id') without head (topAccounts) resolves {data: rows}.
function mockAdmin({ userCount = 0, globalCount = 0, rows = [], err = null } = {}) {
  return {
    from() {
      let head = false, eqUser = false;
      const b = {
        select(_c, opts) { head = !!(opts && opts.head); return b; },
        gte() { return b; },
        eq() { eqUser = true; return b; },
        then(resolve) {
          if (err) return resolve({ count: null, data: null, error: new Error(err) });
          if (head) return resolve({ count: eqUser ? userCount : globalCount, error: null });
          return resolve({ data: rows, error: null });
        },
      };
      return b;
    },
  };
}

(async () => {
  let r = await checkSpendGuards({ supabaseAdmin: mockAdmin({ userCount: 5, globalCount: 100 }), userId: 'u1' });
  assert.strictEqual(r.allow, true, 'under all caps → allow');

  r = await checkSpendGuards({ supabaseAdmin: mockAdmin({ userCount: 50, globalCount: 100 }), userId: 'u1' });
  assert.strictEqual(r.allow, false, 'per-account cap → block');
  assert.strictEqual(r.code, 'daily_render_cap');

  r = await checkSpendGuards({ supabaseAdmin: mockAdmin({ userCount: 5, globalCount: 800, rows: [{ user_id: 'a' }, { user_id: 'a' }, { user_id: 'b' }] }), userId: 'u1' });
  assert.strictEqual(r.allow, false, 'global halt → block');
  assert.strictEqual(r.code, 'spend_halt');

  r = await checkSpendGuards({ supabaseAdmin: mockAdmin({ userCount: 5, globalCount: 500 }), userId: 'u1' });
  assert.strictEqual(r.allow, true, 'global ALERT tier does NOT halt dispatch');

  r = await checkSpendGuards({ supabaseAdmin: mockAdmin({ err: 'db boom' }), userId: 'u1' });
  assert.strictEqual(r.allow, true, 'DB error → FAIL-OPEN (allow)');

  r = await checkSpendGuards({ supabaseAdmin: null, userId: 'u1' });
  assert.strictEqual(r.allow, true, 'no admin → allow (no-op)');

  console.log('__smoke_spend_guard: OK (7 assertions)');
})();

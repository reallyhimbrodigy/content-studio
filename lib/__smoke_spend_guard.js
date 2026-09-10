'use strict';

// Smoke: the spend-guard makes its own regression impossible — per-account cap
// blocks, global halt blocks + takes precedence, global alert does NOT halt, and
// ANY DB error fails OPEN (a counting bug must never block a legit render).
// Run: node lib/__smoke_spend_guard.js

const assert = require('assert');
const { checkSpendGuards, PER_ACCOUNT_DAILY_CAP, GLOBAL_ALERT, GLOBAL_HALT, checkRejectionAttemptCap, REJECTION_ATTEMPT_CAP } = require('./spend-guard');

// Minimal thenable mock of the supabase query builder. head:true count queries
// resolve {count}; the .eq(user) variant returns userCount, else globalCount.
// select('user_id') without head (topAccounts) resolves {data: rows}.
// THE MOCK USED TO ACCEPT ANY COLUMN NAME, and that is precisely why this
// smoke stayed green for five weeks over a guard that returned 42703 on every
// single call: it filtered on `error_code`, which `video_jobs` does not have
// (the code lives at `result->>error_code`). A mock that answers every question
// tests nothing about which question was asked.
//
// So it now RECORDS the filters and the smoke asserts them against the columns
// that actually exist. This is still a mock — it cannot know the live schema —
// but it can catch a name that was never in the schema at all, which is the
// failure that happened.
const VIDEO_JOBS_FILTERABLE = new Set([
  'user_id', 'status', 'created_at', 'id', 'source_duration', 'client_message_id',
  'completion_delivery', 'rendered_video_url', 'hls_manifest_url', 'thumbnail_url',
  'error_message', 'refund_last_error',
  // JSONB paths into the result envelope, where the rejection code lives.
  'result->>error_code',
]);

function mockAdmin({ userCount = 0, globalCount = 0, rows = [], err = null } = {}) {
  const filters = [];
  const admin = {
    _filters: filters,
    from() {
      let head = false, eqUser = false;
      const b = {
        select(_c, opts) { head = !!(opts && opts.head); admin._head = head; return b; },
        gte(col) { filters.push(col); return b; },
        in(col) { filters.push(col); return b; },
        eq(col) { filters.push(col); eqUser = true; return b; },
        then(resolve) {
          if (err) return resolve({ count: null, data: null, error: new Error(err) });
          if (head) return resolve({ count: eqUser ? userCount : globalCount, error: null });
          // The rejection cap COUNTS ROWS now rather than asking for a bare
          // count, because head:true is what discarded the error body. A
          // per-user query with no explicit rows stands in for userCount rows.
          if (eqUser && rows.length === 0) {
            return resolve({ data: Array.from({ length: userCount }, (_, i) => ({ id: `j${i}` })), error: null });
          }
          return resolve({ data: rows, error: null });
        },
      };
      return b;
    },
  };
  return admin;
}

(async () => {
  // Threshold-agnostic: exercise relative to the module's ACTUAL constants so
  // this survives env/default re-tuning (e.g. the surge bump to 3000/1500).
  let r = await checkSpendGuards({ supabaseAdmin: mockAdmin({ userCount: 0, globalCount: GLOBAL_ALERT - 1 }), userId: 'u1' });
  assert.strictEqual(r.allow, true, 'under all caps → allow');

  r = await checkSpendGuards({ supabaseAdmin: mockAdmin({ userCount: PER_ACCOUNT_DAILY_CAP, globalCount: 0 }), userId: 'u1' });
  assert.strictEqual(r.allow, false, 'per-account cap → block');
  assert.strictEqual(r.code, 'daily_render_cap');

  r = await checkSpendGuards({ supabaseAdmin: mockAdmin({ userCount: 0, globalCount: GLOBAL_HALT, rows: [{ user_id: 'a' }, { user_id: 'a' }, { user_id: 'b' }] }), userId: 'u1' });
  assert.strictEqual(r.allow, false, 'global halt → block');
  assert.strictEqual(r.code, 'spend_halt');

  // Between ALERT and HALT: pages but does NOT stop dispatch.
  r = await checkSpendGuards({ supabaseAdmin: mockAdmin({ userCount: 0, globalCount: GLOBAL_HALT - 1 }), userId: 'u1' });
  assert.strictEqual(r.allow, true, 'ALERT..HALT band does NOT halt dispatch');
  assert.ok(GLOBAL_ALERT < GLOBAL_HALT, 'ALERT must be below HALT');

  r = await checkSpendGuards({ supabaseAdmin: mockAdmin({ err: 'db boom' }), userId: 'u1' });
  assert.strictEqual(r.allow, true, 'DB error → FAIL-OPEN (allow)');

  r = await checkSpendGuards({ supabaseAdmin: null, userId: 'u1' });
  assert.strictEqual(r.allow, true, 'no admin → allow (no-op)');

  // ── THE TWO THAT WOULD HAVE CAUGHT THIS ───────────────────────────────────
  // 1. EVERY COLUMN IT FILTERS ON MUST EXIST. The guard shipped filtering
  //    `error_code`, which video_jobs does not have, so it threw 42703 on every
  //    call from 2026-08-04 until 2026-09-10 and failed open each time. The cap
  //    was never once evaluated.
  const probe = mockAdmin({ userCount: 0 });
  await checkRejectionAttemptCap({ supabaseAdmin: probe, userId: 'u1' });
  for (const col of probe._filters) {
    assert.ok(VIDEO_JOBS_FILTERABLE.has(col),
      `rejection cap filters on "${col}", which is not a column video_jobs has `
      + '— that is a 42703 on every call, and this guard fails OPEN');
  }
  assert.ok(probe._filters.includes('result->>error_code'),
    'the rejection code lives in the result envelope, not in a column');

  // 2. IT MUST NOT USE head:true. A HEAD response carries no body, so
  //    PostgREST's error text is discarded and supabase-js builds an error with
  //    an EMPTY message — which is exactly why five weeks of failures logged
  //    nothing about their cause. Measured live: the same query as GET returns
  //    a 99-byte body naming the missing column; as HEAD, zero bytes.
  assert.strictEqual(probe._head, false,
    'rejection cap must not use head:true — it discards the error body, and a '
    + 'money-path guard that cannot say why it failed is worse than one that '
    + 'fails closed');

  // Refund-farming cap (designed rejections only, fail-open).
  let rr = await checkRejectionAttemptCap({ supabaseAdmin: mockAdmin({ userCount: 0 }), userId: 'u1' });
  assert.strictEqual(rr.allow, true, 'under rejection cap → allow');
  rr = await checkRejectionAttemptCap({ supabaseAdmin: mockAdmin({ userCount: REJECTION_ATTEMPT_CAP }), userId: 'u1' });
  assert.strictEqual(rr.allow, false, 'at rejection cap → block');
  assert.strictEqual(rr.code, 'too_many_rejected');
  rr = await checkRejectionAttemptCap({ supabaseAdmin: mockAdmin({ err: 'boom' }), userId: 'u1' });
  assert.strictEqual(rr.allow, true, 'rejection cap DB error → FAIL-OPEN');



  console.log('__smoke_spend_guard: OK (11 assertions)');
})();

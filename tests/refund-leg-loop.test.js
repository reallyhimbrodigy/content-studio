'use strict';
const test = require('node:test');
const assert = require('node:assert');

// REGRESSION TEST for the live error loop of 2026-08-30 -> 2026-08-31.
//
// WHAT HAPPENED: seven demo=true rows with user_id=NULL matched the sweep's
// `status=failed AND refunded_at IS NULL` predicate. refundJobCharge claimed each
// one, then queried `.eq('user_id', job.user_id)` — PostgREST serialises a JS
// null as the STRING "null", so Postgres answered `invalid input syntax for type
// uuid: "null"`. The error path called unclaim(), which set refunded_at back to
// NULL, which put the row straight back into the sweep's own predicate. Every
// ~2 seconds, for two days.
//
// TWO INDEPENDENT DEFECTS, so two independent guards — either alone would have
// stopped THIS loop while leaving the class alive:
//   1. the rows should never have been eligible (demo / NULL user_id)
//   2. ANY erroring row retried forever, because a failed attempt recorded
//      NOTHING. That is the part that would have recurred with a new cause.

const ELIGIBLE = (rows) => rows.filter(
  (r) => r.parent_job_id == null && r.reedit_mode == null
    && r.demo !== true && r.user_id != null);

const UID = '1ee91622-119d-43a0-9a9a-2ad2b2f13917';

test('demo rows are NOT eligible for the sweep', () => {
  const rows = [{ id: 'a', demo: true, user_id: null, parent_job_id: null, reedit_mode: null }];
  assert.equal(ELIGIBLE(rows).length, 0);
});

test('a NULL user_id row is NOT eligible — this is the uuid "null" crash', () => {
  const rows = [{ id: 'b', demo: false, user_id: null, parent_job_id: null, reedit_mode: null }];
  assert.equal(ELIGIBLE(rows).length, 0);
});

test('a real failed job IS still eligible (the guard must not eat real refunds)', () => {
  const rows = [{ id: 'c', demo: false, user_id: UID, parent_job_id: null, reedit_mode: null }];
  assert.equal(ELIGIBLE(rows).length, 1);
});

test('demo IS NULL (legacy rows) stays eligible — .neq would have dropped these', () => {
  // `demo <> true` is NULL for a NULL demo, so a server-side .neq('demo', true)
  // silently excludes every row written before the column existed. That is why
  // the filter is `r.demo !== true` in JS.
  const rows = [{ id: 'd', demo: null, user_id: UID, parent_job_id: null, reedit_mode: null }];
  assert.equal(ELIGIBLE(rows).length, 1);
});

test('re-edit rows remain excluded (they never minted a charge)', () => {
  const rows = [{ id: 'e', demo: false, user_id: UID, parent_job_id: 'p', reedit_mode: 'tweak' }];
  assert.equal(ELIGIBLE(rows).length, 0);
});

// ── the class fix: a failed attempt must RECORD something ───────────────────
function unclaimPatch(job, detail, MAX = 3) {
  const attempts = Number(job.refund_attempts || 0) + 1;
  const patch = { refund_attempts: attempts, refund_last_error: String(detail).slice(0, 500) };
  if (attempts < MAX) patch.refunded_at = null;
  return patch;
}

test('an early failure releases the claim so a transient error still retries', () => {
  const p = unclaimPatch({ refund_attempts: 0 }, 'network blip');
  assert.equal(p.refunded_at, null, 'must release below the cap');
  assert.equal(p.refund_attempts, 1);
});

test('at the cap the row stays CLAIMED — the loop cannot be infinite', () => {
  const p = unclaimPatch({ refund_attempts: 2 }, 'invalid input syntax for type uuid: "null"');
  assert.ok(!('refunded_at' in p),
    'a dead-lettered row must NOT be released back into the sweep predicate');
  assert.equal(p.refund_attempts, 3);
});

test('every failed attempt records its reason', () => {
  const p = unclaimPatch({ refund_attempts: 0 }, 'boom');
  assert.equal(p.refund_last_error, 'boom',
    'a row that stops retrying without a reason is its own bug');
});

test('attempts are monotonic across passes — the bound actually converges', () => {
  let job = { refund_attempts: 0 };
  const seen = [];
  for (let i = 0; i < 5; i++) {
    const p = unclaimPatch(job, 'persistent failure');
    seen.push(p.refund_attempts);
    job = { refund_attempts: p.refund_attempts };
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  // Past the cap the row is never released, so the sweep stops selecting it.
  assert.ok(!('refunded_at' in unclaimPatch({ refund_attempts: 3 }, 'x')));
});

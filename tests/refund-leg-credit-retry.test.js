// The defect, driven end to end: a failed job whose CHARGE refund already
// claimed refunded_at, and whose CREDIT refund is still outstanding, must be
// re-selected by the sweep. Before the fix it never was.
// Added 2026-09-11, before the first real credit charge landed.
const test = require('node:test');
const assert = require('node:assert');
const { sweepRefundLeg } = require('../lib/refund-leg');

function db(rows) {
  const calls = [];
  return { calls, from() {
    const f = {}; const nots = []; const iss = {};
    const b = {
      select: () => b,
      eq: (k, v) => { f[k] = v; return b; },
      gte: () => b,
      not: (col, op, val) => { nots.push({ col, op, val }); return b; },
      is: (col, val) => { iss[col] = val; return b; },
      update: () => ({ eq: () => ({ is: () => ({ select: async () => ({ data: [], error: null }) }) }) }),
      then: (res) => {
        const out = rows.filter((r) =>
          Object.entries(f).every(([k, v]) => r[k] === v)
          && nots.every((n) => (n.op === 'is' && n.val === null) ? r[n.col] != null : true)
          && Object.entries(iss).every(([k, v]) => (v === null ? r[k] == null : r[k] === v)));
        calls.push({ f: { ...f }, nots: [...nots], iss: { ...iss }, got: out.map((r) => r.id) });
        return Promise.resolve({ data: out, error: null }).then(res);
      },
    };
    return b;
  } };
}

test('a stranded credit refund is re-selected by the sweep', async () => {
  const now = new Date().toISOString();
  // THE STRANDED ROW: charge refund already claimed, credits charged and NOT
  // refunded — the exact state an RC hiccup leaves behind.
  const stranded = { id: 'stranded', user_id: 'u1', created_at: now, status: 'failed',
    result: {}, parent_job_id: null, reedit_mode: null,
    refunded_at: now, credits_debited: 10, credits_refunded_at: null,
    demo: false, refund_attempts: 0 };
  const d = db([stranded]);
  await sweepRefundLeg(d).catch(() => {});
  const everSelected = d.calls.some((c) => c.got.includes('stranded'));
  assert.ok(everSelected,
    'A job charged 10 credits, whose credit refund failed once, must be '
    + 're-selected. Selecting only on `refunded_at IS NULL` strands it forever: '
    + 'refundJobCharge claims that column on the FIRST pass, so the row leaves '
    + 'the set before the credit refund ever gets a retry.');
});

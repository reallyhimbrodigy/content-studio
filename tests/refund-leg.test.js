'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  isRefundEligible, refundJobCharge, sweepRefundLeg, DELETE_DELTA_CAP_MS, CHARGE_MATCH_WINDOW_MS,
} = require('../lib/refund-leg');

// ---- minimal supabase-js style fake: select / delete / update + eq/gte/lte/is ----
function makeFake(tables) {
  const state = { video_jobs: [...(tables.video_jobs || [])], usage_events: [...(tables.usage_events || [])] };
  function builder(table) {
    let op = 'select';
    let patch = null;
    const filters = [];
    const b = {
      select() { return b; },
      update(o) { op = 'update'; patch = o; return b; },
      delete() { op = 'delete'; return b; },
      eq(col, val) { filters.push((r) => r[col] === val); return b; },
      gte(col, val) { filters.push((r) => r[col] >= val); return b; },
      lte(col, val) { filters.push((r) => r[col] <= val); return b; },
      is(col, val) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      then(resolve) {
        const rows = state[table].filter((r) => filters.every((f) => f(r)));
        if (op === 'delete') {
          state[table] = state[table].filter((r) => !rows.includes(r));
          return resolve({ data: rows.map((r) => ({ id: r.id })), error: null });
        }
        if (op === 'update') {
          rows.forEach((r) => Object.assign(r, patch));
          return resolve({ data: rows.map((r) => ({ id: r.id })), error: null });
        }
        return resolve({ data: rows.map((r) => ({ ...r })), error: null });
      },
    };
    return b;
  }
  return { from: (t) => builder(t), _state: state };
}

const NOW = Date.now();
const iso = (offMs) => new Date(NOW + offMs).toISOString();
const T = -3600_000; // base job instant: 1h ago (inside 48h lookback)
const vj = (o) => ({ parent_job_id: null, reedit_mode: null, refunded_at: null, result: null, status: 'failed', ...o });

// ---- eligibility: single-writer law, WORKER'S ACTUAL KEYS ------------------
test('eligibility: worker marks only, keyed on error_code (review fix #2)', () => {
  assert.equal(isRefundEligible({ error_code: 'INTEGRITY_TRIP', designed_rejection: false }), true);
  assert.equal(isRefundEligible({ error: 'INTEGRITY_TRIP' }), true); // legacy belt
  assert.equal(isRefundEligible({ error_code: 'CLIP_TOO_LONG', designed_rejection: true }), true);
  assert.equal(isRefundEligible({ designed_rejection: true }), true);
  assert.equal(isRefundEligible({ error_code: 'CLIP_TOO_LONG' }), false);
  assert.equal(isRefundEligible({ error_code: 'RENDER_FFMPEG' }), false);
  assert.equal(isRefundEligible(null), false);
  assert.equal(isRefundEligible({}), false);
  assert.equal(isRefundEligible({ designed_rejection: 'true' }), false);
  assert.equal(isRefundEligible('CLIP_TOO_LONG'), false); // string result
});

// ---- MARKER: the deleted-sibling residual is now structurally closed ---------
test('MARKER: refunded job is claimed one-shot — a DELETED sibling\'s orphan charge is never eaten', async () => {
  // Job A completes (charge A). Job B fails-marked (charge B) ~500ms later; both in B's window.
  const fake = makeFake({
    video_jobs: [
      vj({ id: 'jobA', user_id: 'u1', status: 'completed', created_at: iso(T - 500) }),
      vj({ id: 'jobB', user_id: 'u1', created_at: iso(T), result: { error_code: 'CLIP_TOO_LONG', designed_rejection: true } }),
    ],
    usage_events: [
      { id: 1, user_id: 'u1', kind: 'render', created_at: iso(T - 500 - 90) }, // charge A (job A's, in B's cap window)
      { id: 2, user_id: 'u1', kind: 'render', created_at: iso(T - 80) },        // charge B (job B's own)
    ],
  });
  const p1 = await sweepRefundLeg(fake);
  assert.equal(p1.refunded, 1);
  assert.equal(p1.outcomes[0].charge, 2, 'pass 1 refunds job B\'s OWN charge');
  assert.ok(fake._state.video_jobs.find((r) => r.id === 'jobB').refunded_at != null, 'job B is marked claimed');

  // user DELETES job A's row (orphaning charge A) — the exact residual trigger
  fake._state.video_jobs = fake._state.video_jobs.filter((r) => r.id !== 'jobA');

  // subsequent passes: job B is claimed -> never selected -> orphan charge A survives forever
  for (let i = 0; i < 3; i++) {
    const p = await sweepRefundLeg(fake);
    assert.equal(p.eligible, 0, `pass ${i + 2}: claimed job B is not re-selected`);
    assert.equal(p.refunded, 0);
  }
  assert.equal(fake._state.usage_events.length, 1);
  assert.equal(fake._state.usage_events[0].id, 1, 'job A\'s orphaned charge SURVIVES — residual closed');
});

// ---- REVIEW CRITICAL #2 regression: INTEGRITY_TRIP actually fires ----------
test('CRITICAL #2 regression: worker-shaped INTEGRITY_TRIP (error_code, designed_rejection:false) IS refunded', async () => {
  const fake = makeFake({
    video_jobs: [vj({ id: 'jT', user_id: 'u2', created_at: iso(T),
      result: { error_code: 'INTEGRITY_TRIP', designed_rejection: false, user_message: 'your credit was returned.' } })],
    usage_events: [{ id: 3, user_id: 'u2', kind: 'render', created_at: iso(T - 100) }],
  });
  const out = await sweepRefundLeg(fake);
  assert.equal(out.refunded, 1, 'the copy\'s promise is now true by code');
  assert.equal(fake._state.usage_events.length, 0);
  assert.ok(fake._state.video_jobs[0].refunded_at != null);
});

// ---- REVIEW MAJOR regression: re-edit/resume rows excluded -----------------
test('MAJOR regression: marked re-edit row (never minted a charge) is excluded', async () => {
  const fake = makeFake({
    video_jobs: [vj({ id: 'jR', user_id: 'u3', created_at: iso(T), parent_job_id: 'p1', reedit_mode: 'tweak', result: { designed_rejection: true } })],
    usage_events: [{ id: 4, user_id: 'u3', kind: 'render', created_at: iso(T - 200) }],
  });
  const out = await sweepRefundLeg(fake);
  assert.equal(out.eligible, 0);
  assert.equal(fake._state.usage_events.length, 1);
});

// ---- one-shot / idempotency ------------------------------------------------
test('marked row refunds exactly once; second sweep never re-selects it', async () => {
  const fake = makeFake({
    video_jobs: [vj({ id: 'j1', user_id: 'u6', created_at: iso(T), result: { error_code: 'CLIP_TOO_LONG', designed_rejection: true } })],
    usage_events: [{ id: 7, user_id: 'u6', kind: 'render', created_at: iso(T - 100) }],
  });
  const first = await sweepRefundLeg(fake);
  assert.equal(first.refunded, 1);
  const second = await sweepRefundLeg(fake);
  assert.equal(second.eligible, 0, 'claimed -> excluded');
  assert.equal(second.refunded, 0);
});

test('manual-era marked row (no charge in window) claims + no-ops, then stays out of the sweep', async () => {
  const fake = makeFake({
    video_jobs: [vj({ id: 'j3', user_id: 'u8', created_at: iso(T), result: { designed_rejection: true } })],
    usage_events: [],
  });
  const out = await sweepRefundLeg(fake);
  assert.equal(out.eligible, 1);
  assert.equal(out.refunded, 0);
  assert.equal(out.outcomes[0].action, 'noop');
  assert.ok(fake._state.video_jobs[0].refunded_at != null, 'still marked -> one-shot');
  const again = await sweepRefundLeg(fake);
  assert.equal(again.eligible, 0);
});

// ---- guards (first-pass correctness) ---------------------------------------
test('W4 cap widening: a charge minted 500ms BEFORE the job (real -33..-521ms dist) is now RETURNED', async () => {
  // Charges are minted just before the job row (charge-then-insert); the W4
  // measurement showed the delta reaching -521ms. The old 400ms cap left that
  // tail CLAIMED-but-not-returned (silent under-refund). 800ms covers it.
  assert.ok(DELETE_DELTA_CAP_MS >= 800, 'cap widened to cover the observed -521ms tail');
  const fake = makeFake({
    video_jobs: [vj({ id: 'jFar', user_id: 'uFar', created_at: iso(T), result: { error_code: 'RENDER_FATAL' } })],
    usage_events: [{ id: 20, user_id: 'uFar', kind: 'render', created_at: iso(T - 500) }], // 500ms before job
  });
  const out = await sweepRefundLeg(fake);
  assert.equal(out.refunded, 1, 'far-but-in-cap charge is returned, not noop-capped');
  assert.equal(out.outcomes[0].action, 'refunded');
  assert.equal(fake._state.usage_events.length, 0, 'charge actually gone (returned)');
});

test('delta cap: a lone in-window charge farther than the cap is not deleted (own charge already gone)', async () => {
  const fake = makeFake({
    video_jobs: [vj({ id: 'j4', user_id: 'u4', created_at: iso(T), result: { designed_rejection: true } })],
    usage_events: [{ id: 5, user_id: 'u4', kind: 'render', created_at: iso(T + DELETE_DELTA_CAP_MS + 300) }],
  });
  const out = await sweepRefundLeg(fake);
  assert.equal(out.refunded, 0);
  assert.equal(out.outcomes[0].action, 'noop-capped');
  assert.equal(fake._state.usage_events.length, 1);
});

test('attribution: an in-cap charge nearer an EXISTING sibling job is not grabbed', async () => {
  const fake = makeFake({
    video_jobs: [
      vj({ id: 'j5', user_id: 'u5', created_at: iso(T), result: { designed_rejection: true } }),
      vj({ id: 'j5b', user_id: 'u5', status: 'completed', created_at: iso(T + 350) }),
    ],
    usage_events: [{ id: 6, user_id: 'u5', kind: 'render', created_at: iso(T + 300) }], // 300ms from j5 (in cap), 50ms from j5b
  });
  const out = await sweepRefundLeg(fake);
  assert.equal(out.refunded, 0);
  assert.equal(out.outcomes[0].action, 'noop-attributed-elsewhere');
  assert.equal(fake._state.usage_events.length, 1);
});

test('cross-user / cross-kind charges at the same instant are never touched', async () => {
  const fake = makeFake({
    video_jobs: [vj({ id: 'j6', user_id: 'u9', created_at: iso(T), result: { designed_rejection: true } })],
    usage_events: [
      { id: 9, user_id: 'OTHER', kind: 'render', created_at: iso(T - 50) },
      { id: 10, user_id: 'u9', kind: 'chat', created_at: iso(T - 50) },
    ],
  });
  const out = await sweepRefundLeg(fake);
  assert.equal(out.refunded, 0);
  assert.equal(fake._state.usage_events.length, 2);
});

test('2026-07-11 LAW: an unmarked explicit failure (RENDER_FATAL) IS refunded (W1/W4 #6 gap closed)', async () => {
  const fake = makeFake({
    video_jobs: [vj({ id: 'j2', user_id: 'u7', created_at: iso(T), result: { error_code: 'RENDER_FATAL' } })],
    usage_events: [{ id: 8, user_id: 'u7', kind: 'render', created_at: iso(T - 100) }],
  });
  const out = await sweepRefundLeg(fake);
  assert.equal(out.eligible, 1, 'every failed primary row is eligible now');
  assert.equal(out.refunded, 1, 'explicit failures refund — the W1 gap closed');
  assert.equal(fake._state.usage_events.length, 0, 'charge returned');
  assert.ok(fake._state.video_jobs[0].refunded_at != null, 'claim marked (one-shot)');
});

test('out-of-window charge is invisible to the sweep', async () => {
  const fake = makeFake({
    video_jobs: [vj({ id: 'j7', user_id: 'u10', created_at: iso(T), result: { designed_rejection: true } })],
    usage_events: [{ id: 11, user_id: 'u10', kind: 'render', created_at: iso(T + CHARGE_MATCH_WINDOW_MS + 500) }],
  });
  const out = await sweepRefundLeg(fake);
  assert.equal(out.refunded, 0);
  assert.equal(fake._state.usage_events.length, 1);
});

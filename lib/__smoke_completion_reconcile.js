'use strict';
// Real-path smoke for the completion reconciler.
//
// THE DEFECT: 10 users had a finished video they never received — status
// 'completed', a full success envelope in `result`, and every delivery column
// NULL. The client reads the columns. Two paths produced it (tail never ran for
// 9; the double-loss fallback claimed "recovered fully" for 1 while the columns
// stayed NULL), so the repair must be path-agnostic.
//
// Load-bearing assertions:
//   * a row whose result holds NO url is NOT silently "reconciled" into looking
//     fine — that is a different, worse bug and must stay visible;
//   * the write is guarded by .is('rendered_video_url', null) so a sweep racing
//     the real completion tail can never clobber a live delivery;
//   * isDelivered checks COLUMNS, never status — the exact mistake the
//     double-loss alert made on 476fe663.

const assert = require('assert');
const {
  findUnprojectedCompletions, projectCompletion, reconcileCompletions, isDelivered,
} = require('./completion-reconcile');

function mockDb(rows, { failWrite = false, raceLost = false } = {}) {
  const calls = { updates: [], guards: [] };
  return {
    calls,
    from() {
      const st = { filters: {} };
      const b = {
        select: () => b,
        eq: (k, v) => { st.filters[k] = v; return b; },
        is: (k, v) => { calls.guards.push([k, v]); st.filters[`is:${k}`] = v; return b; },
        gte: () => b,
        order: () => b,
        limit: () => Promise.resolve({ data: rows, error: null }),
        update: (u) => { st.update = u; calls.updates.push(u); return b; },
        then: (res) => res({ data: [], error: null }),
      };
      // .update(...).eq(...).is(...).select() resolves last
      const origSelect = b.select;
      b.select = (...a) => {
        if (st.update) {
          if (failWrite) return Promise.resolve({ data: null, error: { message: 'pg down' } });
          return Promise.resolve({ data: raceLost ? [] : [{ id: st.filters.id }], error: null });
        }
        return origSelect(...a);
      };
      return b;
    },
  };
}

const GOOD = {
  id: 'df2e89c0-0000-0000-0000-000000000000', user_id: 'u1',
  rendered_video_url: null, result_url: null, hls_manifest_url: null,
  thumbnail_url: null, completed_at: null,
  result: {
    video_url: 'https://cdn/v.mp4',
    hls_manifest_url: 'https://cdn/m.m3u8',
    thumbnail_url: 'https://cdn/t.jpg',
  },
};

(async () => {
  // ── 1. only rows with a deliverable in `result` are candidates ────────────
  const rows = await findUnprojectedCompletions(mockDb([
    GOOD,
    { id: 'nourl', result: { stage_timings: {} } },          // rendered nothing
    { id: 'pub', result: { public_url: 'https://cdn/p.mp4' } },
    { id: 'nullres', result: null },
  ]));
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(GOOD.id) && ids.includes('pub'), 'rows with a URL are candidates');
  assert.ok(!ids.includes('nourl'), 'a completion with NO url in result must NOT be silently repaired');
  assert.ok(!ids.includes('nullres'), 'a null result must not crash or qualify');

  // ── 2. projection fills the columns the client reads ─────────────────────
  const db = mockDb([GOOD]);
  const out = await projectCompletion(db, GOOD);
  assert.strictEqual(out.projected, true);
  const u = db.calls.updates[0];
  assert.strictEqual(u.rendered_video_url, 'https://cdn/v.mp4');
  assert.strictEqual(u.hls_manifest_url, 'https://cdn/m.m3u8');
  assert.strictEqual(u.thumbnail_url, 'https://cdn/t.jpg');
  assert.ok(u.completed_at, 'completed_at must be set — it was NULL on all 10');
  assert.ok(!('status' in u) && !('result' in u) && !('phase' in u),
    'must never write status/result/phase — the worker owns terminal state');

  // ── 3. THE ANTI-CLOBBER GUARD ────────────────────────────────────────────
  assert.deepStrictEqual(db.calls.guards[0], ['rendered_video_url', null],
    'the write MUST be guarded by .is(rendered_video_url, null) so a sweep racing '
    + 'the real tail cannot overwrite a live delivery');

  // ── 4. losing the race is reported, not counted as a repair ──────────────
  const raced = await projectCompletion(mockDb([GOOD], { raceLost: true }), GOOD);
  assert.strictEqual(raced.projected, false);
  assert.strictEqual(raced.reason, 'raced_or_already_projected');

  // ── 5. a write failure never throws the sweep ────────────────────────────
  const failed = await projectCompletion(mockDb([GOOD], { failWrite: true }), GOOD);
  assert.strictEqual(failed.projected, false);
  assert.ok(/write_failed/.test(failed.reason));

  // ── 6. never repair a row with no URL, even if handed one directly ───────
  const none = await projectCompletion(mockDb([]), { id: 'x', result: {} });
  assert.strictEqual(none.projected, false);
  assert.strictEqual(none.reason, 'no_url_in_result');

  // ── 7. the sweep is LOUD — silence is how this hid for six days ──────────
  const logged = [];
  const res = await reconcileCompletions(mockDb([GOOD]), { log: { error: (m) => logged.push(m) } });
  assert.strictEqual(res.found, 1);
  assert.strictEqual(res.projected, 1);
  assert.ok(logged.some((m) => m.includes('[ALERT]')), 'every occurrence must alert');

  // ── 8. isDelivered reads COLUMNS, not status ─────────────────────────────
  assert.strictEqual(isDelivered({ status: 'completed', rendered_video_url: null, result_url: null }), false,
    'THE 476fe663 MISTAKE: a completed row with NULL columns is NOT delivered');
  assert.strictEqual(isDelivered({ rendered_video_url: 'https://cdn/v.mp4' }), true);
  assert.strictEqual(isDelivered({ result_url: 'https://cdn/v.mp4' }), true);
  assert.strictEqual(isDelivered(null), false);

  console.log('[smoke] completion reconcile: ALL PASS (no-url never repaired; anti-clobber guard; delivery != status)');
})().catch((e) => { console.error('[smoke] FAILED:', e && e.message); process.exit(1); });

'use strict';
// ── AN ALERT THAT CANNOT BE ACTED ON IS ONE PEOPLE LEARN TO IGNORE ──────────
//
// reconcileHandover has a 72h lookback and runs every 120s. The only thing that
// REPAIRS what it finds — sweepChatAttach — reaches back 3h. So a job aged
// between 3 and 72 hours was paged roughly two thousand times by an alert that
// nothing in the system could act on, in the same stream as the actionable
// ones. This asserts the floor: inside the repair window it logs and does not
// page; beyond it, it pages ONCE per job, naming the backfill.
const assert = require('assert');
const R = require('./completion-reconcile');

const HOUR = 3600 * 1000;
const job = (id, ageHours, user = 'u1', over = {}) => ({
  id,
  user_id: user,
  status: 'completed',
  rendered_video_url: `https://cdn.example/${id}.mp4`,
  created_at: new Date(Date.now() - ageHours * HOUR).toISOString(),
  ...over,
});

// The mock APPLIES its filters instead of discarding them. A filter defined as
// `() => b` answers any question with the same rows, which would score a query
// that asked for the wrong thing as correct — the defect class the mock-filters
// gate exists to make impossible.
const db = (rows, chats = []) => ({
  from(table) {
    if (table !== 'video_jobs' && table !== 'chats') {
      throw new Error(`unexpected table ${table} — a mock must not answer a question it was not asked`);
    }
    let set = (table === 'video_jobs' ? rows : chats).slice();
    const val = (r, c) => (r[c] === undefined ? null : r[c]);
    const b = {
      select: () => b,
      eq: (c, v) => { set = set.filter((r) => val(r, c) === v); return b; },
      is: (c, v) => { set = set.filter((r) => val(r, c) === v); return b; },
      not: (c, op, v) => {
        assert.strictEqual(op, 'is', `mock handles .not(col,'is',v); got ${op}`);
        set = set.filter((r) => val(r, c) !== v); return b;
      },
      in: (c, vs) => { set = set.filter((r) => vs.includes(val(r, c))); return b; },
      gte: (c, v) => { set = set.filter((r) => String(val(r, c)) >= String(v)); return b; },
      lt: (c, v) => { set = set.filter((r) => String(val(r, c)) < String(v)); return b; },
      lte: (c, v) => { set = set.filter((r) => String(val(r, c)) <= String(v)); return b; },
      order: (c, { ascending = true } = {}) => {
        set = set.slice().sort((x, y) => (String(val(x, c)) < String(val(y, c)) ? -1 : 1));
        if (!ascending) set.reverse();
        return b;
      },
      limit: (n) => Promise.resolve({ data: set.slice(0, n), error: null }),
    };
    return b;
  },
});

const mkLog = () => {
  const o = { pages: [], notes: [] };
  return { o, log: { error: (m) => o.pages.push(m), log: (m) => o.notes.push(m) } };
};

(async () => {
  // ── POSITIVE CONTROL: the mock's filters are live, so a green result below
  //    means the query asked the right question — not that nothing was filtered.
  {
    const L = mkLog();
    const r = await R.reconcileHandover(db([
      job('wrong-status', 10, 'u1', { status: 'processing' }),
      job('no-video', 10, 'u1', { rendered_video_url: null }),
      job('ownerless', 10, null),
      job('inside-grace', 0.1),          // 6 minutes old, under the 45m grace
      job('too-old', 500),               // outside the 72h lookback
    ]), { log: L.log });
    assert.strictEqual(r.found, 0,
      'every row here is excluded by a different clause of the real query; if any '
      + 'survives, the mock is not filtering and nothing below proves anything');
  }
  {
    const L = mkLog();
    const r = await R.reconcileHandover(
      db([job('attached', 10, 'u1')], [{ user_id: 'u1', messages: [{ jobId: 'attached' }] }]),
      { log: L.log },
    );
    assert.strictEqual(r.found, 0, 'a job already in a chat is not stranded');
  }

  assert.strictEqual(R.REPAIRABLE_HOURS, 3,
    "the floor must be the REPAIRER's window, imported from chat-attach — two "
    + 'copies of one window drift, and the drift is what made the page unactionable');

  // ── inside the repair window: the sweep owns it, so do NOT page ───────────
  R._resetHandoverPagingForTests();
  let L = mkLog();
  let r = await R.reconcileHandover(db([job('inside-1', 1)]), { log: L.log });
  assert.strictEqual(r.found, 1);
  assert.strictEqual(r.beyondRepair, 0);
  assert.strictEqual(L.o.pages.length, 0,
    'a job the sweep will fix within ten minutes must not page — paging for '
    + 'something already being fixed is what trains the reader to skip the line');
  assert.ok(L.o.notes.some((m) => /repair window/.test(m)), 'but it is still logged');

  // ── beyond it: pages ONCE, and the page carries its own next step ─────────
  R._resetHandoverPagingForTests();
  L = mkLog();
  const old = [job('beyond-1', 34), job('beyond-2', 50, 'u2')];
  r = await R.reconcileHandover(db(old), { log: L.log });
  assert.strictEqual(r.beyondRepair, 2);
  assert.strictEqual(r.pagedNow, 2);
  assert.ok(L.o.pages.some((m) => /BEYOND REPAIR/.test(m)));
  assert.ok(L.o.pages.some((m) => /backfill-chat-attach/.test(m)),
    'the page must name the tool that fixes it — an alert whose next step is not '
    + 'in the alert is one the reader has to reconstruct every time');
  assert.ok(L.o.pages.some((m) => /2 user\(s\)/.test(m)), 'Rule 7: users before jobs');

  // ── AND IT DOES NOT REPEAT. This is the whole point ──────────────────────
  const L2 = mkLog();
  const r2 = await R.reconcileHandover(db(old), { log: L2.log });
  assert.strictEqual(r2.beyondRepair, 2, 'still detected — the state has not changed');
  assert.strictEqual(r2.pagedNow, 0, 'but NOT paged again');
  assert.strictEqual(L2.o.pages.length, 0,
    'the second pass 120 seconds later must be silent. Roughly 2,000 repeats per '
    + 'job is what made this noise rather than signal.');

  // ── a NEW beyond-repair job still pages, even after others were silenced ──
  const L3 = mkLog();
  const r3 = await R.reconcileHandover(db([...old, job('beyond-3', 40, 'u3')]), { log: L3.log });
  assert.strictEqual(r3.pagedNow, 1, 'only the new one');
  assert.ok(L3.o.pages.some((m) => /beyond-3/.test(m)),
    'deduping must not silence a genuinely new stranded job — that would turn a '
    + 'noise fix into a missed page');

  // ── mixed: the two classes are separated, not averaged ───────────────────
  R._resetHandoverPagingForTests();
  const L4 = mkLog();
  const r4 = await R.reconcileHandover(db([job('in', 1), job('out', 30)]), { log: L4.log });
  assert.strictEqual(r4.found, 2);
  assert.strictEqual(r4.beyondRepair, 1);
  assert.strictEqual(r4.pagedNow, 1);
  assert.ok(!L4.o.pages.some((m) => /job=in\b/.test(m)), 'the repairable one is not in the page');

  console.log('[smoke] handover alert floor: ALL PASS (filters proven live by a negative '
    + 'control; inside the repair window logs but does not page; beyond it pages ONCE '
    + 'naming the backfill; a repeat pass is silent; a NEW stranded job still pages)');
})().catch((e) => { console.error('[smoke] FAILED:', e && e.message); process.exit(1); });

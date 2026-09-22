'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { sweepExpiredClarifications } = require('../lib/clarification-sweep');

const HOUR = 3600e3;
const NOW = Date.parse('2026-09-21T00:00:00Z');
const ago = (h) => new Date(NOW - h * HOUR).toISOString();

// A mock that ACTUALLY FILTERS. A stub whose `eq` returns the builder unchanged
// cannot distinguish a CAS that works from one that does not — it scores the
// production bug as correct. Every predicate here is applied for real, and the
// update path re-evaluates its own filters against live state so a row whose
// status changed mid-sweep genuinely fails its CAS.
function mockDb(rows) {
  const table = rows.map((r) => ({ ...r }));
  const events = [];
  const api = {
    _rows: table,
    _events: events,
    from(name) {
      if (name === 'analytics_events') {
        return { insert: async (e) => { events.push(e); return { data: [e], error: null }; } };
      }
      const preds = [];
      let mode = null, patch = null;
      const b = {
        select() { return b; },
        eq(col, val) { preds.push((r) => r[col] === val); return b; },
        lt(col, val) { preds.push((r) => String(r[col]) < String(val)); return b; },
        limit(n) { preds.push(null); b._limit = n; return b; },
        update(p) { mode = 'update'; patch = p; return b; },
        _match() {
          let m = table.filter((r) => preds.filter(Boolean).every((p) => p(r)));
          if (b._limit) m = m.slice(0, b._limit);
          return m;
        },
        then(res) {
          const matched = b._match();
          if (mode === 'update') {
            matched.forEach((r) => Object.assign(r, patch));
            return Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null }).then(res);
          }
          return Promise.resolve({ data: matched, error: null }).then(res);
        },
      };
      return b;
    },
  };
  return api;
}

const park = (o = {}) => ({
  id: 'j1', user_id: 'u1', status: 'needs_input', parent_job_id: 'p1',
  root_job_id: 'r1', created_at: ago(48),
  result: { clarification_question: 'Which part?' }, ...o,
});

const silent = { log() {}, error() {} };

test('a clarification parked past 24h is cancelled', async () => {
  const db = mockDb([park()]);
  const out = await sweepExpiredClarifications(db, { now: NOW, log: silent });
  assert.strictEqual(out.expired, 1);
  assert.strictEqual(db._rows[0].status, 'canceled');
  assert.strictEqual(db._rows[0].current_step, 'clarification_expired');
});

test('a park INSIDE 24h is not touched — the SQL cutoff really filters', async () => {
  const db = mockDb([park({ created_at: ago(5) })]);
  const out = await sweepExpiredClarifications(db, { now: NOW, log: silent });
  assert.strictEqual(out.expired, 0);
  assert.strictEqual(out.scanned, 0, 'the cutoff must exclude it before JS sees it');
  assert.strictEqual(db._rows[0].status, 'needs_input');
});

test('an ASK-BACK park is never cancelled — it owns its own timeout path', async () => {
  // Same status, different envelope. Cancelling this would terminalize a job
  // the worker still intends to resume with skip:true from partial_state.
  const db = mockDb([park({ result: { ask: { ask_id: 'ask_low_light', prompt: 'Brighter?' } } })]);
  const out = await sweepExpiredClarifications(db, { now: NOW, log: silent });
  assert.strictEqual(out.expired, 0);
  assert.strictEqual(out.skipped, 1);
  assert.strictEqual(db._rows[0].status, 'needs_input');
});

test('a row already cancelled by a reply fails its CAS and is not double-counted', async () => {
  const db = mockDb([park()]);
  // Simulate the reply winning the race first.
  db._rows[0].status = 'canceled';
  const out = await sweepExpiredClarifications(db, { now: NOW, log: silent });
  assert.strictEqual(out.expired, 0, 'the status=needs_input predicate must exclude it');
});

test('a terminal row is never swept even if it is old', async () => {
  const db = mockDb([park({ status: 'completed', created_at: ago(500) })]);
  const out = await sweepExpiredClarifications(db, { now: NOW, log: silent });
  assert.strictEqual(out.expired, 0);
  assert.strictEqual(db._rows[0].status, 'completed');
});

test('each expiry emits clarification_expired with an age', async () => {
  const db = mockDb([park({ created_at: ago(72) })]);
  await sweepExpiredClarifications(db, { now: NOW, log: silent });
  assert.strictEqual(db._events.length, 1);
  assert.strictEqual(db._events[0].event, 'clarification_expired');
  assert.strictEqual(db._events[0].props.age_hours, 72);
  assert.strictEqual(db._events[0].props.root_job_id, 'r1');
});

test('the sweep is idempotent — a second pass expires nothing', async () => {
  const db = mockDb([park(), park({ id: 'j2' })]);
  const first = await sweepExpiredClarifications(db, { now: NOW, log: silent });
  const second = await sweepExpiredClarifications(db, { now: NOW, log: silent });
  assert.strictEqual(first.expired, 2);
  assert.strictEqual(second.expired, 0);
});

test('mixed population: only the eligible rows move', async () => {
  const db = mockDb([
    park({ id: 'old' }),                                              // expires
    park({ id: 'fresh', created_at: ago(2) }),                        // too new
    park({ id: 'askback', result: { ask: { ask_id: 'a' } } }),        // wrong envelope
    park({ id: 'done', status: 'completed' }),                        // terminal
  ]);
  const out = await sweepExpiredClarifications(db, { now: NOW, log: silent });
  assert.strictEqual(out.expired, 1);
  const byId = Object.fromEntries(db._rows.map((r) => [r.id, r.status]));
  assert.deepStrictEqual(byId,
    { old: 'canceled', fresh: 'needs_input', askback: 'needs_input', done: 'completed' });
});

test('a read error returns zeros rather than throwing into the interval', async () => {
  const bad = { from: () => ({ select: () => ({ eq: () => ({ lt: () => ({ limit: () => ({
    then: (r) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(r) }) }) }) }) }) };
  const out = await sweepExpiredClarifications(bad, { now: NOW, log: silent });
  assert.deepStrictEqual(out, { scanned: 0, expired: 0, skipped: 0 });
});

test('no db is a no-op, not a crash', async () => {
  assert.deepStrictEqual(await sweepExpiredClarifications(null, { log: silent }),
    { scanned: 0, expired: 0, skipped: 0 });
});

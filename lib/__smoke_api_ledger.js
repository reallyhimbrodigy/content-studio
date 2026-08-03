'use strict';
// The API outcome ledger, tested against its own target IN BOTH DIRECTIONS.
//
// The closure standard (Zac 2026-08-03) requires an instrument be tested both
// ways: it must FIRE on the thing it watches, and STAY SILENT otherwise. Today
// alone two instruments were wrong in opposite directions — a silent-rate
// detector that read only one recipe shape (false 63%), then its correction
// that counted the uncut clip as an event (false 0%). Both would have passed a
// one-direction test.

const assert = require('assert');
const L = require('./api-outcome-ledger');

// ── DIRECTION 1: it counts failures ─────────────────────────────────────────
L.drain();
L.record('POST', '/api/chat', 502, 'u1');
L.record('POST', '/api/chat', 502, 'u1');   // same user retrying
L.record('POST', '/api/chat', 502, 'u2');
let rows = L.drain();
assert.strictEqual(rows.length, 1, 'one bucket per (method, route, code)');
assert.strictEqual(rows[0].n, 3, 'three failures counted');
assert.strictEqual(rows[0].users, 2,
  'RULE 7 — a user who retries twice is ONE lost user, not two failures');

// ── DIRECTION 2: it stays silent on success ─────────────────────────────────
// The failure mode that makes an instrument worthless: firing on everything.
L.drain();
for (const ok of [200, 201, 202, 204, 301, 302, 304]) L.record('GET', '/api/usage', ok, 'u1');
assert.deepStrictEqual(L.drain(), [],
  'a 2xx/3xx must never enter the ledger, or the failure rate is meaningless');

// ── the boundary itself ─────────────────────────────────────────────────────
L.drain();
L.record('GET', '/api/usage', 399, 'u');
assert.deepStrictEqual(L.drain(), [], '399 is not a failure');
L.record('GET', '/api/usage', 400, 'u');
assert.strictEqual(L.drain().length, 1, '400 is');

// ── route normalisation: bounded cardinality ────────────────────────────────
assert.strictEqual(L.normalizeRoute('/api/video-jobs/re-edit'), '/api/video-jobs/re-edit',
  'longest prefix wins — re-edit must not be swallowed by /api/video-jobs');
assert.strictEqual(L.normalizeRoute('/api/video-jobs/abc-123'), '/api/video-jobs',
  'an id path collapses onto its route, so one job cannot make its own bucket');
assert.strictEqual(L.normalizeRoute('/api/chat/stream'), '/api/chat/stream');
assert.strictEqual(L.normalizeRoute('/api/chat'), '/api/chat');
assert.strictEqual(L.normalizeRoute('/wp-login.php'), '/__static');
assert.strictEqual(L.normalizeRoute('/api/does-not-exist'), '/__unrouted',
  'unknown API paths share ONE bucket — a scanner must not inflate the key space');

// THE PRIMARY DEFENCE is the unrouted collapse: a probe loop over 1000 invented
// paths must produce ONE bucket, not 1000. (The MAX_KEYS cap below is the
// backstop; this is what actually holds under a scanner.)
L.drain();
for (let i = 0; i < 1000; i += 1) L.record('GET', `/api/x${i}`, 404, `u${i}`);
rows = L.drain();
assert.strictEqual(rows.length, 1, `1000 invented paths must make ONE bucket, got ${rows.length}`);
assert.strictEqual(rows[0].route, '/__unrouted');
assert.strictEqual(rows[0].n, 1000, 'collapsing the key must not lose the count');

// THE BACKSTOP. Even across the real surface (33 routes x methods x codes) the
// key space is bounded, and what it drops is COUNTED — a silent cap would read
// as "no failures" precisely when the server is worst off.
L.drain();
let made = 0;
for (const r of L.KNOWN_PREFIXES) {
  for (const m of ['GET', 'POST', 'DELETE']) {
    for (let c = 400; c < 500; c += 1) { L.record(m, r, c, `u${made}`); made += 1; }
  }
}
assert.ok(made > L.MAX_KEYS, `the probe must exceed the cap to test it (${made})`);
rows = L.drain();
assert.ok(rows.length <= L.MAX_KEYS + 1, `key space capped, got ${rows.length}`);
const ov = rows.find((r) => r.route === '/__overflow');
assert.ok(ov && ov.n > 0, 'overflow is COUNTED, not silently dropped — a silent cap reads as "no failures"');
assert.strictEqual(rows.reduce((s, r) => s + r.n, 0), made, 'capped or not, every failure is still in the total');

// ── actor extraction never leaks the token, and never throws ────────────────
const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${
  Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
assert.strictEqual(
  L.actorFromRequest({ headers: { authorization: `Bearer ${jwt({ sub: 'user-abcdef12' })}` } }),
  'user-abcdef12');
for (const bad of [
  {}, { headers: {} }, { headers: { authorization: 'Bearer garbage' } },
  { headers: { authorization: 'Basic xyz' } },
  { headers: { authorization: `Bearer ${jwt({ nosub: 1 })}` } },
  null, undefined,
]) {
  assert.strictEqual(L.actorFromRequest(bad), null, `must not throw or guess on ${JSON.stringify(bad)}`);
}

// ── AN INSTRUMENT NEVER THROWS ──────────────────────────────────────────────
// If measuring can crash the server, the measurement costs more than it buys.
L.record(undefined, undefined, undefined, undefined);
L.record('GET', '/api/chat', 'not-a-number', {});
L.record(null, null, 500, null);
L.attach({}, { on() { throw new Error('listener exploded'); } });
L.attach(null, null);

// ── attach() records the REAL status, and only on finish ────────────────────
L.drain();
let fire = null;
const res = { statusCode: 200, on(ev, fn) { if (ev === 'finish') fire = fn; } };
L.attach({ method: 'POST', url: '/api/chat?x=1', headers: {} }, res);
assert.deepStrictEqual(L.drain(), [], 'nothing is recorded before the response finishes');
res.statusCode = 502;              // the status is only true at finish time
fire();
rows = L.drain();
assert.strictEqual(rows.length, 1);
assert.strictEqual(rows[0].code, 502, 'the status must be read at finish, not at attach');
assert.strictEqual(rows[0].route, '/api/chat', 'the query string must not enter the route key');

// ── flush: a DB failure loses counts but never throws or blocks ─────────────
(async () => {
  L.drain();
  L.record('POST', '/api/chat', 500, 'u1');
  const quiet = { log() {}, warn() {} };
  const broken = { from: () => ({ insert: async () => ({ error: { message: 'pg down' } }) }) };
  assert.strictEqual(await L.flush(broken, quiet), 0, 'a broken DB flushes zero, does not throw');

  L.record('POST', '/api/chat', 500, 'u1');
  const thrower = { from: () => { throw new Error('boom'); } };
  assert.strictEqual(await L.flush(thrower, quiet), 0);

  let captured = null;
  const good = { from: () => ({ insert: async (rowsIn) => { captured = rowsIn; return { error: null }; } }) };
  L.record('POST', '/api/chat', 502, 'u1');
  L.record('POST', '/api/chat', 502, 'u2');
  assert.strictEqual(await L.flush(good, quiet), 1);
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].event, 'api_outcome');
  assert.deepStrictEqual(captured[0].props,
    { route: '/api/chat', code: 502, method: 'POST', n: 2, users: 2 });

  assert.strictEqual(await L.flush(good, quiet), 0, 'an empty ledger writes nothing');
  assert.strictEqual(await L.flush(null, quiet), 0, 'no supabase -> no write, no throw');

  // The flush must EMPTY the ledger, or every minute re-reports the same failures
  // as new ones and the 30-day rate is cumulative nonsense.
  L.record('POST', '/api/chat', 500, 'u1');
  await L.flush(good, quiet);
  assert.deepStrictEqual(L.drain(), [], 'flush drains; counts are never double-reported');

  console.log('[smoke] api outcome ledger: ALL PASS (counts failures, silent on 2xx, capped, never throws)');
})().catch((e) => { console.error('[smoke] FAILED:', e && e.message); process.exit(1); });

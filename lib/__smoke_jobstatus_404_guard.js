'use strict';

// Regression fence for the GET /api/video-jobs/:jobId runaway-poll guard.
//
// The bug this prevents: a client polling a dead job_id ~1.3x/sec forever, each
// poll a Supabase query (38,070 in one 24h window from <=5 users). If the guard is
// removed or its cap regresses, THIS smoke fails and the deploy-sanity gate blocks
// the release. Pure — no server, no DB, deterministic clock passed in.
//
// Run:  node lib/__smoke_jobstatus_404_guard.js   (exit 0 = pass, 1 = fail)

const assert = require('assert');
const { makeJob404Guard } = require('./job404-guard');

let t = 1_000_000; // deterministic clock; the guard never calls Date.now itself
const tick = (ms = 100) => (t += ms);

// ── 1. The first N polls reach the DB; every later poll short-circuits ──────────
{
  const g = makeJob404Guard({ shortCircuitAfter: 3, ttlMs: 60_000 });
  const key = 'userA:jobDead';

  // A confirmed-dead id: DB returns 404 each time it is allowed through.
  // Poll #1..#3 must hit the DB (check() says don't short-circuit), then record404.
  for (let i = 1; i <= 3; i++) {
    const pre = g.check(key, tick());
    assert.strictEqual(pre.shortCircuit, false, `poll ${i} must reach the DB (create-race window)`);
    const rec = g.record404(key, 'job_never_existed', t);
    assert.strictEqual(rec.count, i, 'count increments per 404');
  }
  // Poll #4+ must NOT reach the DB.
  for (let i = 4; i <= 50; i++) {
    const pre = g.check(key, tick());
    assert.strictEqual(pre.shortCircuit, true, `poll ${i} must short-circuit (no DB query)`);
    assert.strictEqual(pre.cause, 'job_never_existed', 'cause is preserved while short-circuiting');
  }
}

// ── 2. emitFirst fires EXACTLY once — cause persisted once, not per poll ─────────
{
  const g = makeJob404Guard({ shortCircuitAfter: 3 });
  const key = 'userB:jobX';
  const first = g.record404(key, 'identity_mismatch', tick());
  assert.strictEqual(first.emitFirst, true, 'first 404 emits the cause');
  let emits = first.emitFirst ? 1 : 0;
  for (let i = 0; i < 10; i++) {
    const r = g.record404(key, 'identity_mismatch', tick());
    if (r.emitFirst) emits++;
  }
  assert.strictEqual(emits, 1, 'the cause is persisted exactly once per (user,job), never per poll');
}

// ── 3. A 200 (clear) forgets the id — a genuinely new 404 later starts fresh ─────
{
  const g = makeJob404Guard({ shortCircuitAfter: 3 });
  const key = 'userC:jobRace';
  g.record404(key, 'job_never_existed', tick()); // #1 (create-race)
  g.record404(key, 'job_never_existed', tick()); // #2
  g.clear(key); // job committed → 200
  const pre = g.check(key, tick());
  assert.strictEqual(pre.shortCircuit, false, 'after a 200 the state resets — no stale short-circuit');
  assert.strictEqual(pre.count, 0, 'cleared id has no history');
}

// ── 4. TTL expiry re-opens the DB path (a job that could reappear is retried) ────
{
  const g = makeJob404Guard({ shortCircuitAfter: 3, ttlMs: 10_000 });
  const key = 'userD:jobTtl';
  for (let i = 0; i < 5; i++) g.record404(key, 'job_never_existed', tick(1));
  assert.strictEqual(g.check(key, t).shortCircuit, true, 'within TTL it short-circuits');
  const later = t + 20_000; // past the 10s TTL
  assert.strictEqual(g.check(key, later).shortCircuit, false, 'past TTL the DB path re-opens');
}

// ── 5. Memory is bounded — the map cannot grow without limit ─────────────────────
{
  const g = makeJob404Guard({ shortCircuitAfter: 3, maxEntries: 500 });
  for (let i = 0; i < 5000; i++) g.record404(`u:${i}`, 'job_never_existed', tick(1));
  assert.ok(g.size() <= 500, `map stays bounded (<=500), got ${g.size()}`);
}

console.log('✅ jobstatus-404 guard smoke: caps the runaway loop, persists cause once, bounded, self-resets.');

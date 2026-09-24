#!/usr/bin/env node
'use strict';
// THE FLAG RESOLVER, AND THE THING THAT MATTERS MOST IS THE QUERY COUNT.
//
// This file exists because of a live defect: the read-through cache was
// written ONLY on success, so with server_flags not yet applied every request
// issued a fresh query for a table that does not exist. A cache that only
// caches hits is not a cache — it is a rate limiter that never engages, and it
// engages least exactly when the dependency is unhealthy.
//
// So the first two legs COUNT QUERIES rather than assert a boolean. A
// correctness-only check would have passed the defective version: it resolved
// the right answer every time, it just asked the database to do it.
const assert = require('assert');
const f = require('./upload-flags');

let n = 0;
const failed = [];
const leg = (name, fn) => {
  try { fn(); n += 1; console.log(`   ok  ${name}`); }
  catch (e) { failed.push(name); console.log(`   FAIL  ${name}: ${e.message}`); }
};
const legAsync = async (name, fn) => {
  try { await fn(); n += 1; console.log(`   ok  ${name}`); }
  catch (e) { failed.push(name); console.log(`   FAIL  ${name}: ${e.message}`); }
};

const USER = 'ec702499-ca10-49e6-8850-df8f99840904';
const stub = (err) => {
  let queries = 0;
  return {
    get queries() { return queries; },
    from() { return { select: async () => { queries += 1; return { data: null, error: err }; } }; },
  };
};

(async () => {
  // L1 A MISSING TABLE IS ASKED ABOUT ONCE. PostgREST reports an unknown
  // relation as PGRST205, and that cannot resolve without a migration — a
  // human action — so retrying every 30s forever is pure load on a database
  // that can never answer differently.
  await legAsync('L1 a_missing_table_is_queried_once_not_per_request', async () => {
    f._resetFlagCache();
    const db = stub({ code: 'PGRST205', message: 'Could not find the table' });
    for (let i = 0; i < 50; i += 1) await f.resolve('s3_accelerate', USER, db);
    assert.strictEqual(db.queries, 1,
      `50 resolves issued ${db.queries} queries against a table that does not exist`);
  });

  // L2 AND A TRANSIENT ERROR BACKS OFF TOO, just not as far. A statement
  // timeout might clear on its own; a missing relation will not.
  await legAsync('L2 a_transient_error_also_stops_hammering', async () => {
    f._resetFlagCache();
    const db = stub({ code: '57014', message: 'statement timeout' });
    for (let i = 0; i < 50; i += 1) await f.resolve('s3_accelerate', USER, db);
    assert.strictEqual(db.queries, 1, `${db.queries} queries during a backoff window`);
  });

  // L3 THE ANSWER IS STILL RIGHT WHILE THE DATABASE IS UNREADABLE. Backing off
  // must not become "all flags off" — that would silently end a canary.
  await legAsync('L3 backing_off_falls_back_to_env_not_to_off', async () => {
    f._resetFlagCache();
    const db = stub({ code: 'PGRST205', message: 'Could not find the table' });
    const r = await f.resolve('s3_accelerate', USER, db);
    assert.strictEqual(r.on, true, 'the allowlisted account must still resolve ON');
    assert.strictEqual(r.from, 'env');
  });

  // L4 RECOVERY CLEARS IT. A backoff that never lifts is an outage of our own.
  await legAsync('L4 a_successful_read_clears_the_backoff', async () => {
    f._resetFlagCache();
    let mode = 'fail', queries = 0;
    const db = { from() { return { select: async () => {
      queries += 1;
      return mode === 'fail'
        ? { data: null, error: { code: '57014', message: 'statement timeout' } }
        : { data: [{ flag: 's3_accelerate', allowlist: [], percent: 0, enabled_all: true }], error: null };
    } }; } };
    await f.resolve('s3_accelerate', USER, db);
    assert.strictEqual(queries, 1);
    f._resetFlagCache();                 // stands in for the window expiring
    mode = 'ok';
    const r = await f.resolve('s3_accelerate', USER, db);
    assert.strictEqual(r.from, 'db');
    assert.strictEqual(r.source, 'all');
  });

  // L5 THE PERCENTAGE IS STABLE PER USER AND INDEPENDENT PER FLAG. A coin flip
  // would give one user an accelerated upload and a plain retry; a shared hash
  // would correlate two rollouts and make either one's result unreadable.
  leg('L5 percent_is_stable_per_user_and_independent_per_flag', () => {
    assert.strictEqual(f._pct('s3_accelerate', 'abc'), f._pct('s3_accelerate', 'abc'));
    let differs = 0;
    for (const u of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      if (f._pct('s3_accelerate', u) !== f._pct('upload_shrink', u)) differs += 1;
    }
    assert.ok(differs >= 6, `flags share too many buckets (${differs}/8 differ)`);
  });

  // L6 THE ENV KILL SWITCH IS COMPARED AS A STRING. S3_USE_ACCELERATE is
  // literally "false" in production, and Boolean("false") is true — the
  // classic way a kill switch stops killing.
  await legAsync('L6 the_string_false_does_not_read_as_true', async () => {
    f._resetFlagCache();
    const prev = process.env.S3_USE_ACCELERATE;
    process.env.S3_USE_ACCELERATE = 'false';
    const r = await f.resolve('s3_accelerate', '00000000-0000-0000-0000-000000000000', null);
    assert.strictEqual(r.on, false, '"false" must not enable the flag globally');
    if (prev === undefined) delete process.env.S3_USE_ACCELERATE;
    else process.env.S3_USE_ACCELERATE = prev;
  });

  if (failed.length) {
    console.log(`upload-flags: FAIL (${failed.join(', ')})`);
    process.exit(1);
  }
  console.log(`upload-flags: PASS (${n} legs — a missing table is asked about ONCE, `
    + `and backing off never means "off")`);
})();

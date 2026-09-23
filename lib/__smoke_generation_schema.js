#!/usr/bin/env node
'use strict';
// THE MIGRATION FILE IS A CLAIM ABOUT THE DATABASE, and this asserts the
// claim is at least internally complete. It cannot reach the database — the
// deploy gate runs without credentials, and a check that silently skips when
// it cannot connect is the worst of both — so it is explicit about what it
// does and does not prove:
//
//   PROVES   the file declares RLS on all three tables, the auth.users
//            cascade on all three, charged_at on both quote tables, and the
//            same state CHECK on both. Those are the four amendments made
//            when it was applied on 2026-09-23, and the failure mode being
//            guarded is a repo that drifts back to the version I proposed.
//   DOES NOT the database actually being in that shape. That was verified by
//   PROVE    reading pg_class / pg_attribute / pg_constraint / pg_indexes on
//            2026-09-23 and is recorded in the file's header. A later drift
//            would not be caught here.
//
// Saying the gap is the point. A check that claimed to verify the database
// would be believed, and believed checks that cannot do what they say are
// how a schema and its migration part company.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MIG = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'add-generation-quotes.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'rollback-generation-quotes.sql'), 'utf8');
const TABLES = ['generation_quotes', 'generation_batch_quotes', 'picked_clips'];
const QUOTE_TABLES = ['generation_quotes', 'generation_batch_quotes'];

let n = 0;
const failed = [];
const leg = (name, fn) => {
  try { fn(); n += 1; console.log(`   ok  ${name}`); }
  catch (e) { failed.push(name); console.log(`   FAIL  ${name}: ${e.message}`); }
};

// Slice the file into one block per CREATE TABLE so a leg cannot pass because
// the right words appear SOMEWHERE — the population is per table.
function block(t) {
  const i = MIG.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`);
  assert.ok(i >= 0, `no CREATE TABLE for ${t}`);
  const j = MIG.indexOf('CREATE TABLE IF NOT EXISTS', i + 10);
  return MIG.slice(i, j < 0 ? MIG.length : j);
}

leg('L1 all_three_tables_are_declared', () => {
  for (const t of TABLES) assert.ok(block(t).length > 100, t);
  assert.strictEqual((MIG.match(/CREATE TABLE IF NOT EXISTS/g) || []).length, 3);
});

// ACCOUNT DELETION HAS TO REACH EVERY TABLE THAT NAMES A USER. A table that
// opts out of the convention is the one that keeps rows after the account.
leg('L2 every_table_cascades_from_auth_users', () => {
  for (const t of TABLES) {
    assert.ok(/user_id\s+uuid NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/.test(block(t)),
      `${t} does not cascade from auth.users`);
  }
});

// RLS ON WITH ZERO POLICIES = service role only. A missing policy DENIES, so
// this is the safe direction to be wrong in — but only if it is actually on.
leg('L3 rls_is_enabled_on_every_table', () => {
  for (const t of TABLES) {
    assert.ok(MIG.includes(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`), t);
  }
  assert.ok(!/CREATE POLICY/i.test(MIG),
    'a policy would turn service-role-only into something else; none is intended');
});

// charged_at IS THE CRASH MATRIX'S ONLY WITNESS. Without it, "claimed with no
// job" is one state covering two opposite facts — money not taken, and money
// taken with nothing to show — and the repair for one is the wrong move for
// the other.
leg('L4 both_quote_tables_carry_charged_at', () => {
  for (const t of QUOTE_TABLES) {
    assert.ok(/charged_at\s+timestamptz/.test(block(t)), `${t} has no charged_at`);
  }
});

leg('L5 both_quote_tables_share_one_state_check', () => {
  const want = "CHECK (state IN ('open','claimed','settled','refunded','expired'))";
  for (const t of QUOTE_TABLES) {
    assert.ok(block(t).includes(want), `${t} does not carry the shared state CHECK`);
  }
});

// The idempotency the picked-clips ruling rests on is a CONSTRAINT, not a
// check-then-insert — two taps arriving together both find no row otherwise.
leg('L6 picked_clips_is_unique_on_the_key', () => {
  assert.ok(block('picked_clips').includes('UNIQUE (user_id, upload_key)'));
});

// A ROLLBACK THAT SILENTLY DROPS LIVE COLUMNS IS THE SCRIPT THAT RUNS AT 2AM.
leg('L7 rollback_drops_the_tables_and_leaves_video_jobs_commented', () => {
  for (const t of TABLES) {
    assert.ok(ROLLBACK.includes(`DROP TABLE IF EXISTS ${t};`), `rollback misses ${t}`);
  }
  for (const line of ROLLBACK.split('\n')) {
    if (/ALTER TABLE video_jobs DROP COLUMN/.test(line)) {
      assert.ok(line.trim().startsWith('--'),
        `an uncommented drop on a live table: ${line.trim()}`);
    }
  }
  assert.ok(/ALTER TABLE video_jobs DROP COLUMN/.test(ROLLBACK),
    'the commented drops must still be present — the leg asserts nothing over an empty set');
});

if (failed.length) {
  console.log(`generation-schema: FAIL (${failed.join(', ')})`);
  process.exit(1);
}
console.log(`generation-schema: PASS (${n} legs — the FILE matches what was applied; the DATABASE was verified by read-back, not here)`);

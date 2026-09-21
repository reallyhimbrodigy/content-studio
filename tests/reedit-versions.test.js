'use strict';
const test = require('node:test');
const assert = require('node:assert');

const V = require('../lib/reedit-versions');

// Fixtures use the shapes that are ALREADY in prod, not invented ones. Measured
// 2026-09-21: 114 re-edit rows / 97 parents / 29 grandchildren / max 4 siblings
// on one parent, and two overlapping siblings off parent c4f4d5bf.

const row = (o) => ({
  id: 'x', user_id: 'u1', status: 'completed', created_at: '2026-09-01T00:00:00Z',
  parent_job_id: null, root_job_id: null, change_request: null, ...o,
});

const at = (n) => `2026-09-01T00:0${n}:00Z`;

test('version is the dense ordinal over completed rows, root-anchored', () => {
  const rows = [
    row({ id: 'a', created_at: at(0) }),
    row({ id: 'b', created_at: at(1), parent_job_id: 'a' }),
    row({ id: 'c', created_at: at(2), parent_job_id: 'b' }),
  ];
  assert.strictEqual(V.versionOf(rows, 'a'), 1);
  assert.strictEqual(V.versionOf(rows, 'b'), 2);
  assert.strictEqual(V.versionOf(rows, 'c'), 3);
  assert.strictEqual(V.versionCount(rows), 3);
});

test('SIBLINGS get DIFFERENT numbers — the defect depth-in-chain would cause', () => {
  // Both b and c hang off a. Depth would call both of them "v2". prod already
  // has a parent with four of these.
  const rows = [
    row({ id: 'a', created_at: at(0) }),
    row({ id: 'b', created_at: at(1), parent_job_id: 'a' }),
    row({ id: 'c', created_at: at(2), parent_job_id: 'a' }),
    row({ id: 'd', created_at: at(3), parent_job_id: 'a' }),
    row({ id: 'e', created_at: at(4), parent_job_id: 'a' }),
  ];
  const nums = ['a', 'b', 'c', 'd', 'e'].map((id) => V.versionOf(rows, id));
  assert.deepStrictEqual(nums, [1, 2, 3, 4, 5]);
  assert.strictEqual(new Set(nums).size, 5, 'no two versions may share a number');
});

test('a branch off an OLD version takes the next ordinal, not a sub-number', () => {
  // v1 re-edited while v3 exists. Ruling: allow the branch, number it linearly.
  const rows = [
    row({ id: 'v1', created_at: at(0) }),
    row({ id: 'v2', created_at: at(1), parent_job_id: 'v1' }),
    row({ id: 'v3', created_at: at(2), parent_job_id: 'v2' }),
    row({ id: 'v4', created_at: at(3), parent_job_id: 'v1' }), // branch off v1
  ];
  assert.strictEqual(V.versionOf(rows, 'v4'), 4);
  assert.strictEqual(V.versionCount(rows), 4);
});

test('a FAILED re-edit is not a version and does not consume a number', () => {
  const rows = [
    row({ id: 'a', created_at: at(0) }),
    row({ id: 'bad', created_at: at(1), parent_job_id: 'a', status: 'failed' }),
    row({ id: 'b', created_at: at(2), parent_job_id: 'a' }),
  ];
  assert.strictEqual(V.versionOf(rows, 'bad'), null, 'a failure is not openable');
  assert.strictEqual(V.versionOf(rows, 'b'), 2, 'must be v2, not v3 — no gap');
  assert.strictEqual(V.versionCount(rows), 2);
  assert.ok(!V.buildVersionList(rows).some((e) => e.job_id === 'bad'));
});

test('a LATER failure never renumbers an EARLIER version', () => {
  // The property that makes read-time computation safe: numbers already shown
  // to a user must not move when something else fails afterwards.
  const base = [
    row({ id: 'a', created_at: at(0) }),
    row({ id: 'b', created_at: at(1), parent_job_id: 'a' }),
  ];
  const before = V.versionOf(base, 'b');
  const after = V.versionOf(
    [...base, row({ id: 'c', created_at: at(2), parent_job_id: 'b', status: 'failed' })],
    'b');
  assert.strictEqual(before, 2);
  assert.strictEqual(after, 2);
});

test('canceled is not a version either', () => {
  const rows = [
    row({ id: 'a', created_at: at(0) }),
    row({ id: 'x', created_at: at(1), parent_job_id: 'a', status: 'canceled' }),
  ];
  assert.strictEqual(V.versionCount(rows), 1);
});

test('needs_input counts as IN FLIGHT — the ask-back park blocks a second re-edit', () => {
  // 19 of 114 re-edits sit here. If this did not block, a user holding an
  // unanswered question could start a second render of the same video.
  const rows = [
    row({ id: 'a', created_at: at(0) }),
    row({ id: 'parked', created_at: at(1), parent_job_id: 'a', status: 'needs_input' }),
  ];
  const live = V.findInFlight(rows);
  assert.ok(live, 'a parked ask must block');
  assert.strictEqual(live.id, 'parked');
  assert.strictEqual(V.versionCount(rows), 1, 'and it is not yet a version');
});

test('queued and processing block; terminal states do not', () => {
  for (const s of ['queued', 'processing', 'needs_input']) {
    assert.ok(V.isInFlight(s), `${s} must block`);
  }
  for (const s of ['completed', 'failed', 'canceled']) {
    assert.ok(!V.isInFlight(s), `${s} must not block`);
  }
});

test('findInFlight returns the OLDEST so the 409 answer is stable across polls', () => {
  const rows = [
    row({ id: 'a', created_at: at(0) }),
    row({ id: 'p2', created_at: at(3), parent_job_id: 'a', status: 'queued' }),
    row({ id: 'p1', created_at: at(2), parent_job_id: 'a', status: 'processing' }),
  ];
  assert.strictEqual(V.findInFlight(rows).id, 'p1');
});

test('findInFlight is null on a settled tree', () => {
  assert.strictEqual(V.findInFlight([row({ id: 'a' })]), null);
});

test('provisionalVersion is the number the in-flight job will take', () => {
  const rows = [
    row({ id: 'a', created_at: at(0) }),
    row({ id: 'b', created_at: at(1), parent_job_id: 'a' }),
    row({ id: 'live', created_at: at(2), parent_job_id: 'b', status: 'processing' }),
  ];
  assert.strictEqual(V.provisionalVersion(rows.filter((r) => r.id !== 'live')), 3);
  assert.strictEqual(V.versionOf(rows, 'live'), null, 'not a version until it completes');
});

test('ordering is deterministic when created_at ties', () => {
  const same = '2026-09-01T00:00:00Z';
  const a = [row({ id: 'zzz', created_at: same }), row({ id: 'aaa', created_at: same })];
  const b = [row({ id: 'aaa', created_at: same }), row({ id: 'zzz', created_at: same })];
  assert.deepStrictEqual(
    V.buildVersionList(a).map((e) => e.job_id),
    V.buildVersionList(b).map((e) => e.job_id),
    'input order must not change the numbering');
});

test('resolveRootId: an original is its own root', () => {
  assert.strictEqual(V.resolveRootId(row({ id: 'a' })), 'a');
});

test('resolveRootId: a backfilled re-edit reads its stored root', () => {
  assert.strictEqual(
    V.resolveRootId(row({ id: 'c', parent_job_id: 'b', root_job_id: 'a' })), 'a');
});

test('resolveRootId REFUSES to guess on an un-backfilled re-edit', () => {
  // Returning `id` here would make v3 its own root and strand v1 and v2. The
  // caller must walk parent_job_id instead.
  assert.strictEqual(
    V.resolveRootId(row({ id: 'c', parent_job_id: 'b', root_job_id: null })), null);
});

test('buildVersionList carries the change_request that produced each version', () => {
  const rows = [
    row({ id: 'a', created_at: at(0) }),
    row({ id: 'b', created_at: at(1), parent_job_id: 'a', change_request: 'faster cuts' }),
  ];
  const list = V.buildVersionList(rows);
  assert.strictEqual(list[0].change_request, null, 'the original had no change request');
  assert.strictEqual(list[1].change_request, 'faster cuts');
});

test('empty and malformed input do not throw', () => {
  assert.strictEqual(V.versionCount([]), 0);
  assert.strictEqual(V.versionCount(null), 0);
  assert.strictEqual(V.findInFlight(null), null);
  assert.strictEqual(V.resolveRootId(null), null);
  assert.deepStrictEqual(V.buildVersionList(undefined), []);
});

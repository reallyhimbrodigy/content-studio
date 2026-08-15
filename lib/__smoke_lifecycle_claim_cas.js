// LOST-UPDATE GUARD on the lifecycle-push claim [Law 2, Rule 1].
//
// The defect this exists to make impossible: claimLifecyclePush read-merge-wrote
// the `result` jsonb, so a worker result landing between its SELECT and its
// UPDATE was erased — leaving `{lifecycle_push_v1}` and nothing else. Measured
// at 180/466 completions (38.6%), 161 distinct users, and it is not cosmetic:
// the erased envelope is the evidence resolveSpawnedCompletionFallback reads to
// confirm completion, so a clobbered job rides the slow recovery path (p50 304s
// vs 84s when the envelope survives).
//
// The fake Supabase below reproduces the interleaving EXACTLY: the worker's
// write lands during the claim's read-modify-write window, once, deterministically.
// No network, no DB.
const assert = require('assert');
const { claimLifecyclePush } = require('./lifecycle-push');

const WORKER_RESULT = {
  video_url: 'https://x/v.mp4', stage_timings: { render: 42 },
  route: 'standard_editorial', transcript: 'hello',
};

function makeDb({ landWorkerWriteDuringClaim }) {
  const state = { result: {}, updated_at: '2026-08-14T00:00:00.000Z' };
  let reads = 0;
  const api = {
    from() { return api; },
    select() { return api; },
    eq(col, val) { (api._f = api._f || []).push(['eq', col, val]); return api; },
    is(col, val) { (api._f = api._f || []).push(['is', col, val]); return api; },
    async maybeSingle() {
      reads += 1;
      const snapshot = { result: JSON.parse(JSON.stringify(state.result)), updated_at: state.updated_at };
      // THE RACE: after the claim has read, the worker lands its result.
      if (landWorkerWriteDuringClaim && reads === 1) {
        state.result = { ...state.result, ...WORKER_RESULT };
        state.updated_at = '2026-08-14T00:00:05.000Z';   // every worker patch bumps it
      }
      api._f = [];
      return { data: snapshot, error: null };
    },
    update(patch) { api._patch = patch; return api; },
    async select_() { return null; },
  };
  // .update(...).eq(...).is(...).select('id') — terminal call
  const origSelect = api.select;
  api.select = function (arg) {
    if (api._patch === undefined) return origSelect.call(api);
    const filters = api._f || []; api._f = [];
    const patch = api._patch; api._patch = undefined;
    // enforce the CAS + claim guards against live state
    for (const [op, col, val] of filters) {
      if (op === 'eq' && col === 'updated_at' && state.updated_at !== val) {
        return Promise.resolve({ data: [], error: null });          // CAS lost
      }
      if (op === 'is' && col.startsWith('result->')) {
        const parts = col.split('->'); const kind = parts[2];
        const marks = state.result.lifecycle_push_v1 || {};
        if (kind && marks[kind]) return Promise.resolve({ data: [], error: null });
      }
    }
    state.result = patch.result;
    state.updated_at = '2026-08-14T00:00:09.000Z';
    return Promise.resolve({ data: [{ id: 'job-1' }], error: null });
  };
  return { api, state };
}

(async () => {
  // 1) THE RACE — the worker's write lands mid-claim. It must survive.
  const raced = makeDb({ landWorkerWriteDuringClaim: true });
  const r1 = await claimLifecyclePush(raced.api, 'job-1', 'completed');
  assert.strictEqual(r1.won, true, `the claim must still succeed under the race (got ${r1.reason})`);
  assert.ok(raced.state.result.lifecycle_push_v1 &&
            raced.state.result.lifecycle_push_v1.completed, 'the push claim must be recorded');
  for (const k of Object.keys(WORKER_RESULT)) {
    assert.deepStrictEqual(raced.state.result[k], WORKER_RESULT[k],
      `THE LOST UPDATE IS BACK: the worker's "${k}" was erased by the push claim. `
      + 'This is the 180/466 envelope-loss class — it destroys the telemetry AND '
      + 'strands the job on the slow recovery path.');
  }
  assert.notDeepStrictEqual(Object.keys(raced.state.result).sort(), ['lifecycle_push_v1'],
    'result must never end up as lifecycle_push_v1 alone');

  // 2) NO RACE — the ordinary path is unchanged: claim wins on the first try.
  const calm = makeDb({ landWorkerWriteDuringClaim: false });
  calm.state.result = { ...WORKER_RESULT };
  const r2 = await claimLifecyclePush(calm.api, 'job-1', 'completed');
  assert.strictEqual(r2.won, true, 'the uncontended claim must still win');
  assert.strictEqual(calm.state.result.video_url, WORKER_RESULT.video_url);

  // 3) ALREADY PUSHED — exactly-once is untouched by the CAS.
  const dup = makeDb({ landWorkerWriteDuringClaim: false });
  dup.state.result = { ...WORKER_RESULT, lifecycle_push_v1: { completed: '2026-08-14T00:00:00Z' } };
  const r3 = await claimLifecyclePush(dup.api, 'job-1', 'completed');
  assert.strictEqual(r3.won, false, 'a second claim must not win');
  assert.strictEqual(r3.reason, 'already_pushed');

  // 4) A DIFFERENT kind on the same job is still claimable (per-(job,kind)).
  const other = makeDb({ landWorkerWriteDuringClaim: false });
  other.state.result = { ...WORKER_RESULT, lifecycle_push_v1: { failed: '2026-08-14T00:00:00Z' } };
  const r4 = await claimLifecyclePush(other.api, 'job-1', 'completed');
  assert.strictEqual(r4.won, true, 'a different kind must still be claimable');
  assert.ok(other.state.result.lifecycle_push_v1.failed, 'and must not erase the sibling mark');

  console.log('lifecycle-claim CAS smoke: PASS (race-safe merge, uncontended claim, exactly-once, per-kind)');
  process.exit(0);
})().catch((e) => {
  console.error('lifecycle-claim CAS smoke FAILED:', e && e.message);
  process.exit(1);
});

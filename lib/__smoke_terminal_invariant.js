// A ROW WITH A DELIVERABLE MAY NEVER BE TERMINAL-FAILED. [Law 2, Rule 1]
//
// 34 rows / 29 DISTINCT USERS are in exactly that state right now: a finished
// video sitting behind a row that says "This render hit our time limit." 32 of
// them carry completion_delivery='repair' — we FOUND the render, wrote the URL,
// set completed, and then something wrote failed on top ~41-47 minutes later.
//
// Every writer already guards on non-terminal; the reaper's guard predates the
// whole cohort (2026-07-10). The guards were present and 32 of 60 repairs (53%)
// still ended failed. So this is asserted as an INVARIANT ON THE ROW, not as
// another guard of the same shape that failed.
const assert = require('assert');
const {
  deliverableOn, violatesTerminalInvariant, terminalizeFailure, healedResult,
  reconcileTerminalInvariant,
} = require('./terminal-invariant');

// 1. THE INVARIANT, in every shape a deliverable reaches a row in.
for (const [name, row] of [
  ['rendered_video_url', { status: 'failed', rendered_video_url: 'https://x/v.mp4' }],
  ['result_url', { status: 'failed', result_url: 'https://x/v.mp4' }],
  ['hls_manifest_url', { status: 'failed', hls_manifest_url: 'https://x/i.m3u8' }],
  ['result.video_url (ENVELOPE shape)', { status: 'failed', result: { video_url: 'https://x/v.mp4' } }],
  ['result.output.video_url (OUTPUT shape)', { status: 'failed', result: { output: { video_url: 'https://x/v.mp4' } } }],
  ['status=error', { status: 'error', rendered_video_url: 'https://x/v.mp4' }],
]) {
  assert.strictEqual(violatesTerminalInvariant(row), true,
    `a deliverable via ${name} on a terminal-failed row must be a VIOLATION — that is `
    + 'a user being told their finished video failed');
}

// 2. NO FALSE POSITIVES. A genuine failure and a completed row are both fine.
for (const [name, row] of [
  ['genuine failure', { status: 'failed', rendered_video_url: null, result: { error_code: 'NO_SPEECH' } }],
  ['completed with a video', { status: 'completed', rendered_video_url: 'https://x/v.mp4' }],
  ['still processing', { status: 'processing', rendered_video_url: null }],
  ['empty result', { status: 'failed', result: {} }],
  ['null row', null],
]) {
  assert.strictEqual(violatesTerminalInvariant(row), false, `${name} must NOT be flagged`);
}
assert.strictEqual(deliverableOn({ result: { output: {} } }), null, 'empty output is not a deliverable');

// 3. THE WRITE PATH HEALS RATHER THAN REFUSES. Refusing would strand the row
//    non-terminal — the 900s reaper wall again. A deliverable means COMPLETE.
// THE FILTERS ARE APPLIED, AND THE GUARD IS READ FROM THE QUERY (2026-09-10).
// `eq()` and `not()` discarded their arguments and `then()` reported every write
// as WON, so this file tested the violation PREDICATE exhaustively — five
// deliverable shapes, no false positives — and tested nothing whatsoever about
// the queries that feed it. Four mutations against terminal-invariant.js all
// stayed GREEN: naming a different job on all three sites, narrowing
// terminalList, the sweep reading completed instead of failed, and the sweep
// dropping its has-a-deliverable filter. Thorough in exactly the half that was
// not broken.
function fakeDb(row, { id = (row && row.id) || 'j1' } = {}) {
  const calls = [];
  const f = {};
  let guard = null;             // the .not('status','in',LIST) the caller passed
  const api = {
    from() { return api; },
    select() { return api; },
    update(patch) { calls.push(patch); return api; },
    eq(col, val) { f[col] = val; return api; },
    not(col, op, val) { guard = { col, op, val }; return api; },
    limit() {
      // A read scoped to another id finds nothing, exactly as Postgres answers.
      const hit = row && (f.id === undefined || f.id === id);
      return Promise.resolve({ data: hit ? [row] : [] });
    },
    then(res) {
      // The write's terminal. Evaluate the guard the caller actually passed —
      // NOT what the fixture happens to know — so a guard that names the wrong
      // statuses, or no guard at all, changes the outcome here.
      let blocked = false;
      if (guard && guard.op === 'in') {
        const wanted = String(guard.val || '').replace(/^\(|\)$/g, '')
          .split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean);
        blocked = !!row && wanted.includes(String(row[guard.col] || ''));
      }
      const scoped = f.id === undefined || f.id === id;
      return Promise.resolve({ data: (blocked || !scoped) ? [] : [{ id }] }).then(res);
    },
  };
  return { api, calls };
}
(async () => {
  const quiet = { error() {}, log() {} };

  const withVid = fakeDb({ id: 'j1', status: 'processing', rendered_video_url: 'https://x/v.mp4',
    result: { error_code: 'PLATFORM_TIMEOUT', reaped: true } });
  const r1 = await terminalizeFailure(withVid.api, 'j1',
    { status: 'failed', error_message: 'timed out' }, { log: quiet });
  assert.strictEqual(r1.outcome, 'healed',
    'a row carrying a deliverable must be HEALED to completed, never failed');
  const healPatch = withVid.calls[withVid.calls.length - 1];
  assert.strictEqual(healPatch.status, 'completed', 'the heal must write completed');
  assert.strictEqual(healPatch.progress, 100, 'a delivered row is 100%');
  assert.ok(!healPatch.error_message,
    'the heal must not carry the failure copy — the user gets their video, not an '
    + 'apology. Explicit null is REQUIRED (not merely absent): the row already has '
    + 'the old copy persisted, so omitting the key leaves it there.');


  // 6. THE COPY HEALS TOO — found by STAGING the first batch of three live rows.
  //    They flipped to completed while error_message still read "This render hit
  //    our time limit — you weren't charged" and result still carried
  //    error_code=PLATFORM_TIMEOUT + reaped:true. A completed job that also says
  //    it timed out is a contradiction the USER READS, and a lingering
  //    result.error_code is exactly what breaks a _delivered predicate.
  assert.strictEqual(healPatch.error_message, null,
    'the heal must CLEAR the failure copy — a completed row carrying "this render '
    + 'hit our time limit" is a contradiction the user reads');
  const hr = healPatch.result;
  assert.ok(hr && !hr.error_code && !hr.error && !hr.reaped,
    'the heal must strip error keys from result — a completed row with '
    + 'result.error_code breaks every downstream _delivered predicate');
  assert.strictEqual(hr.healed_from, 'PLATFORM_TIMEOUT',
    'the heal must PRESERVE which class stranded the row — a heal that erased its '
    + 'own cause makes the class unmeasurable, which is how this one survived 4 days');
  const kept = healedResult({ error_code: 'X', stage_timings: { render: 12 } });
  assert.strictEqual(kept.stage_timings.render, 12,
    'the heal must keep non-error telemetry — stripping the whole result would '
    + 'destroy the render measurements for exactly the jobs we care about');

  // 4. A GENUINE FAILURE STILL FAILS. An invariant that suppressed real failures
  //    would trade a visible lie for an invisible one.
  const noVid = fakeDb({ id: 'j2', status: 'processing', rendered_video_url: null });
  const r2 = await terminalizeFailure(noVid.api, 'j2',
    { status: 'failed', error_message: 'no speech' }, { log: quiet });
  assert.strictEqual(r2.outcome, 'failed', 'a job with NO deliverable must still fail');
  const failPatch = noVid.calls[noVid.calls.length - 1];
  assert.strictEqual(failPatch.status, 'failed');
  assert.strictEqual(failPatch.error_message, 'no speech', 'the honest reason must survive');

  // 5. FAIL SAFE ON AN UNREADABLE ROW — a read outage must not strand every
  //    failing job as non-terminal.
  // The read rejects, so no filter can change this case's outcome — but they are
  // still recorded rather than defined as no-ops. A stub that discards arguments
  // is the shape that hid four defects in this file; not repeating it costs one
  // line, and "it cannot matter here" is exactly what was believed about the
  // others.
  const brokenFilters = {};
  const broken = { from() { return broken; }, select() { return broken; },
    eq(col, val) { brokenFilters[col] = val; return broken; },
    not(col, op, val) { brokenFilters[`not:${col}`] = `${op} ${val}`; return broken; },
    update() { return broken; },
    limit() { return Promise.reject(new Error('db down')); },
    then(res) { return Promise.resolve({ data: [{ id: 'j3' }] }).then(res); } };
  const r3 = await terminalizeFailure(broken, 'j3', { status: 'failed' }, { log: quiet });
  assert.strictEqual(r3.outcome, 'failed',
    'an unreadable row must fall back to writing the failure, never hang non-terminal');
  assert.strictEqual(brokenFilters.id, 'j3',
    'even the fallback write must be scoped to the job it was asked about');

  // 4. AN EXISTING TERMINAL SURVIVES — and the guard must name ALL of them.
  //    Every fixture above is 'processing', so the terminal list was never
  //    exercised here: narrowing it to '(completed)' changed nothing and stayed
  //    green. Drive all four, so the guard has to name all four.
  for (const status of ['completed', 'failed', 'canceled', 'needs_input']) {
    const already = fakeDb({ id: `t-${status}`, status, rendered_video_url: null });
    // eslint-disable-next-line no-await-in-loop
    const r = await terminalizeFailure(already.api, `t-${status}`,
      { status: 'failed', error_message: 'a later, vaguer failure' }, { log: quiet });
    assert.strictEqual(r.outcome, 'noop',
      `an already-${status} row must not be overwritten — its real cause is the `
      + 'one the user is owed, and a generic later failure would erase it');
  }

  // 5. THE SWEEP'S OWN QUERY. Never driven before, so its two filters were free:
  //    reading 'completed' rows instead of failed, or dropping the
  //    has-a-deliverable filter, both stayed green. The store below contains one
  //    genuine violation and three decoys that each differ from it in exactly
  //    one of the filtered columns.
  const store = [
    // THE violation: failed, and it carries a deliverable.
    { id: 's1', user_id: 'u1', status: 'failed', rendered_video_url: 'https://x/v.mp4', result: {} },
    // decoy: failed but genuinely has nothing — an honest failure, not a violation.
    { id: 's2', user_id: 'u2', status: 'failed', rendered_video_url: null, result: {} },
    // decoy: has a deliverable but is already completed — correct, not a violation.
    { id: 's3', user_id: 'u3', status: 'completed', rendered_video_url: 'https://x/v.mp4', result: {} },
    // decoy: still running.
    { id: 's4', user_id: 'u4', status: 'processing', rendered_video_url: null, result: {} },
  ];
  const sweepDb = { from: () => {
    const f = {}; const nots = [];
    const q = {
      select: () => q,
      eq: (col, val) => { f[col] = val; return q; },
      not: (col, op, val) => { nots.push({ col, op, val }); return q; },
      limit: () => Promise.resolve({
        data: store.filter((r) => Object.entries(f).every(([c, v]) => r[c] === v)
          && nots.every((nt) => (nt.op === 'is' && nt.val === null
            ? r[nt.col] !== null && r[nt.col] !== undefined
            : true))),
        error: null,
      }),
    };
    return q;
  } };
  const sweep = await reconcileTerminalInvariant(sweepDb, { apply: false, log: quiet });
  assert.strictEqual(sweep.violations, 1,
    'exactly one row is failed AND carries a deliverable — the decoys differ from '
    + 'it in exactly one filtered column each, so a wrong filter changes this number');
  assert.strictEqual(sweep.users, 1);
  assert.strictEqual(sweep.applied, 0, 'the default reports and changes nothing');
  // Deliberately NOT asserted: dropping `.not('rendered_video_url','is',null)`
  // from the sweep. Checked by mutation and it is not a defect — the sweep
  // re-filters in JS with violatesTerminalInvariant, so the SQL filter is a
  // narrowing optimisation, not the correctness boundary. s2 (failed, nothing
  // to deliver) is rejected either way. Saying so beats writing a test that
  // would only pin the query shape and call it a guarantee.

  console.log('terminal invariant smoke: PASS (violation detected in all 5 deliverable '
    + 'shapes, no false positives, write path HEALS to completed, genuine failures still '
    + 'fail, read outage fails safe)');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

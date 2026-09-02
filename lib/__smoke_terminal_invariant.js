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
function fakeDb(row) {
  const calls = [];
  const api = {
    from() { return api; },
    select() { return api; },
    update(patch) { calls.push(patch); return api; },
    eq() { return api; },
    not() { return api; },
    limit() { return Promise.resolve({ data: row ? [row] : [] }); },
    then(res) { return Promise.resolve({ data: [{ id: 'j1' }] }).then(res); },
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
  const broken = { from() { return broken; }, select() { return broken; },
    eq() { return broken; }, not() { return broken; }, update() { return broken; },
    limit() { return Promise.reject(new Error('db down')); },
    then(res) { return Promise.resolve({ data: [{ id: 'j3' }] }).then(res); } };
  const r3 = await terminalizeFailure(broken, 'j3', { status: 'failed' }, { log: quiet });
  assert.strictEqual(r3.outcome, 'failed',
    'an unreadable row must fall back to writing the failure, never hang non-terminal');

  console.log('terminal invariant smoke: PASS (violation detected in all 5 deliverable '
    + 'shapes, no false positives, write path HEALS to completed, genuine failures still '
    + 'fail, read outage fails safe)');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

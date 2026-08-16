// A FAILURE MUST NAME THE LAYER THAT ACTUALLY FAILED [Law 2, Rule 1].
//
// For ten hours on 2026-08-16, ~50 jobs across 40 DISTINCT USERS were labelled
// DISPATCH_UNREACHABLE and told "we had trouble reaching the render service."
// 49 of 55 of those rows carried BOTH worker_started_at AND modal_call_id, and
// 48 of 55 died at step=plan. The worker was reached every single time.
//
// The label named the wrong layer, so every investigation it triggered began at
// the dispatcher — the one component that had done its job correctly. That is
// not a cosmetic defect: it is a permanent misdirection encoded into the rows.
const assert = require('assert');
const { dispatchFailureResult } = require('./video-processor/dispatch-to-modal');
const { dispatchErrorMessage } = require('./failure-copy');

// 1. WORKER REACHED -> the code, class and location must all name the WORKER.
const reached = dispatchFailureResult({
  httpStatus: null, userMessage: 'x', detail: 'd', workerReached: true,
});
assert.strictEqual(reached.error_code, 'WORKER_DIED_AFTER_START',
  'a job whose worker started must NOT be labelled unreachable — that sends every '
  + 'future investigation to the dispatcher, which had worked correctly');
assert.strictEqual(reached.error_class, 'worker',
  'error_class must name the worker, not dispatch');
assert.ok(/worker/.test(reached.error_where),
  `error_where must point at the worker, got ${reached.error_where}`);

// 2. WORKER NOT REACHED -> today's behaviour is UNCHANGED. A new code must not
//    swallow the genuine dispatch class; that would trade one wrong label for
//    another.
const unreached = dispatchFailureResult({
  httpStatus: null, userMessage: 'x', detail: 'd', workerReached: false,
});
assert.strictEqual(unreached.error_code, 'DISPATCH_UNREACHABLE',
  'a genuine dispatch failure must still be DISPATCH_UNREACHABLE');
assert.strictEqual(unreached.error_class, 'dispatch');
assert.strictEqual(
  dispatchFailureResult({ httpStatus: 404, userMessage: 'x', detail: 'd' }).error_code,
  'RENDER_UNAVAILABLE', '404 must still be RENDER_UNAVAILABLE');

// 3. THE DEFAULT IS SAFE. An un-threaded caller keeps today's label rather than
//    silently gaining a new one it never asked for.
assert.strictEqual(
  dispatchFailureResult({ httpStatus: null, userMessage: 'x', detail: 'd' }).error_code,
  'DISPATCH_UNREACHABLE', 'workerReached must default to false');

// 4. THE COPY MUST NOT CLAIM AN UNREACHABLE SERVICE WHEN ONE WAS REACHED.
const copyReached = dispatchErrorMessage(true);
const copyUnreached = dispatchErrorMessage(false);
assert.ok(!/reaching the render service/i.test(copyReached),
  'the worker-died copy still claims the render service was unreachable — it was '
  + `reached and it started: ${copyReached}`);
assert.ok(/reaching the render service/i.test(copyUnreached),
  'the genuine dispatch copy changed; that class is still real');
assert.notStrictEqual(copyReached, copyUnreached,
  'both classes must not share one sentence — that is how the wrong layer got named');
assert.ok(!/your video|your fault/i.test(copyReached) || /nothing was wrong with your video/i.test(copyReached),
  'the copy must not imply the user\'s video was at fault');

// 5. THE CLASSIFICATION MUST BE EVIDENCE-DRIVEN, not exception-shape-driven — a
//    dispatcher throw looks identical whether or not a worker ran.
const src = require('fs').readFileSync(
  require('path').join(__dirname, 'video-processor/dispatch-to-modal.js'), 'utf8');
assert.ok(/select\('worker_started_at, modal_call_id'\)/.test(src),
  'the caller does not READ the row evidence — classification would be guesswork');
assert.ok(/_workerReached\s*=\s*false;\s*\/\/ on doubt/.test(src)
  || /catch \(_\) \{\s*_workerReached = false;/.test(src),
  'the evidence read must fail SAFE: on doubt keep the existing label, never invent one');

console.log('worker-reached classification smoke: PASS (worker-died named correctly, '
  + 'dispatch class intact, safe default, honest copy, evidence-driven)');
process.exit(0);

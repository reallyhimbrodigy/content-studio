'use strict';
// A worker STRANDED mid-render must be re-spawned, not surfaced as a failure.
//
// THE HOLE (Zac 2026-08-03). respawnDecision:
//     if (!workerNeverStarted(initial)) return 'as_is';
//     if (recheck.status === 'COMPLETED')  return 'project';
//     if (workerNeverStarted(recheck))     return 'respawn';
//     return 'as_is';                       <-- started, no terminal, stranded
// The final line catches a worker that STARTED AND DIED without writing a
// terminal — exactly what a drained container leaves behind — and classifies it
// `as_is`, so the user gets a failure for a render nothing was wrong with.
//
// WHY A FOURTH CASE IS SAFE HERE, given "never retry as an answer to failure":
// this is NOT retrying a failure. A failure produces a coded envelope, and that
// still returns `as_is` and is surfaced honestly. This case is the ABSENCE of
// any verdict — nobody decided anything, the container went away.
//
// THE DANGER IS DOUBLE-RENDER. A slow render still in flight looks identical to
// a stranded one, and re-spawning it would render and CHARGE twice. The only
// safe discriminator is time: past the worker's own function timeout the
// container provably cannot still be running. Under that deadline we wait.

const assert = require('assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test';

const {
  respawnDecision, workerNeverStarted, WORKER_FN_TIMEOUT_MS,
} = require('./video-processor/dispatch-to-modal');

const EMPTY = { status: 'FAILED', output: {} };
const STARTED_NO_TERMINAL = { status: 'FAILED', output: { stage_timings: { download: 1.2 } } };
const CODED_FAILURE = { status: 'FAILED', output: { error_code: 'RENDER_FATAL', stage_timings: {} } };
const DONE = { status: 'COMPLETED', output: { video_url: 'https://cdn/v.mp4' } };

const OVER = WORKER_FN_TIMEOUT_MS + 60_000;   // provably past the container's life
const UNDER = 60_000;                          // still plausibly rendering

// ── the three existing decisions are unchanged ──────────────────────────────
assert.strictEqual(respawnDecision(DONE, EMPTY, OVER), 'as_is',
  'a completed initial result is never re-spawned');
assert.strictEqual(respawnDecision(EMPTY, DONE, OVER), 'project',
  'rendered-but-write-lost must PROJECT, never re-render (never pay twice)');
assert.strictEqual(respawnDecision(EMPTY, EMPTY, OVER), 'respawn',
  'genuinely never started -> respawn');

// ── THE NEW CASE ────────────────────────────────────────────────────────────
assert.strictEqual(respawnDecision(EMPTY, STARTED_NO_TERMINAL, OVER), 'respawn',
  'started, no terminal, past the container lifetime -> STRANDED, re-spawn');

// ── THE GUARD THAT MATTERS: under the deadline we must NOT re-spawn ─────────
assert.strictEqual(respawnDecision(EMPTY, STARTED_NO_TERMINAL, UNDER), 'as_is',
  'a render still plausibly in flight must NOT be re-spawned — that renders and charges twice');

// ── a real failure is surfaced, never retried ───────────────────────────────
assert.strictEqual(respawnDecision(EMPTY, CODED_FAILURE, OVER), 'as_is',
  'a worker that produced a CODED failure has decided — surface it, do not retry');

// ── missing elapsed must fail safe (treat as still in flight) ───────────────
assert.strictEqual(respawnDecision(EMPTY, STARTED_NO_TERMINAL), 'as_is',
  'no elapsed known -> assume in flight, never re-spawn on a guess');
assert.strictEqual(respawnDecision(EMPTY, STARTED_NO_TERMINAL, null), 'as_is');

// ── the deadline must actually exceed the worker function timeout ───────────
assert.ok(WORKER_FN_TIMEOUT_MS >= 3000 * 1000 * 0.9,
  'the deadline must track the worker function timeout (3000s), or a live render can be double-spawned');

console.log('[smoke] respawn stranded: ALL PASS (stranded re-spawns; in-flight and coded-failure do not)');

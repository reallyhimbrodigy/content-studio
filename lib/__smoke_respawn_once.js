// Rule-1 smoke for RE-SPAWN-ONCE (dispatch-loss mitigation, Zac 2026-08-02).
// The detector decides whether to re-fire a spawn. A FALSE POSITIVE re-spawns a
// WEDGED render that actually ran → burns another ~900s (the compound wall we
// explicitly cap). A FALSE NEGATIVE leaves a never-started job to terminalize →
// the very class we are closing. So this boundary must be exact.
// Run: node lib/__smoke_respawn_once.js  (pure, no network).
const assert = require('assert');
const { workerNeverStarted, respawnDecision } = require('./video-processor/dispatch-to-modal');

let pass = 0;
const eq = (got, want, msg) => { assert.strictEqual(got, want, `${msg}: got ${got}, want ${want}`); pass++; };

// ── RE-SPAWNABLE: FAILED with an EMPTY worker envelope (worker never started) ──
eq(workerNeverStarted({ status: 'FAILED', output: {} }), true, 'FAILED + empty output → re-spawn');
eq(workerNeverStarted({ status: 'FAILED' }), true, 'FAILED + no output key → re-spawn');
eq(workerNeverStarted({ status: 'FAILED', output: { spawned: true, call_id: 'c1' } }),
   true, 'FAILED + only transport keys (no worker fields) → re-spawn');

// ── NOT re-spawnable: a WEDGED render that RAN (any worker output present) ──
eq(workerNeverStarted({ status: 'FAILED', output: { stage_timings: { total: 200 } } }),
   false, 'worker wrote stage_timings → wedged, do NOT re-spawn');
eq(workerNeverStarted({ status: 'FAILED', output: { error_code: 'RENDER_FATAL' } }),
   false, 'worker wrote a coded error → ran, do NOT re-spawn');
eq(workerNeverStarted({ status: 'FAILED', output: { video_url: 'https://cf/a.mp4' } }),
   false, 'worker wrote a delivery url → ran, do NOT re-spawn');
eq(workerNeverStarted({ status: 'FAILED', output: { public_url: 'x' } }), false, 'public_url → ran');
eq(workerNeverStarted({ status: 'FAILED', output: { rendered_video_url: 'x' } }), false, 'rendered_video_url → ran');

// ── NOT re-spawnable: anything not a FAILED terminal ──
eq(workerNeverStarted({ status: 'COMPLETED', output: {} }), false, 'COMPLETED → never re-spawn');
eq(workerNeverStarted({ status: 'needs_clarification' }), false, 'non-FAILED status → no re-spawn');
eq(workerNeverStarted(null), false, 'null → no re-spawn');
eq(workerNeverStarted(undefined), false, 'undefined → no re-spawn');

// ── THREE-WAY DECISION (Zac 2026-08-02): the rendered-but-write-lost guard ──
// initial and re-check are BOTH the completion-await shape; the re-check is a
// fresh Supabase read via resolveSpawnedCompletionFallback.
const EMPTY = { status: 'FAILED', output: {} };
const RENDERED = { status: 'COMPLETED', output: { video_url: 'https://cf/a.mp4' } };
const WEDGED = { status: 'FAILED', output: { error_code: 'RENDER_FATAL' } };

// 1. never-started: empty initial + STILL empty on re-check → re-spawn (safe, lost nothing)
eq(respawnDecision(EMPTY, EMPTY), 'respawn', 'empty+empty → re-spawn (never started)');
// 2. rendered-but-write-lost (476fe663): empty initial but re-check FINDS a result → PROJECT, never re-spawn
eq(respawnDecision(EMPTY, RENDERED), 'project', 'empty+rendered-on-recheck → project, NOT re-spawn (never pay twice)');
// 3. wedged render that ran: any worker output → as_is, never re-spawn
eq(respawnDecision(WEDGED, EMPTY), 'as_is', 'wedged initial → as_is (ran, do not re-spawn)');
eq(respawnDecision(EMPTY, WEDGED), 'as_is', 'empty initial but re-check surfaced worker output → as_is (wedged)');
// initial already completed → as_is regardless of re-check
eq(respawnDecision(RENDERED, EMPTY), 'as_is', 'completed initial → as_is (never re-spawn a delivered job)');

console.log(`[smoke] re-spawn-once: ALL PASS (${pass} assertions — detector two directions + three-way decision incl. rendered-but-write-lost → project, never pay twice)`);

// Rule-1 smoke for RE-SPAWN-ONCE (dispatch-loss mitigation, Zac 2026-08-02).
// The detector decides whether to re-fire a spawn. A FALSE POSITIVE re-spawns a
// WEDGED render that actually ran → burns another ~900s (the compound wall we
// explicitly cap). A FALSE NEGATIVE leaves a never-started job to terminalize →
// the very class we are closing. So this boundary must be exact.
// Run: node lib/__smoke_respawn_once.js  (pure, no network).
const assert = require('assert');
const { workerNeverStarted } = require('./video-processor/dispatch-to-modal');

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

console.log(`[smoke] re-spawn-once detector: ALL PASS (${pass} assertions — empty-envelope re-spawns, any worker output is wedged, non-FAILED never re-spawns)`);

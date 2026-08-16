// EVERY OUTER WALL MUST BE >= THE WORKER'S EXECUTION CEILING. [Law 2, Rule 1]
//
// MEASURED: the dispatcher awaited 900s while run_pipeline_bg carries
// `timeout=1200, retries=0`. It declared failure 300 SECONDS BEFORE MODAL WOULD
// EVEN KILL THE WORKER. Every terminalization clustered at 888-900s with ~4s
// spread across 8 samples — a TIMER, not work — and 55 of 107 terminal jobs on
// 2026-08-16 (51.4%) carried "dispatch threw: spawned job did not complete".
//
// ONE DEFECT PRODUCED BOTH BUCKETS:
//   finish between wall and ceiling -> artifact in S3, row already failed. That
//     is the 34 rows / 29 users stranded with a playable video.
//   miss the ceiling -> Modal kills it, no artifact, "spawned job did not
//     complete".
//
// The reaper already obeys this rule (EXEC_WALL 3300s, processing lease 3000s).
// The DISPATCHER'S OWN WAIT never was. This is that rule, written down.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, 'video-processor/dispatch-to-modal.js'), 'utf8');
// Comments are DOCUMENTATION, not behaviour. Matching a literal inside one is a
// false failure this repo has now written seven times — including in the very
// commit that added this file.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function num(name) {
  const m = CODE.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`));
  assert.ok(m, `${name} is gone — the wall contract is no longer declared`);
  return Number(m[1]);
}
const ceiling = num('WORKER_EXECUTION_CEILING_S');
const slack = num('WALL_SLACK_S');

// 1. THE INVARIANT.
assert.ok(slack > 0, 'the wall must carry slack for cold start + spawn queue');
const wall = ceiling + slack;
assert.ok(wall >= ceiling,
  `the dispatcher wall (${wall}s) is BELOW the worker ceiling (${ceiling}s) — that is `
  + 'the 900-vs-1200 defect exactly: failure declared while the worker is still rendering');
assert.ok(wall - ceiling >= 120,
  `only ${wall - ceiling}s of slack over the ceiling — a cold start plus spawn queue `
  + 'eats that, and the wall silently goes back under load');

// 2. NO RAW TIMER MAY SURVIVE. A second await hard-coding its own number is how
//    the two walls diverged in the first place: one was maintained, one was not.
assert.ok(!/timeoutMs:\s*\d+\s*\*\s*\d+\s*\*\s*\d+/.test(CODE),
  'a raw arithmetic timeout literal is back on an await — every spawn wait must '
  + 'derive from SPAWN_AWAIT_MS so the two can never diverge again');
const derived = (CODE.match(/timeoutMs:\s*SPAWN_AWAIT_MS/g) || []).length;
assert.strictEqual(derived, 2,
  `expected BOTH spawn awaits (initial + re-spawn) to derive from SPAWN_AWAIT_MS, `
  + `found ${derived} — the re-spawn path was missed once already`);
assert.ok(/SPAWN_AWAIT_MS\s*=\s*\(WORKER_EXECUTION_CEILING_S\s*\+\s*WALL_SLACK_S\)/.test(CODE),
  'SPAWN_AWAIT_MS no longer DERIVES from the ceiling — a hand-set number can drift '
  + 'under the ceiling without anything noticing');

// 3. THE REAPER MUST STAY ABOVE THE CEILING TOO. It is correct today; assert it
//    so a future tightening cannot quietly recreate the same class one file over.
const REAPER = fs.readFileSync(path.join(__dirname, 'job-reaper.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const execWall = REAPER.match(/EXEC_WALL_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/);
assert.ok(execWall, 'EXEC_WALL_MS is gone from the reaper');
const execWallS = Number(execWall[1]) * Number(execWall[2]) * Number(execWall[3]) / 1000;
assert.ok(execWallS >= ceiling,
  `the reaper EXEC_WALL (${execWallS}s) dropped below the worker ceiling (${ceiling}s) — `
  + 'a healthy long render would be false-reaped mid-flight');
const lease = REAPER.match(/processing:\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/);
assert.ok(lease, 'the processing lease is gone');
const leaseS = Number(lease[1]) * Number(lease[2]) * Number(lease[3]) / 1000;
assert.ok(leaseS >= ceiling,
  `the processing heartbeat lease (${leaseS}s) is below the worker ceiling (${ceiling}s)`);

console.log(`wall alignment smoke: PASS (dispatcher ${wall}s >= ceiling ${ceiling}s, `
  + `reaper wall ${execWallS}s, lease ${leaseS}s; both awaits derived, no raw timers)`);
process.exit(0);

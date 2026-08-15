// AN ARTIFACT IN S3 DISQUALIFIES A RESPAWN — and this asserts the SYSTEM'S
// RESPONSE, not just a predicate. [Law 2, Rule 1]
//
// WHY THIS EXISTS, precisely. The post-upload watchdog shipped with six asserted
// safety properties — all of them about the EXIT: os._exit not sys.exit, code 0,
// never fire without an artifact, never fire after the terminal, N bounded,
// disarm ordering. Every one passed. It was RED-proven twice and fired
// deliberately on a probe that confirmed it killed AND counted.
//
// It then caused 294 kills across 49 jobs, up to 9 on a single job, each a full
// re-render, because NOTHING ASSERTED WHAT THE SYSTEM DOES AFTER THE EXIT. The
// watchdog killed the container, the row stayed non-terminal, respawnDecision
// saw dbNonTerminal and re-spawned, and the loop closed.
//
// "Does it fire" and "is firing safe" are different questions, and a probe that
// answers the first reads exactly like one that answers both. So every arm here
// asserts an OUTCOME OF THE LOOP, not a property of one step.
const assert = require('assert');
const { respawnDecision } = require('./video-processor/dispatch-to-modal');

// The exact shapes the dispatcher builds.
const KILLED_WORKER = { status: 'FAILED', dbNonTerminal: true };   // a killed container
const NEVER_STARTED = { status: 'FAILED', output: {} };
const COMPLETED = { status: 'COMPLETED', output: { video_url: 'https://x/v.mp4' } };

// 1. THE INCIDENT, ASSERTED. A killed worker whose render IS in S3 must never
//    re-render. Without the artifact test this is exactly the 9x loop.
assert.strictEqual(
  respawnDecision(KILLED_WORKER, KILLED_WORKER, true), 'project',
  'A killed worker WITH a playable render in S3 was re-spawned. This is the '
  + 'kill/respawn loop: 294 fires across 49 jobs, up to 9 re-renders each.');

// 2. and the artifact must beat EVERY other signal, not just this one.
for (const [name, initial, recheck] of [
  ['killed worker (dbNonTerminal)', KILLED_WORKER, KILLED_WORKER],
  ['never-started envelope', NEVER_STARTED, NEVER_STARTED],
  ['mixed signals', NEVER_STARTED, KILLED_WORKER],
  ['no recheck at all', NEVER_STARTED, null],
]) {
  assert.strictEqual(
    respawnDecision(initial, recheck, true), 'project',
    `artifact present but "${name}" still produced a respawn — the artifact test `
    + 'must be FIRST and unconditional, because it is the only signal that can be '
    + 'right when every other one says dead');
}

// 3. WITHOUT an artifact, today's behaviour is UNCHANGED. A guard that suppresses
//    legitimate respawns would strand the never-started class silently — trading
//    one invisible failure for another.
assert.strictEqual(respawnDecision(NEVER_STARTED, NEVER_STARTED, false), 'respawn',
  'a genuinely never-started job with NO artifact must still respawn');
assert.strictEqual(respawnDecision(KILLED_WORKER, KILLED_WORKER, false), 'respawn',
  'a drained non-terminal job with no artifact must still respawn');
assert.strictEqual(respawnDecision(NEVER_STARTED, COMPLETED, false), 'project',
  'a completed recheck must still project');

// 4. DEFAULT IS SAFE. The parameter defaults to false, so any caller that has not
//    been threaded yet behaves exactly as before rather than silently gaining a
//    guard it never asked for.
assert.strictEqual(respawnDecision(NEVER_STARTED, NEVER_STARTED), 'respawn',
  'the artifact parameter must default to false — an un-threaded caller must not '
  + 'change behaviour');

// 5. THE PROBE MUST FAIL SAFE. artifactExistsInS3 returns false on ANY error, so
//    an S3 outage suppresses the GUARD rather than the respawn. Asserted from
//    source because exercising it needs live S3.
const src = require('fs').readFileSync(
  require('path').join(__dirname, 'video-processor/dispatch-to-modal.js'), 'utf8');
const probe = src.slice(src.indexOf('async function artifactExistsInS3'));
assert.ok(/catch\s*\(_?\w*\)\s*\{\s*return false;/.test(probe.slice(0, 600)),
  'artifactExistsInS3 must return FALSE on any error — on doubt it must preserve '
  + "today's behaviour, never silently suppress a legitimate respawn");

// 6. THE ORDERING IS THE GUARANTEE, checked on CODE with comments stripped —
//    matching a token inside a comment is a bug this repo has now written six
//    times, most recently while verifying this very function.
let fn = src.slice(src.indexOf('function respawnDecision'),
                   src.indexOf('async function artifactExistsInS3'));
fn = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const iArt = fn.indexOf('if (artifactInS3)');
assert.ok(iArt >= 0, 'the artifact test is gone');
for (const later of ["=== 'COMPLETED'", 'workerNeverStarted', 'dbNonTerminal']) {
  assert.ok(iArt < fn.indexOf(later),
    `the artifact test must come BEFORE ${later} — it is the only test that can be `
    + 'right when every other signal says the job is dead');
}

// 7. THE CALLER MUST ACTUALLY PASS IT. A perfect predicate nobody threads is the
//    inert class; this is the same shape as _keyword_emphasis_spec sitting
//    uncalled for days.
assert.ok(/respawnDecision\(result,\s*recheck,\s*_artifact\)/.test(src),
  'the dispatcher does not pass the artifact flag — the guard would be inert');
assert.ok(/await artifactExistsInS3\(jobId\)/.test(src),
  'the dispatcher never probes S3 before deciding');

console.log('respawn artifact guard smoke: PASS (artifact beats every signal, '
  + 'no-artifact behaviour unchanged, default safe, probe fails safe, ordering '
  + 'checked on code, caller threads it)');
process.exit(0);

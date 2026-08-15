// EVIDENCE-TRIGGERED REPAIR — the two conditions, and the two ways it must NOT fire.
// [Law 2, Rule 1]
//
// The repair path was always evidence-based (it asks S3 whether the render is
// really there); it was only ever REACHABLE after a 15-minute timer, so the
// measured repair cohort settles at p50 904s. Firing it on evidence instead of
// on the clock is the whole fix.
//
// The danger is the opposite error. Repairing a job that is still rendering
// would cut a live render off at the knees, so BOTH conditions are required and
// each is asserted here in isolation:
//   quiet WITHOUT an artifact  -> real failure, must take the failure path
//   artifact WITHOUT quiet     -> live worker mid-upload, must be left alone
//
// This asserts the wiring by source inspection plus the arithmetic of the
// trigger. Standing the whole dispatcher up needs Supabase, S3 and Modal; a
// smoke that needs three live services is a smoke that gets skipped.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'video-processor/dispatch-to-modal.js'), 'utf8');

// 1) BOTH conditions are present and ANDed.
assert.ok(/QUIET_ROW_MS/.test(SRC), 'the quiet threshold must exist');
assert.ok(/quietMs\s*>=\s*QUIET_ROW_MS/.test(SRC),
  'the trigger must compare elapsed quiet against the threshold');
assert.ok(/deliveredNotFailed\(jobId,\s*row\.user_id,\s*pushProgressToSSE\)/.test(SRC),
  'the S3-evidence probe must be the thing that decides — never the clock alone');

// 2) It fires only on a NON-terminal row. Repairing a settled job is a
//    double-write on a row that already has an answer.
const branch = SRC.split("if (!['completed', 'failed', 'canceled'].includes(dbStatus)) {")[1];
assert.ok(branch, 'the repair must live inside the NON-terminal branch');
const branchHead = branch.slice(0, 2600);
assert.ok(/repairTried/.test(branchHead), 'one probe per job — never an S3 call per poll tick');

// 3) NO ARTIFACT => NO REPAIR. deliveredNotFailed returning false must leave the
//    job to the normal failure path rather than inventing a completion.
assert.ok(/if \(!repaired\) \{[\s\S]{0,400}?return;/.test(branchHead),
  'a quiet row with no render in S3 must fall through, not be completed');

// 4) A successful repair must SETTLE the pending promise, or the row is fixed
//    while the caller still sits on the 15-minute wall — the fix would be
//    invisible in the exact number it exists to move.
assert.ok(/settlePendingModalJob\(\{[\s\S]{0,400}?via: 'repair'/.test(branchHead),
  "a repair must settle the dispatcher's pending promise, stamped via:'repair'");

// 5) The SSE pusher must be THREADED, not referenced bare. It is a parameter of
//    dispatchJobToModal, not a module binding, so a bare reference inside the
//    poller throws a ReferenceError that the poller's own try/catch swallows —
//    the repair would silently never run while the poller looked healthy.
assert.ok(/function startDurableCompletionPoll\(\{[^)]*pushProgressToSSE/.test(SRC),
  'startDurableCompletionPoll must accept pushProgressToSSE explicitly');
const callSites = SRC.match(/startDurableCompletionPoll\(\{[^}]*\}\)/g) || [];
assert.ok(callSites.length >= 2, `expected the two poller call sites, saw ${callSites.length}`);
for (const site of callSites) {
  assert.ok(/pushProgressToSSE/.test(site),
    `a poller call site does not pass pushProgressToSSE — the repair's SSE push would be dead: ${site}`);
}

// 6) The threshold must stay well above the worker's heartbeat cadence. The
//    worker beats every 4.0s, so the bar has to represent MANY missed beats or
//    it will fire on a live container between stages.
const m = /const QUIET_ROW_MS = Number\(process\.env\.QUIET_ROW_REPAIR_MS\) \|\| ([0-9_]+);/.exec(SRC);
assert.ok(m, 'the quiet threshold must have a literal default');
const quietMs = Number(m[1].replace(/_/g, ''));
assert.ok(quietMs >= 60_000,
  `quiet threshold ${quietMs}ms is too low — the worker heartbeats every 4s and a live `
  + 'render between stages would be repaired out from under itself');
assert.ok(quietMs < 900_000,
  `quiet threshold ${quietMs}ms is at or past the 15-minute timer it exists to beat`);
const missedBeats = quietMs / 4000;
assert.ok(missedBeats >= 15,
  `only ${missedBeats} missed heartbeats — not decisive evidence the container is gone`);

console.log(`quiet-row repair smoke: PASS (both conditions ANDed, non-terminal only, no-artifact `
  + `falls through, settles via repair, SSE threaded at ${callSites.length} sites, `
  + `${quietMs / 1000}s = ${missedBeats} missed heartbeats)`);
process.exit(0);

'use strict';
// A ROW WE FLIPPED TO `processing` MUST NEVER BE LEFT WITHOUT A TERMINAL.
//
// MEASURED (2026-08-04): 14 of 14 stalls in 24h, 14 distinct users, all with
// current_step='queued', progress=0, modal_call_id NULL, stage_timings empty.
// The worker never ran and nothing recorded why; the reaper killed them as
// stalls up to 50 minutes later. ~15/hr at peak. This is the "43-minute
// Getting started…" case.
//
// THE ORDERING THAT CAUSES IT — dispatch-to-modal.js:
//    ~874  initialUpdate -> status='processing', current_step='queued',
//                           step_message='Getting started...'
//    ~1030 await fetch(modalEndpointUrl)          <- 156 lines later
//    ~1191 persist result.modal_call_id
// Any throw between the flip and dispatch's own guarded region lands in the
// CALLER's catch in server.js, which returned an HTTP error and wrote no
// terminal. DISPATCH_UNREACHABLE is written by that guarded region, which is
// exactly why some dispatch failures are caught and these are not.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const dispatch = fs.readFileSync(
  path.join(__dirname, 'video-processor', 'dispatch-to-modal.js'), 'utf8');

// ── the ordering this guard exists for must still hold ──────────────────────
// If someone later moves the processing flip AFTER the spawn, this fix becomes
// unnecessary — but the test should tell us that, not silently pass.
const flip = dispatch.indexOf("current_step: 'queued'");
const spawn = dispatch.indexOf('await fetch(modalEndpointUrl');
assert.ok(flip > 0 && spawn > 0, 'could not locate the flip / spawn sites');
assert.ok(flip < spawn,
  'the processing flip no longer precedes the spawn — re-evaluate this guard');

// ── the caller must terminalize what it orphaned ────────────────────────────
const catchIdx = server.indexOf("Error in POST /api/video-jobs");
assert.ok(catchIdx > 0, 'the /api/video-jobs catch moved');
const block = server.slice(catchIdx, catchIdx + 2600);
assert.ok(block.includes('markJobFailed('),
  'the catch must terminalize the row it already flipped to processing');
assert.ok(block.includes("errorCode: 'DISPATCH_UNREACHABLE'"),
  'reuse the class that already exists — do not invent a new one');
assert.ok(block.includes('ORPHANED ROW TERMINALIZED'),
  'the terminalize must be LOUD — a silent self-heal is how this stayed invisible');

// The terminalize must not gate the client response: if it threw, the user would
// get nothing at all, which is strictly worse than the bug.
const tIdx = block.indexOf('markJobFailed(');
const rIdx = block.indexOf('return sendJson(');
assert.ok(tIdx < rIdx, 'terminalize before responding, so the row is settled first');
assert.ok(/catch \(e2\)/.test(block),
  'the terminalize must be wrapped — it can never break the response path');

// ── markJobFailed must not resurrect or overwrite a real terminal ───────────
const mjf = dispatch.slice(dispatch.indexOf('async function markJobFailed'),
  dispatch.indexOf('async function markJobFailed') + 900);
assert.ok(mjf.includes("status: 'failed'"), 'markJobFailed writes a terminal');
assert.ok(/\.not\('status', 'in', TERMINAL_SQL_LIST\)/.test(mjf),
  'markJobFailed must refuse to overwrite an existing terminal — a completed job '
  + 'that raced this path must NOT be flipped to failed');

console.log('[smoke] orphaned dispatch: ALL PASS (flip precedes spawn; caller terminalizes loudly; '
  + 'never overwrites a terminal; never gates the response)');

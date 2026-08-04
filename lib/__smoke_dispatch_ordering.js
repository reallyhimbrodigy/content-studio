'use strict';
// A ROW IS ONLY `processing` ONCE MODAL HAS THE CALL.
//
// THE BUG: the processing flip ran BEFORE the source-presence gate, which waits
// up to 600s for the upload to land. A row was flipped to
// processing/'Getting started...' and then sat for up to TEN MINUTES with no
// modal_call_id while we waited on bytes. If the process died in that window —
// a Render deploy, and there were 29 pushes to main in 14h — the row was
// orphaned by construction: no throw, no terminal, nothing to retry.
//
// THE EVIDENCE THAT RULED OUT A THROW: zero POST /api/video-jobs 5xx in the API
// ledger over 12h, on a route that demonstrably records 402/401/409/429. If the
// caller's catch had fired it would have returned a 500 and the ledger would
// show it. Nothing threw — the request simply ended.
//
// 48 orphan-shape rows measured; lifetimes 333-566s, squarely inside the 600s
// source wait. 14 of 48 within 5 minutes of a push to main. THE OTHER 34 HAVE NO
// DEPLOY CORRELATION — two causes, not one, and the residual is unexplained.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, 'video-processor', 'dispatch-to-modal.js'), 'utf8');

// ── the flip must be DEFERRED, not eager ────────────────────────────────────
assert.ok(src.includes('const enterProcessing = async () =>'),
  'the processing flip must be a deferred function, not an eager write');
assert.ok(src.includes('await enterProcessing()'),
  'the deferred flip must actually be invoked');
// ...and not short-circuited. Position alone is not enough: a disabled call
// keeps every ordering assertion green while the row is never flipped at all.
assert.ok(/if \(!\(await enterProcessing\(\)\)\) \{/.test(src),
  'the enterProcessing call must be live, not guarded behind a disabled condition');
assert.ok(!/&&\s*!\(await enterProcessing/.test(src),
  'the enterProcessing call has been short-circuited');

const gate = src.indexOf('SOURCE PRESENCE GATE');
const call = src.indexOf('await enterProcessing()');
const accept = src.indexOf('noteDispatchSuccess()');
assert.ok(gate > 0 && call > 0 && accept > 0, 'could not locate the ordering anchors');

// THE LOAD-BEARING ASSERTION: the flip happens AFTER the source gate. If it ever
// moves back before it, a slow upload again shows as "processing" for 600s and
// every process death in that window orphans a row.
assert.ok(call > gate,
  'the processing flip must come AFTER the source-presence gate — flipping before it '
  + 'is what left rows in processing for up to 600s with no call_id');

// ...and after Modal has actually accepted the call.
assert.ok(call > accept,
  'the flip must follow noteDispatchSuccess() — `processing` means Modal has the call');

// ── a terminalized row must still stop the dispatch ─────────────────────────
// The old code returned 'already-terminal' when the guarded update matched no
// row. That behaviour must survive the move, or a reaped/cancelled job could be
// resurrected and rendered.
const fn = src.slice(src.indexOf('const enterProcessing = async () =>'),
  src.indexOf('const enterProcessing = async () =>') + 1400);
assert.ok(fn.includes(".in('status', ['queued', 'processing'])"),
  'the guarded .in must survive — it is what stops a resurrected terminal job');
assert.ok(/return false;/.test(fn), 'a no-match must report failure to the caller');
assert.ok(src.includes("skipped: 'already-terminal'"),
  'the caller must still bail out when the row was terminalized');

// ── idempotence: two calls must not double-write ────────────────────────────
assert.ok(fn.includes('if (_enteredProcessing) return true;'),
  'enterProcessing must be idempotent — it can be reached more than once on retry paths');

// ── the failure paths between the gate and the flip must not need `processing` ─
// They guard on NOT-terminal, which is true of a `queued` row too. If one ever
// required 'processing' specifically, moving the flip would silently break it.
const between = src.slice(gate, accept);
assert.ok(!/\.eq\('status',\s*'processing'\)/.test(between),
  'a write between the source gate and the flip requires status=processing — '
  + 'it would break now that the row stays queued until Modal accepts');

console.log('[smoke] dispatch ordering: ALL PASS (flip deferred past the 600s source wait '
  + 'to Modal acceptance; terminal guard and idempotence intact)');

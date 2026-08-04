'use strict';

// Regression fence for the GET /api/video-jobs/:id/stream runaway-reconnect guard.
//
// Two defects this prevents:
//  1. A client reopening the SSE stream several times/sec, each open paying
//     auth.getUser + 2 Supabase queries — invisible to the non-2xx ledger because
//     it returns 200. The fix rate-limits opens per jobId BEFORE auth. If that
//     guard is removed or moved after auth, THIS smoke fails and the deploy gate
//     blocks the release.
//  2. A terminal-job snapshot omitting final:true, so a client reconnecting onto
//     an already-finished job never learns to stop. isTerminalJobStatus drives it.
//
// Run:  node lib/__smoke_sse_stream_guard.js   (exit 0 = pass, 1 = fail)

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isTerminalJobStatus } = require('./job-status');

// ── 1. Terminal classification (drives the snapshot final:true) ─────────────────
for (const s of ['completed', 'failed', 'canceled', 'needs_input', 'COMPLETED', 'complete', 'cancelled', 'error', 'needs_clarification']) {
  assert.strictEqual(isTerminalJobStatus(s), true, `"${s}" must be terminal`);
}
for (const s of ['processing', 'queued', 'rendering', 'uploading', '', null, undefined]) {
  assert.strictEqual(isTerminalJobStatus(s), false, `"${s}" must NOT be terminal`);
}

// ── 2. Source assertion: the /stream handler rate-limits BEFORE it authenticates ─
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Locate the SSE stream handler block.
const startIdx = server.indexOf("sseStreamMatch && req.method === 'GET'");
assert.ok(startIdx !== -1, 'GET /api/video-jobs/:id/stream handler must exist');
// Bound the search to a window well inside the handler (before the async body's
// deeper logic) so we assert on THIS route, not a later one.
const block = server.slice(startIdx, startIdx + 2500);

const rateIdx = block.indexOf("checkRateLimit(res, 'sse-stream'");
assert.ok(rateIdx !== -1, 'the /stream handler MUST rate-limit reopens (checkRateLimit sse-stream) — the runaway-reconnect guard was removed');

const authIdx = block.indexOf('requireSupabaseUser');
assert.ok(authIdx !== -1, 'sanity: the handler still authenticates');
assert.ok(rateIdx < authIdx, 'the rate-limit MUST run BEFORE requireSupabaseUser — otherwise every storm open still pays an auth round-trip');

// The snapshot must stamp final from the terminal helper, not a hardcoded literal.
assert.ok(server.includes('final: isTerminalJobStatus(data.status)'),
  'the connect-snapshot MUST set final:true for terminal jobs (final: isTerminalJobStatus(data.status))');

console.log('✅ sse-stream guard smoke: reopens rate-limited pre-auth, terminal snapshot marks final, classification correct.');

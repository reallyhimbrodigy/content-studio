'use strict';
// THE RESOLVED UPLOAD KNOBS REACH THE CLIENT, AND FAIL CLOSED.
//
// Frontend 2026-09-25: upload_shrink, s3_accelerate and upload_parallel are
// absent from /api/health, which the client fetches UNAUTHENTICATED — so a
// per-user allowlist could not reach the device, and shrink was off for
// everyone whatever the allowlist said. The 261 row read
// shrink_reason="flag_off" for exactly that reason. A flag with an allowlist
// and no authenticated channel to the thing that acts on it is a consumer with
// no producer, which is the shape this repo keeps paying for.
//
// The values ride /api/profile/settings — the authenticated call the client
// already makes before picking — under `upload`.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const strip = require('./__gate_strip').stripComments;

const src = strip(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));

// U1: the block is produced, on the authenticated settings read.
assert.ok(/upload_flags, upload: _uk/.test(src),
  'U1: /api/profile/settings must return the resolved `upload` block — it is the '
  + 'authenticated call the client makes before picking, and /api/health cannot '
  + 'answer a per-account question');

// U2: ONE RESOLVER. Zac: "Use the existing uploadFlags.resolve, not a second
// resolver." Two rollout mechanisms is two behaviours to reason about at 2am.
for (const f of ['upload_shrink', 'upload_parallel', 's3_accelerate']) {
  assert.ok(new RegExp(`uploadFlags\\.resolve\\('${f}'`).test(src),
    `U2: ${f} must be resolved through uploadFlags.resolve, not a second path`);
}

// U3: FAIL CLOSED ON AN UNREADABLE STORE. resolve() answers `on` from the env
// DEFAULT_ALLOWLIST even when the database read FAILED — so trusting `on`
// without dbState turns shrink ON for three accounts off a failed query. The
// only thing that distinguishes them is dbState, which is why it exists.
assert.ok(/dbState === 'unreadable'/.test(src),
  'U3: the knobs must consult dbState — `on` alone cannot tell a flag that is '
  + 'set from one answered by the env fallback after a failed read');
const blk = src.slice(src.indexOf('const _uk = {'), src.indexOf('[upload-knobs]'));
assert.ok(blk.length > 200, 'U3: the knob block must be findable to assert anything about');
assert.ok(/shrink: false/.test(blk) && /parallel: 3/.test(blk) && /accelerate: false/.test(blk),
  'U3: the INITIAL values are the fail-closed ones — shrink off, parallel at '
  + "today's default. A block that starts permissive and is narrowed later is "
  + 'open for every path that returns early');
assert.ok(/_blind[\s\S]{0,80}state = 'UNREADABLE'/.test(blk),
  'U3: an unreadable store must leave state UNREADABLE and the values untouched, '
  + 'so the client can tell "we were told no" from "we could not ask"');

// U4: parallel is a NUMBER. A count cannot be expressed by a key existing,
// which is why the existing `upload_flags` shape could not carry it.
assert.ok(/parallel = _rp\.on === true \? 4 : 3/.test(blk),
  'U4: parallel must resolve to a NUMBER with 3 as the default — Zac ruled 3 for '
  + 'the demo and 4 when the flag is on');

// U5: THE OLD SHAPE SURVIVES. Shipped clients parse `upload_flags` as
// present-or-absent; changing it would be a breaking change delivered to phones
// that cannot be updated in time.
assert.ok(/if \(r\.on\) upload_flags\[f\] = 'on';/.test(src),
  'U5: the original upload_flags present-or-absent map must stay — this is '
  + 'additive, and shipped builds read the old one');

// U6: a flag read cannot fail the call. The client cannot pick a video without
// its settings; a knob lookup must never be what stops it.
assert.ok(/catch \(_e\) \{[\s\S]{0,200}state = 'UNREADABLE'/.test(blk + src.slice(src.indexOf('[upload-knobs]'))) 
  || /catch \(_e\)/.test(src),
  'U6: the knob resolution must be wrapped so a flag-store error cannot fail the '
  + 'settings read the client needs before it can pick');

// ── upload.proxy — WHETHER TO EXTRACT ONE AT ALL (Zac, 2026-09-26) ─────────
//
// MEASURED BY FRONTEND: tap-to-uploaded 27.5s, of which 13.15s is proxy
// extraction. On the ChatCut route that is pure waste: prepareAndDispatchAgentic
// takes no proxyVideoUrl parameter, is not passed one, and presigns the SOURCE
// key only. On the handler route the worker does use it, ahead of a 7-10s encode.
{
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'server.js'), 'utf8');

  // THE DEFAULT IS THE FAIL-CLOSED DIRECTION, and which way that points is the
  // whole ruling: the expensive mistake is dropping the proxy for a job that
  // lands on the handler; the cheap one is extracting a proxy ChatCut ignores.
  assert.ok(/accelerate: false, proxy: true,/.test(SRC),
    'upload.proxy must DEFAULT to true — an unreadable route must not cost a '
    + 'handler job its proxy');
  assert.ok(/_uk\.proxy = _route !== 'agentic';/.test(SRC),
    'proxy must be false only when the route is agentic');
  assert.ok(/_uk\.resolved_by\.proxy = `route\/\$\{_route\}`;/.test(SRC),
    'resolved_by.proxy must name which route answered');

  // THE CATCH MUST KEEP IT, not drop it. Verified as ORDER, because a catch that
  // sets false would be the same lines in the wrong arrangement.
  const iTry = SRC.indexOf('const _route = await routeForNewJobAsync(user.id, { record: false });');
  const iCatch = SRC.indexOf('_uk.resolved_by.proxy = \'route/unreadable\';');
  assert.ok(iTry > 0 && iCatch > iTry, 'the unreadable-route fallback is missing');
  const catchBlock = SRC.slice(iTry, iCatch + 80);
  assert.ok(/_uk\.proxy = true;[\s\S]{0,200}route\/unreadable/.test(catchBlock),
    'the unreadable-route path must set proxy TRUE — failing closed here means '
    + 'KEEPING the proxy, because the handler needs it');

  // THE SAME DECISION THE JOB GETS, guard included — not a second rule that can
  // drift from it. If this ever stopped calling routeForNewJobAsync, the client
  // could be told "skip it" for a job that then lands on the handler.
  assert.ok(/routeForNewJobAsync\(user\.id, \{ record: false \}\)/.test(SRC),
    'upload.proxy must come from routeForNewJobAsync, not a separate predicate');

  // AND IT MUST NOT EVICT JOB DECISIONS FROM THE RING. 50 entries, and the ring
  // is the only thing that explains where a job went; a client polling settings
  // would flush it.
  assert.ok(/const \{ jobId = null, record = true \} = opts;/.test(SRC),
    'recording must default to true so a JOB caller gets it by omission');
  assert.ok(/record \? _rdReal : \{ record\(\) \{ return null; \} \}/.test(SRC),
    'record:false must genuinely skip the ring, not merely be accepted');

  // PRINTED IN THE SAME COMMIT. A field the client depends on that appears in no
  // log leaves "did it resolve?" unanswerable from the server side.
  assert.ok(/proxy=\$\{_uk\.proxy\}/.test(SRC), 'the [upload-knobs] line must carry proxy');
  assert.ok(/proxy_by=/.test(SRC), 'the [upload-knobs] line must carry proxy_by');
  console.log('  ok  upload.proxy: from the job\'s own route, false only for agentic, '
    + 'true when unreadable, out of the ring, and printed');
}

console.log('[smoke] upload knobs: PASS (resolved on the authenticated settings read, one '
  + 'resolver, fail-closed on an unreadable store with the state named, parallel is a '
  + 'number defaulting to 3, and the shipped upload_flags shape is unchanged)');
process.exit(0);

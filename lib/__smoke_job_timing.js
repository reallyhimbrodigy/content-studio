'use strict';
// ── SERVER TIME FROM JOB POST TO DISPATCH, MEASURED ─────────────────────────
//
// Zac's target: under 1 second of OUR time before ChatCut starts. Nothing
// measured it. The POST handler logged a wall-clock timestamp at entry and the
// dispatch logged none, so the only way to get the number was to subtract two log
// lines by eye — an estimate with a stopwatch made of text, on the one number a
// latency target is stated against.
//
// THE LOAD-BEARING PROPERTY IS WHERE THE CLOCK STARTS. A t0 stamped after the
// auth check, or after the credit debit, or after the route decision, reports a
// number that excludes exactly the work most likely to be slow — and it would
// look GREEN while the customer waited. So the clock must be stamped before the
// handler's first await, and this file asserts that rather than trusting it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stripComments } = require('./__gate_strip');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
// Through the SHARED stripper: a `://*` in the CSP header once opened a phantom
// comment for an ad-hoc regex and deleted 552 lines of live code from fifteen
// gates, and a gate refuses ad-hoc strippers for exactly that reason.
const CODE = stripComments(SRC);

let legs = 0;
const leg = (name, fn) => { fn(); legs += 1; console.log(`  ok  ${name}`); };

// The POST /api/video-jobs handler, bounded by its own route test.
const START = CODE.indexOf("if (parsed.pathname === '/api/video-jobs' && req.method === 'POST')");
assert.ok(START > 0, 'the POST /api/video-jobs handler is gone');
const NEXT = CODE.indexOf("if (parsed.pathname === '/api/video-jobs/", START + 50);
const HANDLER = CODE.slice(START, NEXT > START ? NEXT : START + 120000);

leg('the clock starts BEFORE the handler does any awaited work', () => {
  const iT0 = HANDLER.indexOf('const _postT0 = Date.now();');
  assert.ok(iT0 > 0, 'the POST handler no longer stamps _postT0 — there is nothing '
    + 'to measure post-to-dispatch against');
  const iFirstAwait = HANDLER.indexOf('await ');
  assert.ok(iFirstAwait > 0, 'could not find an await in the POST handler — the '
    + 'extraction is wrong, not the code');
  assert.ok(iT0 < iFirstAwait,
    'the clock is stamped AFTER the handler\'s first await, so the measurement '
    + 'excludes work the customer is waiting on — auth, the wall, the credit '
    + 'debit, the route decision including the account_status read. A clock that '
    + 'starts after the slow part reports green while the user waits.');
});

leg('BOTH routes report the number, so the routed one has a control', () => {
  // "Cut cost and latency BY ROUTE" is a standing rule here: a routed job's
  // 900ms means nothing without what the same server does on the path that has
  // always worked. One number with no comparison is how a regression hides.
  for (const route of ['chatcut', 'handler']) {
    const needle = `route=${route} post_to_dispatch_ms=%d`;
    assert.ok(HANDLER.includes(needle),
      `the ${route} branch does not report post_to_dispatch_ms — a timing that `
      + 'reaches a variable and no output answers nothing');
  }
  const n = (HANDLER.match(/\[job-timing\]/g) || []).length;
  assert.strictEqual(n, 2,
    `expected exactly 2 [job-timing] lines (one per route), found ${n} — a third `
    + 'would double-count a job and a missing one leaves a route unmeasured');
});

leg('the two lines are mutually exclusive, so a job is timed once', () => {
  // CONTAINMENT, NOT POSITION. The first version of this leg asserted
  //   iHand > iGuard
  // — the handler line's index must be after the guard's OPENING. Moving the line
  // BELOW the guard's closing brace keeps that true, so the mutation that makes a
  // routed job print BOTH lines passed the check written to catch it. RED-proved
  // NOT RED, which is the only reason I know.
  //
  // Position is not containment, and this is the third time that distinction has
  // mattered in one session — the same shape as the byte-window containment
  // proxies in __smoke_free_credit_roll. Bounded by indentation, like those: the
  // block ends at the first following line that is exactly the opening line's
  // indent plus `}`.
  const lines = HANDLER.split('\n');
  const gi = lines.findIndex((l) => /^\s*if \(!_agenticDispatched\) \{\s*$/.test(l));
  assert.ok(gi >= 0, 'the handler dispatch is no longer guarded on '
    + '!_agenticDispatched — a routed job would be dispatched TWICE');
  const indent = (lines[gi].match(/^(\s*)/) || [, ''])[1];
  const ci = lines.findIndex((l, i) => i > gi && l === `${indent}}`);
  assert.ok(ci > gi, 'could not bound the !_agenticDispatched block');

  const hi = lines.findIndex((l) => l.includes('route=handler post_to_dispatch_ms'));
  const chi = lines.findIndex((l) => l.includes('route=chatcut post_to_dispatch_ms'));
  assert.ok(hi > gi && hi < ci,
    'the handler timing is NOT inside if (!_agenticDispatched) — a routed job '
    + 'prints both lines, and the one that describes it is the wrong one');
  assert.ok(chi >= 0 && chi < gi,
    'the chatcut timing must sit in the agentic branch, above the fallback guard');
});

leg('the metric name is one greppable string', () => {
  // A number nobody can find is a number nobody reads. One name, both routes,
  // so `[job-timing]` is the whole search.
  assert.ok(/\[job-timing\] job=%s route=\w+ post_to_dispatch_ms=%d/.test(HANDLER),
    'the timing lines no longer share one format — a reader would need two '
    + 'patterns to find one metric');
});

console.log(`[smoke] job timing: ${legs}/4 legs green (clock precedes the first `
  + 'await, both routes report, mutually exclusive, one metric name)');
assert.strictEqual(legs, 4, `expected 4 legs, ran ${legs}`);

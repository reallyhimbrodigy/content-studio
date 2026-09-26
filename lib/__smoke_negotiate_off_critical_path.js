'use strict';
// ── THE DARK CLASSIFIER MUST NOT BE IN THE JOB-CREATE PATH ──────────────────
//
// MEASURED 2026-09-26: post_to_dispatch_ms had an `insert` phase of 1591-3492ms
// across seven clean jobs. Zac's pg_stat_statements put the video_jobs INSERT at
// mean 47ms, max 565ms over 269 calls — so ~95% of that phase was never Postgres.
// It was `await negotiation.classifyWithSafety(...)`: one Haiku round trip, on
// every job, between a customer pressing go and their render starting.
//
// THE DESIGN HAD ALREADY FORBIDDEN IT. Three comments say dispatch must not depend
// on the model — "DISPATCH NEVER DEPENDS ON THE MODEL BEING UP", "A classifier
// outage must not become a product outage", "dispatch anyway". Every one of them is
// about the model's VERDICT, and awaiting it created a dependency on its LATENCY
// that nobody declared. A correct rule, stated three times, and the code underneath
// it doing the thing the rule was written to prevent.
//
// SO THE AWAIT FOLLOWS THE FLAG, and this file pins both halves:
//   ARMED -> awaited, because the live refusal path returns before any job row
//            exists and cannot act on a promise.
//   DARK  -> started, never awaited. Every consumer is a shadow row, an owner
//            alert or a log line.
//
// THE HALF THAT MATTERS MOST IS THE ARMED ONE. Making the dark path fast is a
// latency win; letting the ARMED path stop blocking would let an UNSAFE brief
// render, which is the one outcome Zac has ruled on absolutely: "UNSAFE /
// INAPPROPRIATE — clean refusal, no render, no charge." So the armed leg is not
// symmetry, it is the safety floor.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stripComments } = require('./__gate_strip');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
// COMMENTS STRIPPED FIRST. This file's subject is a block whose comments quote the
// very expressions being asserted — `await negotiation.classifyWithSafety(...)`
// appears in the prose above the code that no longer does it. Four times this
// session a check was satisfied by a comment; here the comment is a near-verbatim
// copy of the defect.
const CODE = stripComments(SRC);

let legs = 0;
const leg = (name, fn) => { fn(); legs += 1; console.log(`  ok  ${name}`); };

/** The balanced { ... } block that starts at or after `from`.
 *
 * `skipParams` jumps past a parameter list first. Without it, a function whose
 * signature carries a default object — `classifyWithSafety(text, opts = {})` —
 * hands back that `{}` as "the body", and every assertion about the body then
 * fails with "the early regex refusal is gone" about code that is right there.
 * Which is what happened, and it is the same class as anchoring on
 * `createQueuedVideoJob(` and getting the function's signature instead of its
 * call: the first brace is not the brace you mean. */
function block(src, from, skipParams = false) {
  let start = from;
  if (skipParams) {
    const p = src.indexOf('(', from);
    if (p < 0) return null;
    let pd = 0; let close = -1;
    for (let i = p; i < src.length; i += 1) {
      if (src[i] === '(') pd += 1;
      else if (src[i] === ')') { pd -= 1; if (pd === 0) { close = i; break; } }
    }
    if (close < 0) return null;
    start = close;
  }
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let d = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') d += 1;
    else if (src[i] === '}') { d -= 1; if (d === 0) return src.slice(open, i + 1); }
  }
  return null;
}

leg('the classifier is started exactly once, and not inside an await', () => {
  const calls = [...CODE.matchAll(/classifyWithSafety\s*\(/g)];
  assert.strictEqual(calls.length, 1,
    `classifyWithSafety must be called from one place, found ${calls.length} — two `
    + 'call sites is how one of them keeps the await');
  // The call itself must not be the operand of an await. `await classify...` in the
  // job path is the whole defect, whichever branch it sits in.
  assert.ok(!/await\s+negotiation\.classifyWithSafety\s*\(/.test(CODE),
    'the classifier is awaited AT THE CALL, so both flag states pay the Haiku round '
    + 'trip and the flag no longer governs the latency');
});

leg('ARMED awaits the decision — the safety floor', () => {
  // Locate the armed branch by its condition and read its own block.
  const at = CODE.search(/if\s*\(\s*_negPromise\s*&&\s*_negArmed\s*\)/);
  assert.ok(at > 0,
    'the armed branch is gone. Without it an UNSAFE brief renders: the live refusal '
    + 'path returns before any job row exists and cannot act on a pending promise');
  const armed = block(CODE, at);
  assert.ok(armed, 'could not bound the armed branch');
  assert.ok(/await\s+_negPromise/.test(armed),
    'the ARMED branch does not await the decision — a refusal that arrives after '
    + 'dispatch is not a refusal');
  assert.ok(/negotiationDecision\s*=\s*await\s+_negPromise/.test(armed),
    'the awaited value must reach negotiationDecision, which is what the live '
    + 'refusal path reads');
});

leg('DARK never awaits, and never leaves a rejection unhandled', () => {
  const at = CODE.search(/else\s+if\s*\(\s*_negPromise\s*\)/);
  assert.ok(at > 0, 'the dark branch is gone');
  const dark = block(CODE, at);
  assert.ok(dark, 'could not bound the dark branch');
  assert.ok(!/\bawait\b/.test(dark),
    'the DARK branch awaits something — this is the 1.5-3s coming straight back, '
    + 'and every customer pays it for a decision that cannot change their render');
  assert.ok(/\.then\s*\(\s*_recordNegotiation\s*\)/.test(dark),
    'the dark branch must still RECORD the decision when it lands — the whole '
    + 'purpose of dark is measuring the false-positive cost before anyone sees a line');
  assert.ok(/\.catch\s*\(/.test(dark),
    'an unhandled rejection is fatal on Node 18+ and this is the job-create path');
});

leg('the recording exists in ONE copy, reached by both branches', () => {
  const defs = [...CODE.matchAll(/_recordNegotiation\s*=/g)];
  assert.strictEqual(defs.length, 1,
    `the recorder is defined ${defs.length} times — two copies of the shadow-row `
    + 'builder is how one stops matching the other, which is exactly how '
    + '/account_status authenticated while /run_agentic went anonymous');
  // And it must be the thing both branches use, not a third inline copy.
  assert.ok(!/from\('negotiation_decisions'\)\s*\.insert/.test(
    CODE.slice(CODE.indexOf('_negArmed = negotiation.flagOn()'))),
    'a shadow-row insert appears AFTER the recorder was extracted — that is the '
    + 'second copy');
});

leg('a regex REFUSE still decides without the model', () => {
  // THE SAFETY FLOOR BELOW THE FLAG. classifyWithSafety returns a REFUSE from the
  // pattern before it ever calls adjudicateRequest, so pattern-unsafe briefs are
  // decided at the same speed as before and are not affected by this change at all.
  // Asserted here because that property is what makes the dark path acceptable.
  const cls = fs.readFileSync(path.join(__dirname, 'negotiation-classifier.js'), 'utf8');
  const c = stripComments(cls);
  const at = c.indexOf('async function classifyWithSafety');
  assert.ok(at > 0, 'classifyWithSafety is gone from the classifier');
  const body = block(c, at, true);
  assert.ok(body, 'could not bound classifyWithSafety');
  assert.ok(body.length > 200,
    `the extracted body is ${body.length} chars — that is a parameter default, not `
    + 'a function body, and every assertion below would be about the wrong text');
  const refuseAt = body.indexOf("=== 'REFUSE'");
  const adjAt = body.indexOf('await adjudicateRequest');
  assert.ok(refuseAt > 0, 'the early regex refusal is gone');
  assert.ok(adjAt > refuseAt,
    'the model call now precedes the regex refusal, so an unsafe brief the PATTERN '
    + 'already caught waits on the network to be refused');
  // And the refusal must RETURN, not fall through to the model.
  const between = body.slice(refuseAt, adjAt);
  assert.ok(/return\s*\{/.test(between),
    'the regex REFUSE branch does not return before the model call — "A REGEX '
    + 'REFUSAL ALWAYS HOLDS. It never waits on the model"');
});

leg('the insert phase is attributable: validate, negotiate, pre_db are marked', () => {
  // A one-number phase over a classifier call plus a database write cannot say
  // which to fix, and that ambiguity cost three sessions of arguing about whether
  // the insert was 1.5s or 2.1s. The after-data has to prove the attribution too:
  // negotiate must fall to ~0 while pre_db stays where Postgres says it is.
  for (const n of ['validate', 'negotiate', 'pre_db']) {
    assert.ok(new RegExp(`mark\\('${n}'\\)`).test(CODE),
      `the '${n}' phase mark is gone — the insert becomes one unattributable number`);
  }
  // THE RECORDER IS THREADED, NOT DUPLICATED. A second clock inside the insert
  // would have to be reconciled with the outer one by hand.
  assert.ok(/mark:\s*_mark\b/.test(CODE),
    'createQueuedVideoJob is no longer given the caller\'s recorder, so its phases '
    + 'cannot land on the same [job-timing] line as the phases around it');
  // AND NO NAME COLLIDES ACROSS THE TWO RECORDERS. Same hazard the outer check
  // guards: one name marked twice merges two phases and still looks well-formed.
  const outer = [...CODE.matchAll(/_mark\('([a-z_]+)'\)/g)].map((m) => m[1]);
  const inner = [...CODE.matchAll(/[^_]mark\('([a-z_]+)'\)/g)].map((m) => m[1]);
  const clash = inner.filter((n) => outer.includes(n));
  assert.deepStrictEqual(clash, [],
    `these phase names are used by BOTH recorders: ${clash.join(',')}`);
});

console.log(`[smoke] negotiate off the critical path: ${legs}/6 legs green `
  + '(one call site, never awaited at the call, ARMED awaits, DARK does not and '
  + 'catches, one recorder, regex REFUSE still decides without the model, phases '
  + 'attributable)');
assert.strictEqual(legs, 6, `expected 6 legs, ran ${legs}`);

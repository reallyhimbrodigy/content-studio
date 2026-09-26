'use strict';
// ── THE GUARD READS RUN TOGETHER, AND THE REFUSALS STILL RUN IN ORDER ───────
//
// MEASURED 2026-09-26: pre_insert was 838-1460ms across seven clean jobs — about a
// dozen sequential Supabase round trips from Render/Oregon, eight of them the four
// guards' selects. Serialised they cost the SUM of the latencies while doing
// trivial work; Zac's pg_stat_statements says Postgres is not the constraint.
//
// TWO PROPERTIES, AND THEY ARE IN TENSION:
//   FAST    — all four reads start before any is awaited.
//   FAITHFUL— the DECISIONS are read in the original order (spend 429, refund 429,
//             pending 503/402, dead source 409), so a user who would have seen one
//             refusal still sees exactly that one.
// Reordering the decisions would silently change which error a doubly-capped
// account receives. That is a product decision and it is not this change's to make.
//
// AND THE PRECONDITION THAT MAKES ANY OF IT SAFE: none of the four writes. That is
// why leg 5 reads the guard MODULES rather than the call site — the day somebody
// adds an insert to a "check" function, concurrent starts become a reordered side
// effect, and the failure would be invisible at the call site where this change
// lives. That leg is the one that earns its keep long after today.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stripComments } = require('./__gate_strip');

const ROOT = path.join(__dirname, '..');
// STRIPPED: the block this file is about carries a long comment naming
// checkSpendGuards, inFlightJobCount and Promise.all — the exact strings being
// asserted. Four times this session a check was satisfied by prose.
const CODE = stripComments(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'));

let legs = 0;
const leg = (name, fn) => { fn(); legs += 1; console.log(`  ok  ${name}`); };

const GUARDS = ['checkSpendGuards', 'checkRejectionAttemptCap',
                'inFlightJobCount', 'findDeadSourceJob'];

// THE CONCURRENT SET, BOUNDED BY INDENTATION.
//
// TWO WAYS THIS WENT WRONG BEFORE IT WENT RIGHT, both worth keeping written down.
//
// FIRST, a balanced-bracket walk terminated early on the "]" inside
// '🚨 [Promptly] spend guard' and reported checkSpendGuards missing from a set it
// was plainly in. I then wrote a string-blanking pass to fix the walk — and it
// cannot be applied to a whole file, because a lone apostrophe inside a REGEX
// literal opens a fake string and swallows everything to the next quote. Telling
// regex from division needs a parser. So the blanking helper was deleted rather
// than left sitting in shared code looking safe.
//
// SECOND, and this was the real failure: `indexOf('Promise.allSettled([')` found
// the WRONG CALL. server.js has two, and the first is a delete sweep 1300 lines
// above this one. The check was reading a different array and would have been
// satisfied by whatever that one happened to contain. Same class as anchoring on
// `createQueuedVideoJob(` and getting the signature — the first match is not the
// match you mean, and this repo has now paid for it three times today.
//
// So: anchored on the full destructuring, which is unique, and bounded by the
// closing bracket at its own indentation. If the block is reindented this fails
// loudly instead of mis-bounding quietly.
// THE ANCHOR NAMES THE DESTRUCTURING, NOT THE COMBINATOR. With `allSettled` baked
// into it, swapping the combinator broke THIS leg first and the allSettled leg could
// never fire on its own — a check whose own anchor makes another check unreachable.
// Two properties, two independent assertions.
const OPEN = 'const [_rGuard, _rRej, _rPend, _rDead] = await Promise.';
const CLOSE = '\n          ]);';
function combinator() {
  const at = CODE.indexOf(OPEN);
  assert.ok(at > 0,
    'the concurrent guard read is gone — the four guards are back to one round trip '
    + 'each. Anchor: ' + OPEN);
  const nl = CODE.indexOf('\n', at);
  return CODE.slice(at + OPEN.length, nl);
}
function settledArgs() {
  const at = CODE.indexOf(OPEN);
  assert.ok(at > 0,
    'the concurrent guard read is gone — the four guards are back to one round trip '
    + 'each. Anchor: ' + OPEN);
  const end = CODE.indexOf(CLOSE, at);
  assert.ok(end > at,
    'the allSettled array does not close at its own indentation — it was reindented '
    + 'or restructured, and this leg refuses to guess where it ends');
  // FROM THE CALL'S OWN BRACKET. `indexOf('[', at)` finds the DESTRUCTURING's
  // bracket — `const [_rGuard, ...` — so the "array" then began with
  // `_rGuard, _rRej, _rPend, _rDead] = await Promise.allSettled([`, which contains
  // an `await` and failed the no-await leg on correct code. The array starts at the
  // `([` of the call.
  const callBracket = CODE.indexOf('([', at + OPEN.length - 1);
  assert.ok(callBracket > at, 'the combinator is not called with an array literal');
  return CODE.slice(callBracket + 1, end);
}

leg('all four guard reads are started in ONE concurrent set', () => {
  const args = settledArgs();
  assert.ok(args, 'could not bound the allSettled array');
  for (const g of GUARDS) {
    assert.ok(args.includes(`${g}(`),
      `${g} is not in the concurrent set — it is back to costing its own round trip`);
  }
  // AND NONE OF THEM IS AWAITED INSIDE THE SET. `await` in there serialises the
  // array's construction and the whole change evaporates while still reading as
  // parallel.
  assert.ok(!/\bawait\b/.test(args),
    'an await inside the allSettled array serialises the reads — the array is built '
    + 'left to right, so the second entry is not even created until the first resolves');
});

// THE JOB-CREATE PATH, not the whole file. inFlightJobCount is deliberately shared
// with the upload doors — "Same account-global in-flight definition the upload doors
// use" — so a file-wide "called exactly once" assertion fails on correct code, and
// did. The question is only whether a SECOND serial read survives on THIS path.
function createPath() {
  const a = CODE.indexOf('await withKeyLock(`render:${authUser.id}`');
  assert.ok(a > 0, 'the create path\'s key lock is gone — this leg is aimed at nothing');
  const b = CODE.indexOf('await createQueuedVideoJob({', a);
  assert.ok(b > a, 'the insert no longer follows the lock on the create path');
  return CODE.slice(a, b);
}

leg('no guard is ALSO awaited separately on the create path', () => {
  // A leftover `await checkSpendGuards(...)` beside the concurrent set would double
  // the round trips AND double any alert it fires, while every other leg stayed green.
  const path = createPath();
  for (const g of GUARDS) {
    assert.ok(!new RegExp(`await\\s+${g}\\s*\\(`).test(path),
      `${g} is awaited directly on the create path — that is a second, serial read `
      + 'alongside the concurrent one');
    const calls = [...path.matchAll(new RegExp(`${g}\\s*\\(`, 'g'))];
    assert.strictEqual(calls.length, 1,
      `${g} is called ${calls.length} times on the create path; two call sites is how `
      + 'one of them keeps the serial await');
  }
});

leg('allSettled, not all — the three failure contracts stay distinct', () => {
  // ON THE CREATE PATH. A file-wide test for Promise.allSettled passes on the delete
  // sweep 1300 lines above, so swapping THIS call to Promise.all left the leg green —
  // the third time in this one file that a file-wide match answered about the wrong
  // occurrence. The lesson is not "be careful", it is: scope every offset and every
  // presence test to the region whose property you are asserting.
  assert.ok(/^allSettled\(\[/.test(combinator()),
    'Promise.all collapses three different failure contracts into one rejection: '
    + 'inFlightJobCount is FAIL-CLOSED (a throw must become 503 pending_check_failed) '
    + 'while the two guards are fail-open internally');
  const args = settledArgs();
  assert.ok(!/Promise\.all\(/.test(args), 'a Promise.all sits inside the guard set');
});

leg('the refusal decisions are read in the ORIGINAL order', () => {
  // Position of each decision, by the thing it returns. Not by the guard's name:
  // the names now all appear together inside the allSettled array, so their order
  // there says nothing about the order the ANSWERS are consulted.
  // WITHIN THE CREATE PATH. These strings also occur on the upload doors, so
  // file-wide offsets compare a create-path refusal against an upload-path one and
  // report a reordering that never happened — which is exactly what they did.
  const path = createPath();
  const spend = path.indexOf('[spend-guard] blocked render');
  const refund = path.indexOf('[refund-guard] blocked');
  const pending = path.indexOf("error: 'pending_check_failed'");
  const conc = path.indexOf("error: 'concurrency_limit_reached'");
  const dead = path.indexOf('[source] REJECT at creation');
  for (const [n, v] of [['spend', spend], ['refund', refund], ['pending', pending],
                        ['concurrency', conc], ['dead source', dead]]) {
    assert.ok(v > 0, `the ${n} refusal is gone from the create path`);
  }
  assert.ok(spend < refund,
    'the refund cap is now consulted before the spend guard — a doubly-capped '
    + 'account would get a different error code than it does today');
  assert.ok(refund < pending && pending < conc,
    'the in-flight checks moved above the refund cap');
  assert.ok(conc < dead,
    'the dead-source rejection moved above the concurrency cap — a user at their '
    + 'limit with a dead key would get 409 where they get 402 today');
});

leg('fail-closed is preserved: a pending-count failure is still 503', () => {
  const at = createPath().indexOf("_rPend.status === 'rejected'");
  assert.ok(at > 0,
    'the pending-count rejection is no longer handled — with allSettled it becomes a '
    + 'silent undefined, `(undefined || 0) >= cap` is false, and an unknown in-flight '
    + 'count would let a free account open a second render. That is the guard '
    + 'failing OPEN, which is the one direction it was written to refuse.');
  const after = createPath().slice(at, at + 400);
  assert.ok(/pending_check_failed/.test(after) && /503/.test(after),
    'a pending-count failure no longer returns 503 pending_check_failed');
});

leg('the precondition holds: not one of the four guards writes', () => {
  // THIS IS WHAT MAKES CONCURRENT STARTS SAFE. Reads have no order to preserve; a
  // write does. Checked in the guard MODULES, because a write added there would be
  // invisible at the call site where the parallelism lives.
  const WRITES = /\.(insert|update|upsert|delete|rpc)\s*\(/g;
  for (const f of ['spend-guard.js', 'source-presence.js']) {
    const src = stripComments(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    const hits = [...src.matchAll(WRITES)].map((m) => m[1]);
    assert.deepStrictEqual(hits, [],
      `lib/${f} now performs ${hits.join(', ')} — these functions are started`
      + ' CONCURRENTLY on the job-create path, so a write here is a reordered side'
      + ' effect. Either take it out of the concurrent set or make it a pure read.');
  }
  // inFlightJobCount lives in server.js; bound it by brace depth and check the same.
  const at = CODE.search(/async function inFlightJobCount\s*\(/);
  assert.ok(at > 0, 'inFlightJobCount is gone');
  const open = CODE.indexOf('{', CODE.indexOf(')', at));
  let d = 0; let end = -1;
  for (let i = open; i < CODE.length; i += 1) {
    if (CODE[i] === '{') d += 1;
    else if (CODE[i] === '}') { d -= 1; if (d === 0) { end = i; break; } }
  }
  assert.ok(end > open, 'could not bound inFlightJobCount');
  const body = CODE.slice(open, end + 1);
  const hits = [...body.matchAll(WRITES)].map((m) => m[1]);
  assert.deepStrictEqual(hits, [],
    `inFlightJobCount now performs ${hits.join(', ')} — see above`);
});

leg('the phase is marked, so the saving is measurable and not asserted', () => {
  assert.ok(/_mark\('guards'\)/.test(CODE),
    "the 'guards' phase mark is gone — pre_insert goes back to one number covering "
    + 'a dozen round trips, which is the ambiguity this whole exercise removed');
});

console.log(`[smoke] guard reads parallel: ${legs}/7 legs green (one concurrent set, `
  + 'no second serial read, allSettled not all, refusal order unchanged, pending '
  + 'still fail-closed, no writes among the four, phase marked)');
assert.strictEqual(legs, 7, `expected 7 legs, ran ${legs}`);

'use strict';
// EVERY IDENTIFIER PASSED TO routeForNewJobAsync IS ONE THE SAME INSERT CALL
// ALREADY DEPENDS ON.
//
// THE INCIDENT (2026-09-25, mine, caught before it shipped): wiring the
// per-user route decision I wrote
//     pipeline: await routeForNewJobAsync(authUser.id, { jobId })
// inside the createQueuedVideoJob({...}) argument object, in a block where
// `jobId` is not declared. It IS declared twice elsewhere in server.js — the
// cancel-job branch and the status branch — so every text-level check reads
// fine, and `node --check` passes because the SYNTAX is perfect. At runtime it
// is a ReferenceError thrown while evaluating the arguments to the video_jobs
// INSERT: EVERY JOB CREATION FAILS. The binding that exists in that block is
// `clientJobId`, and the object literal already passes it.
//
// *Scope is not text* — the sixth instance in this repo and the first in
// JavaScript; every earlier one was caught by pyflakes on the Python side.
//
// ── TWO CHECKS I WROTE FIRST, AND WHY THEY ARE NOT HERE ──────────────────
//
// 1. A FULL esprima SCOPE WALK over server.js. It cannot ship: Render builds
//    with `npm install --omit=dev` and no JavaScript parser is a PRODUCTION
//    dependency, so a lib/__smoke_*.js requiring one fails the DEPLOY rather
//    than catching a defect — a red that is not about the property, with the
//    whole build behind it. The parser that does resolve here predates object
//    spread and optional chaining, both of which server.js uses.
//
// 2. A BRACE-DEPTH UPWARD WALK to approximate the scope chain without a
//    parser. **It passed on the real defect.** Braces inside string and regex
//    literals desynchronise the depth count, so the walk decided a `const
//    jobId` inside a closed sibling block was on the chain. I only know that
//    because I red-proved it by restoring the actual bug — it reported PASS,
//    twice, with a confident sentence about what node --check cannot see. A
//    check that cannot fire is not a check, and this one was two minutes from
//    being filed as one.
//
// ── SO THE PROPERTY IS NARROWER AND IT IS TRUE ───────────────────────────
// Every identifier read in the routeForNewJobAsync(...) arguments must ALSO
// appear elsewhere in the same createQueuedVideoJob({...}) object. That object
// is code that runs on every job today, so an identifier it already uses is
// demonstrably in scope at that exact point. It is not scope analysis and does
// not claim to be; it is the one question that can be answered here without a
// parser, and it answers it about the exact shape that bit.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const strip = require('./__gate_strip').stripComments;

const CALLEE = 'routeForNewJobAsync';
const HOST = 'createQueuedVideoJob(';
const src = strip(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));

/** The balanced (...) argument text that starts at `from`. */
function balanced(s, from) {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return s.slice(from + 1, i); }
  }
  return null;
}

// EVERY occurrence, not the first. `createQueuedVideoJob(` appears as the
// DEFINITION before it appears as the call, and taking indexOf would aim this
// leg at a function signature — which is how a check ends up reporting
// "unwired" about correctly wired code.
let hostArgs = null;
let hostCount = 0;
for (let i = src.indexOf(HOST); i >= 0; i = src.indexOf(HOST, i + 1)) {
  hostCount++;
  const args = balanced(src, i + HOST.length - 1);
  if (args && args.indexOf(`${CALLEE}(`) >= 0) { hostArgs = args; break; }
}
assert.ok(hostCount >= 1,
  `S0: ${HOST}...) not found in server.js — the job insert moved or was renamed, and this `
  + 'leg is now aimed at nothing');
assert.ok(hostArgs && hostArgs.length > 100,
  `S0: none of the ${hostCount} ${HOST}...) site(s) carries ${CALLEE}( in balanced argument `
  + 'text — the route decision is not inside the insert');

const callAt = hostArgs.indexOf(`${CALLEE}(`);
assert.ok(callAt >= 0,
  `S1: ${CALLEE}(...) is not inside the ${HOST}...) arguments — the per-user route `
  + 'decision is unwired, so no job carries a decided route');
const callArgs = balanced(hostArgs, callAt + CALLEE.length);
assert.ok(callArgs !== null, `S1: ${CALLEE}(...) arguments are not balanced`);

// The rest of the object: everything EXCEPT this call's own text.
const rest = hostArgs.slice(0, callAt) + hostArgs.slice(callAt + CALLEE.length + callArgs.length + 2);

const AMBIENT = new Set(['await', 'new', 'typeof', 'null', 'true', 'false', 'undefined',
  'process', 'require', 'JSON', 'Number', 'String', 'Boolean', 'Object', 'Array', 'Math']);

// Identifiers READ in the call's arguments: drop object KEYS (`foo:`), drop
// member access (`.id`), drop string literals.
const a = callArgs.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ' ');
const names = new Set();
const re = /(\.)?\b([A-Za-z_$][\w$]*)\b\s*(:)?/g;
let m;
while ((m = re.exec(a))) {
  const [, dot, name, colon] = m;
  if (dot || colon || AMBIENT.has(name)) continue;
  names.add(name);
}
assert.ok(names.size >= 1,
  `S2: ZERO identifiers extracted from ${CALLEE}(${callArgs.trim()}) — the extractor matched `
  + 'nothing, which is a harness failure, not a pass');

const bad = [];
for (const n of names) {
  const used = new RegExp(`(^|[^.\\w$])${n}\\b`).test(rest);
  if (!used) bad.push(n);
}
if (bad.length) {
  console.error(`[smoke] route-callsite-scope: FAIL — ${CALLEE}(${callArgs.trim()}) reads `
    + `${bad.map((n) => `\`${n}\``).join(', ')}, which the surrounding insert object does NOT `
    + 'use anywhere else. An identifier this call invents is one nothing proves is in scope — '
    + 'and a ReferenceError here fails EVERY job creation, with node --check green.');
  process.exit(1);
}
console.log(`[smoke] route-callsite-scope: PASS (${names.size} identifier(s) — `
  + `${[...names].map((n) => `\`${n}\``).join(', ')} — each already used by the insert object `
  + 'that runs on every job)');
process.exit(0);

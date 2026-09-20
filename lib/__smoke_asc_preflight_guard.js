'use strict';
// The submit guard must block a rejection that is ABOUT THE WORK IN FRONT OF YOU,
// and must not block forever on one that is already history.
//
// As first written, `NEEDS_DECISION` was matched against EVERY version at any
// age, so a single DEVELOPER_REJECTED wedged all future submissions: withdrawing
// 1.3.35 deliberately to replace it would have blocked 1.3.36, 1.3.37 and every
// version after, until someone edited App Store state by hand. The guard's
// reason — "a rejection needs a decision about WHY" — is right; submitting a
// strictly NEWER version IS that decision.
//
// The failure this protects against is the opposite one: stepping over a
// rejection that applies to the version being shipped, or to a newer one.
//
// Exit 0 = clean. Exit 1 = the guard blocks forever, or waves through a live one.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'asc-preflight.js'), 'utf8');
const bad = [];

// 1. the rejection check must be AGE-SCOPED, not "any version anywhere"
const m = src.match(/const decision = vers\.find\(\(x\) => NEEDS_DECISION\.has\(x\.s\)([^;]*)\);/);
if (!m) {
  bad.push('the rejection guard is gone entirely');
} else if (!/cmp\(x\.v,\s*version\)\s*>=\s*0/.test(m[1])) {
  bad.push('the rejection guard is no longer scoped by version age — one '
         + 'DEVELOPER_REJECTED would block every future submission forever');
}

// 2. an older rejection must still be NAMED, never silently swallowed.
if (!/olderRejected/.test(src) || !/asc-preflight: NOTE/.test(src)) {
  bad.push('an older rejection is no longer reported — stepping over a rejection '
         + 'silently is the failure this guard exists to prevent');
}

// 3. the other blocks must survive: newer in-flight, same-version in-flight,
//    terminal state, and a failed read.
for (const [needle, why] of [
  [/IN_FLIGHT\.has\(x\.s\) && cmp\(x\.v, version\) > 0/, 'a NEWER in-flight version no longer blocks — an older build would displace queued work'],
  [/x\.v === version && IN_FLIGHT\.has\(x\.s\)/,         'a duplicate submission of the same version no longer blocks'],
  [/TERMINAL\.has\(me\.s\)/,                              'a version already terminal no longer blocks'],
  [/Cannot promise a free slot from a failed read/,       'a FAILED READ no longer blocks — an empty list would read as a free slot'],
]) if (!needle.test(src)) bad.push(why);

if (bad.length) {
  console.log('asc-preflight-guard: FAIL');
  for (const b of bad) console.log('  -', b);
  process.exit(1);
}
console.log('  rejection guard is age-scoped and still names older rejections; newer in-flight, '
  + 'duplicate, terminal and failed-read blocks all intact.');
console.log('asc-preflight-guard: PASS');

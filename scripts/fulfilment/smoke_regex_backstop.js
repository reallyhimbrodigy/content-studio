#!/usr/bin/env node
/**
 * THE EARLY-REFUSE REGEX IS NOT DECORATIVE, AND UNTIL THIS FILE IT WAS ALSO
 * NOT EXERCISED.
 *
 * Measured 2026-09-20 over the whole life of `negotiation_decisions`:
 * decider='regex' is 0 of 107, and `degraded` is 0 of 107. So neither the
 * pattern nor the outage path it guards has ever run in production. The
 * obvious reading — "a leg that never fires is furniture" — is WRONG here, and
 * the code says why: when the adjudicator is unreachable, dispatch PROCEEDS,
 * and the regex is then the only thing between an obviously unsafe brief and
 * the editor. Its zero means the outage has not happened, not that it does
 * nothing.
 *
 * But an unexercised fail-closed path is a promise, not a property. That is
 * this file.
 *
 * THE PROBE IS DERIVED FROM THE SHIPPED PATTERN AT RUNTIME AND IS NEVER
 * STORED. Unsafe text does not go in a fixture — standing rule — so the probe
 * is reconstructed from the regex the module already carries, verified to
 * match, and never printed. If the reconstruction stops matching, that is a
 * HARNESS FAILURE and the run exits non-zero: a probe that quietly stopped
 * being unsafe would make leg 1 vacuous while still reading green, which is
 * the exact false-green class this lane keeps finding.
 *
 * NO API SPEND. Every leg passes `apiKey: ''`, which returns
 * REVIEW_UNAVAILABLE before any network call.
 */
'use strict';
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const C = require('../../lib/negotiation-classifier.js');

let fail = 0, n = 0;
const leg = (name, ok, detail) => {
  n++; if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ::  ' + detail : ''}`);
};

// ---- build a probe from the shipped pattern, without ever showing it --------
const SRC = readFileSync(join(__dirname, '../../lib/negotiation-classifier.js'), 'utf8');
// SLICE TO `].join`, NOT TO THE FIRST `]` — the alternatives contain `[^.]`
// character classes, so the first `]` sits INSIDE the first alternative and a
// naive slice reads 49 characters of one entry as the whole table. That is how
// this file's own first run reported "no alternatives found", which is the
// harness failing loudly rather than testing nothing.
const start = SRC.indexOf('const UNSAFE = new RegExp([');
const end = SRC.indexOf('].join', start);
const arr = SRC.slice(start, end > 0 ? end : start);
const literals = [...arr.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1]);

if (literals.length === 0) {
  console.log('  HARNESS FAILURE :: no alternatives found in the UNSAFE pattern source');
  process.exit(2);
}

// Turn one regex alternative back into a string that MATCHES it. Every
// output is verified against the shipped pattern below, so a transformation
// that silently produces a benign string cannot pass as a probe.
const plain = (rx) => rx
  .replace(/\(\?:([^)|]*)(?:\|[^)]*)?\)/g, '$1')   // (?:a|b) -> a
  .replace(/\(([^)|]*)(?:\|[^)]*)?\)/g, '$1')      // (a|b)   -> a
  .replace(/\[\^[^\]]*\]\{\d+,\d+\}/g, ' ')        // [^.]{0,24} -> one space
  .replace(/\[\^[^\]]*\][*+?]?/g, ' ')             // [^.]*      -> one space
  .replace(/\\w[*+]/g, 'e').replace(/\\w/g, 'e')    // \w* -> e
  .replace(/\\s[*+]?/g, ' ')                      // \s+ -> space
  .replace(/\\b/g, '')
  .replace(/\\([^\\])/g, '$1')                     // \. -> .
  .replace(/[*+?]/g, '')
  .replace(/\s+/g, ' ').trim();

let probe = null;
for (const lit of literals) {
  const cand = plain(lit);
  if (cand && C.classify(cand).verdict === 'REFUSE') { probe = cand; break; }
}
if (!probe) {
  console.log(`  HARNESS FAILURE :: reconstructed ${literals.length} alternative(s), none matched the shipped pattern`);
  process.exit(2);
}
console.log(`  (probe derived from ${literals.length} pattern alternative(s); not printed, not stored)`);

(async () => {

// ---- 1. THE REGEX ACTUALLY REFUSES, AND WITHOUT THE MODEL ------------------
// apiKey '' makes the adjudicator unreachable. A REFUSE here cannot have come
// from the model, so it is the early-refuse path or nothing.
const r1 = await C.classifyWithSafety(probe, { apiKey: '' });
leg('an unsafe brief is REFUSED with the model unreachable',
    r1.verdict === 'REFUSE', `verdict=${r1.verdict}`);
leg('  ...and the refusal is attributed to the regex, not the model',
    r1.safety && r1.safety.by === 'regex' && r1.safety.unsafe === true,
    `by=${r1.safety && r1.safety.by} unsafe=${r1.safety && r1.safety.unsafe}`);
leg('  ...and it is not marked degraded, because nothing was degraded about it',
    r1.degraded === false, `degraded=${r1.degraded}`);

// ---- 2. THE BACKSTOP IS NARROW ---------------------------------------------
// Without this leg, leg 1 would also pass if EVERYTHING refused when the key is
// missing — which would be a blanket fail-closed, not a working pattern.
const r2 = await C.classifyWithSafety('add captions and a zoom on the product', { apiKey: '' });
leg('a benign brief still PASSES with the model unreachable',
    r2.verdict === 'PASS', `verdict=${r2.verdict}`);
leg('  ...and says so: degraded, with the outage alert raised',
    r2.degraded === true && !!r2.alert && r2.alert.kind === 'safety_review_unavailable',
    `degraded=${r2.degraded} alert=${r2.alert && r2.alert.kind}`);
leg('  ...and is attributed to the model path, not the regex',
    r2.safety && r2.safety.by === 'model', `by=${r2.safety && r2.safety.by}`);

// ---- 3. THE PROBE IS GENUINELY THE PATTERN'S -------------------------------
leg('the probe matches the shipped pattern (leg 1 is not vacuous)',
    C.classify(probe).verdict === 'REFUSE');

console.log(fail ? `\n${fail} of ${n} FAILED` : `\nall ${n} legs green`);
process.exit(fail ? 1 : 0);

})().catch((e) => { console.log('  HARNESS FAILURE :: ' + e.message); process.exit(2); });

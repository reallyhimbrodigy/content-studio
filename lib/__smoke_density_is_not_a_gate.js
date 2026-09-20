'use strict';
// THE DENSITY RATES GRADE; THEY NEVER INSTRUCT.
//
// Standing law. They must never reach the agent as a target, appear in the
// prompt, or be enforced as a floor at ruling time. A run that places two zooms
// because two moments deserved them is CORRECT, and a rubric that calls it
// short is the rubric's problem.
//
// This is gated rather than trusted because the failure mode is SLOW: a rate
// that starts as a printed number acquires a threshold, then a warning, then an
// exit code, one plausible commit at a time. One rate already survived a
// careful removal by sitting in prose — "Overlay text is the WORKHORSE
// (~7.5 per 25s)" — because a sentence DESCRIBING a rate reads as harmless
// beside a schema field that DEMANDS one.
const fs = require('fs'), path = require('path');
const sb = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'scoreboard.js'), 'utf8');
let fails = [];
const check = (n, c, why = '') => { console.log(`  [${c ? 'ok' : 'FAIL'}] ${n}`); if (!c) fails.push(`${n} :: ${why}`); };

check('the reference rates exist in the scoreboard', /REFERENCE_PER_25S/.test(sb));

// 1. THE BLOCK MUST NOT COMPARE. No threshold, no verdict, no exit.
const i = sb.indexOf('// ── DENSITY: A NUMBER, NEVER A GATE');
const j = sb.indexOf('const aAsks', i);
// COMMENTS STRIPPED FOR EVERY CHECK, not just some. The first version tested
// the raw block and failed on the word "verdict" inside its own explanatory
// comment — a check tripping over the prose that explains it.
const block = sb.slice(i, j).replace(/^\s*\/\/.*$/gm, '');
check('the density block contains no comparison against the reference',
  !/REFERENCE_PER_25S\[[^\]]*\]\s*[<>]/.test(block) && !/per25\[[^\]]*\]\s*[<>]/.test(block),
  'a rate compared is a rate enforced, whatever the variable is called');
check('the density block sets no verdict and no exit code',
  !/\bverdict\b|process\.exit|throw |fail\(/.test(block),
  'grading never refuses');
// WORD BOUNDARIES. `ratio` matched inside du-RATIO-n_s, which is the same
// substring trap that made `.update(` match createHash().update(). A checker
// that fires on a fragment of an unrelated identifier teaches people to ignore
// it.
check('the density block does not compute a pass/fail ratio',
  !/\bratio\b|\bshort\b|\bbelow\b|\babove\b|\btarget\b|\bfloor\b/i.test(block),
  'a ratio is a threshold waiting for an operator');

// 2. IT MUST BE PRINTED — a number nobody sees answers nothing.
check('the density line is printed', /console\.log\(`DENSITY/.test(sb),
  'a counter added to answer a question gets printed in the same commit');
check('...and says plainly that it is not a gate',
  /a number, never a gate/.test(sb));

// 3. ABSENT IS NOT ZERO.
check('no measured output prints EMPTY, not 0.00',
  /EMPTY — no agentic output measured\. Not zero\./.test(sb),
  'a 0.00/25s density reads as "it placed nothing", which is a finding; "nothing was measured" is not');

// 4. THE RATES MUST NOT REACH THE AGENT. Nothing here may be exported to any
//    prompt-building path.
check('the rates are local to the scoreboard, not exported',
  !/module\.exports[^]*REFERENCE_PER_25S/.test(sb),
  'an exported rate is one import away from a prompt');

console.log();
if (fails.length) { console.log('DENSITY IS NOT A GATE: FAIL'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('DENSITY IS NOT A GATE: PASS — computed, printed, compared to nothing');

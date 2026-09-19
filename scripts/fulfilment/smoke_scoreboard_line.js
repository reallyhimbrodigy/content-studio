'use strict';
// A COMPUTED GROUP THAT NEVER REACHES THE ROW IS A PRINT-ONLY NUMBER.
// The agentic block was written, computed, and spread into nothing: the print
// then read `row.agentic_state` as undefined and would have shown "EMPTY"
// forever — including after the first real batch landed. Caught by looking;
// gated so the next group cannot repeat it.
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'scoreboard.js'), 'utf8');
let fails = [];
const check = (n, c, why = '') => { console.log(`  [${c ? 'ok' : 'FAIL'}] ${n}`); if (!c) fails.push(`${n} :: ${why}`); };

const rowLine = (src.match(/const row = \{[^}]*\}/) || [''])[0];
check('the scoreboard builds one row object', !!rowLine);

// every `const <name> = { ... }` group that feeds the digest must be spread in
for (const g of ['fulfillment', 'agentic', 'latency', 'exportConv']) {
  check(`\`${g}\` is spread into the persisted row`, rowLine.includes(`...${g}`),
    'computed and not persisted is a print-only number; the digest then reads undefined');
}
// and the agentic line must be PRINTED, not merely stored
check('the agentic line is printed in the digest',
  /console\.log\(`AGENTIC/.test(src),
  'a counter added to answer a question gets printed in the same commit that adds it');
// ABSENT must not be spelled as a zero
check('an absent agentic read prints EMPTY, never 0',
  /EMPTY —/.test(src) && /Not zero/.test(src),
  'a 0.000 honor rate reads as "it honored nothing", which is a finding; "nothing was measured" is not');
// the four numbers Zac named
for (const f of ['agentic_honor_rate', 'agentic_silent_drop_rate', 'agentic_negotiated_rate', 'agentic_unchecked'])
  check(`${f} is computed`, src.includes(f));

console.log();
if (fails.length) { console.log('SCOREBOARD LINE: FAIL'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('SCOREBOARD LINE: PASS — computed, persisted, printed, and empty is not zero');

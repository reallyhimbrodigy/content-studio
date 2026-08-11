'use strict';
// Gate for the lost-terminal-transition classifier (2026-08-11).
//
// FORGED FROM A LIVE CAPTURE. Job 4f37eb44 sat at progress=100 /
// current_step='complete' / status='processing' for 25+ minutes while the
// render was finished. The diagnostic that had gone live 20 minutes earlier
// fired twice and said `mechanism: zero_rows_nonterminal` — correct, and not
// enough: "zero rows" covers a failed write, a benign lost race, and the real
// stuck row, and the response to each is different. Worse, the update's error
// was being DISCARDED, so a failed write and a real zero-match were the same
// observation.
//
// Laws:
//   1. an error present ⇒ 'update_error', whatever the row now says. A failed
//      write is not evidence about the row.
//   2. no error + row now terminal ⇒ 'lost_race_benign'. First-terminal-wins
//      working as designed. Counting these as defects inflates the class the
//      same way per-job counting once turned a one-user bug into an "outage".
//   3. no error + row still non-terminal ⇒ 'row_still_nonterminal' — the real
//      defect, the one where a user is told a finished video failed.
//   4. unknown/absent status is NOT treated as terminal: unreadable must read
//      as the defect, never as the benign case. A diagnostic that resolves its
//      own uncertainty in the reassuring direction is how a class stays hidden.

const assert = require('assert');
const { classifyLostTransition } = require('./job-status');

// 1. error dominates
assert.strictEqual(classifyLostTransition({ transitionErr: { code: 'PGRST204' }, nowStatus: 'completed' }),
  'update_error', 'an error must win over any row state');
assert.strictEqual(classifyLostTransition({ transitionErr: new Error('boom'), nowStatus: 'processing' }),
  'update_error');

// 2. benign race — every terminal spelling, incl. the legacy ones
for (const s of ['completed', 'failed', 'canceled', 'needs_input', 'complete', 'cancelled', 'error']) {
  assert.strictEqual(classifyLostTransition({ nowStatus: s }), 'lost_race_benign',
    `row already terminal ('${s}') is the guard working, not a defect`);
}
assert.strictEqual(classifyLostTransition({ nowStatus: 'COMPLETED' }), 'lost_race_benign',
  'status comparison must be case-insensitive');

// 3. the real defect
assert.strictEqual(classifyLostTransition({ nowStatus: 'processing' }), 'row_still_nonterminal',
  'a still-processing row after a completed patch IS the stuck class');
assert.strictEqual(classifyLostTransition({ nowStatus: 'pending' }), 'row_still_nonterminal');

// 4. unreadable must not flatter itself
assert.strictEqual(classifyLostTransition({ nowStatus: null }), 'row_still_nonterminal',
  'an unreadable row must read as the defect, never as the benign race');
assert.strictEqual(classifyLostTransition({}), 'row_still_nonterminal',
  'no information must read as the defect');

// 5. WIRING: server.js must capture the error and use the classifier. The
// original defect was not the logic — it was `const { data } = await ...`
// silently dropping `error`.
const fs = require('fs');
const path = require('path');
const sv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.ok(/error:\s*transitionErr\s*\}\s*=\s*await/.test(sv),
  'server.js must CAPTURE the transition update error — dropping it is the original defect');
assert.ok(/classifyLostTransition\s*\(/.test(sv),
  'server.js must call classifyLostTransition — an unused classifier explains nothing');
assert.ok(/cause,/.test(sv) && /now_status:/.test(sv),
  'the analytics props must carry cause + now_status, or the next occurrence is another inference');

console.log('lost-transition smoke: PASS (error dominates, 8 terminal spellings benign, '
  + 'still-processing = defect, unreadable = defect not benign, server.js captures err + wires classifier)');
process.exit(0);

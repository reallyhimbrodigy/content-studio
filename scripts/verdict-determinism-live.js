'use strict';
// LIVE LEG: eight runs, eight identical verdicts.
//
// The static smoke proves the temperature is pinned in the source. It cannot
// prove the provider honours it, and it cannot prove the verdict is stable for
// a real message. This does — against the real model, on the real path.
//
// Not part of validate_deploy: it costs money and needs the network. Run it
// when the decider or its prompt changes.
//
//   node scripts/verdict-determinism-live.js
//
// Exit 0 = every message returned ONE distinct verdict across eight runs.
const fs = require('fs');
for (const line of fs.readFileSync('/Users/zaclibman/content-studio/.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}
const chat = require('../lib/chat-actions');

// Messages chosen to sit near a BOUNDARY, because a verdict that is obvious is
// stable at any temperature and proves nothing. These are the ones that flip.
const CASES = [
  'make it punchier',                       // act_reedit vs converse
  'how long until my video is done?',       // status vs converse
  'can you cut the boring bit at the start', // act_reedit vs converse
  'what can you do?',                       // converse, should be firm
];
const RUNS = 8;

(async () => {
  let bad = 0;
  const unmeasured = [];
  for (const msg of CASES) {
    const kinds = [];
    for (let i = 0; i < RUNS; i++) {
      try {
        const v = await chat.decideChatAction(msg, {});
        // POSITIVE CONTROL, AND IT IS THE WHOLE POINT OF THIS LEG.
        // Every fallback in decideChatAction is DETERMINISTIC by construction —
        // a disabled flag, a trivial message, a 401 from the provider all return
        // `converse` every single time. Counting those as eight identical
        // verdicts reports PASS for a path the model never touched. The first
        // run of this script did exactly that: 4/4 "STABLE", all converse, all
        // actually reason=decide_failed:gemini_http_401 with enabled()=false.
        // So a run that did not reach the model is UNMEASURED, never passing.
        if (v && v.reason) { unmeasured.push(`${msg} -> ${v.reason}`); kinds.push('UNMEASURED:' + v.reason); }
        else kinds.push(v && v.kind ? v.kind : 'ERROR');
      } catch (e) { unmeasured.push(`${msg} -> threw`); kinds.push('THREW:' + (e && e.message || '').slice(0, 30)); }
    }
    const distinct = [...new Set(kinds)];
    const ok = distinct.length === 1;
    if (!ok) bad++;
    console.log(`  ${ok ? 'STABLE  ' : 'UNSTABLE'} ${JSON.stringify(msg).padEnd(46)} -> ${distinct.join(' | ')}`
      + (ok ? ` (${RUNS}/${RUNS})` : `   counts: ${distinct.map(d => d + '=' + kinds.filter(k => k === d).length).join(', ')}`));
  }
  if (unmeasured.length) {
    console.log(`verdict-determinism-live: CANNOT MEASURE — ${unmeasured.length} run(s) never reached the model.`);
    for (const u of [...new Set(unmeasured)]) console.log('    ' + u);
    console.log('    Every fallback here is deterministic, so this would otherwise report a');
    console.log('    confident PASS for a path the model never ran. Needs chat tools ENABLED');
    console.log('    and a GEMINI key the provider accepts.');
    process.exit(1);
  }
  if (bad) { console.log(`verdict-determinism-live: FAIL — ${bad}/${CASES.length} message(s) returned more than one verdict`); process.exit(1); }
  console.log(`verdict-determinism-live: PASS — ${CASES.length} messages, ${RUNS} runs each, one verdict apiece`);
})();

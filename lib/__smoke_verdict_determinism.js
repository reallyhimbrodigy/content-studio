'use strict';
// A MODEL CALL THAT PRODUCES A VERDICT RUNS AT TEMPERATURE 0.
//
// A verdict is a result the CODE BRANCHES ON. A sentence shown to a user is
// not. Drawn above 0, a verdict is one sample of a distribution: Builder 2's
// classifier ran at the 1.0 default and returned unsafe true,true,false,false,
// true across five runs on ONE brief, which meant every rate quoted off it —
// including a false-positive rate given to Zac — was a sample, not a measurement.
//
// WHY THIS IS WORSE ON A ROUTING PATH THAN ON A FIXTURE. A flaky fixture
// eventually goes red and someone looks. `decideChatAction` chooses between
// converse / status / act_render / act_reedit and the caller branches on it, so
// a flip produces a plausible reply either way. There is no red leg to re-run,
// only a support message saying "it ignored me". That is why the rule has two
// halves — pin the temperature AND keep the verdict falsifiable — and why this
// file also SCANS for new sites rather than only asserting the known two.
//
// The scanner is the part that earns its keep: Builder 2's own static leg found
// their FULFILMENT JUDGE (the thing producing the numbers that lane reports)
// still at 1.0, minutes after the leg existed, because they had pinned the
// classifier where the symptom was and stopped looking.
//
// Exit 0 = clean. Exit 1 = a verdict is being drawn from a distribution.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const bad = [];

// ---- 1. the known verdict site is pinned -----------------------------------
const chat = fs.readFileSync(path.join(ROOT, 'lib', 'chat-actions.js'), 'utf8');
const decide = chat.match(/generationConfig:\s*\{[^}]*DECIDE_MAX_TOKENS[^}]*\}/);
if (!decide) {
  bad.push('the decideChatAction generationConfig is gone — cannot verify its temperature');
} else if (!/temperature:\s*0\s*[,}]/.test(decide[0])) {
  bad.push('decideChatAction is no longer at temperature 0. It decides converse / status / '
         + 'act_render / act_reedit and the caller BRANCHES on it, so above 0 the same '
         + 'message can route differently on two runs with no red leg to catch it');
}

// ---- 2. the text path is deliberately NOT pinned, and says why --------------
// Asserted so nobody "fixes" it to 0 later and quietly flattens the copy.
const confirm = chat.match(/generationConfig:\s*\{[^}]*CONFIRM_MAX_TOKENS[^}]*\}/);
if (!confirm) {
  bad.push('the composeConfirmation generationConfig is gone');
} else if (/temperature:\s*0\s*[,}]/.test(confirm[0])) {
  bad.push('composeConfirmation was pinned to 0. It writes the user-facing sentence, nothing '
         + 'branches on it, and function calling is disabled there — pinning it flattens the '
         + 'copy without making anything measurable');
}
if (!/deliberately stays at 0\.6/.test(chat)) {
  bad.push('the reason composeConfirmation is NOT pinned is no longer written down — the next '
         + 'reader sees an inconsistency and picks a side at random');
}

// ---- 3. SCAN for new verdict-producing calls that are not pinned -----------
// Anchored on a real call config (generationConfig / messages:) so a `model:`
// string inside a diagnostics JSON payload is not mistaken for a call —
// /api/internal/gemini-diag reports `model` as a FIELD and tripped the first
// version of this scan.
const VERDICT = /verdict|\bkind\b|decide|classif|judge|adjudicat|\bintent\b|is_?safe|unsafe|refus|\bgate\b/i;
const SKIP = /(^|\/)(__smoke_|node_modules|\.worktrees|scripts\/fulfilment)/;
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.worktrees')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.js$/.test(e.name) && !SKIP.test(p.replace(ROOT + '/', ''))) files.push(p);
  }
})(ROOT);

let scanned = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = f.replace(ROOT + '/', '');
  const re = /generationConfig:\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    scanned++;
    const at = src.slice(0, m.index).split('\n').length;
    const window = src.slice(Math.max(0, m.index - 1500), m.index + 1500);
    if (!VERDICT.test(window)) continue;                       // content, not a verdict
    if (/temperature:\s*0\s*[,}]/.test(m[0])) continue;        // pinned
    if (/CONFIRM_MAX_TOKENS/.test(m[0])) continue;             // the sanctioned text path
    bad.push(`${rel}:${at} produces a verdict but is not pinned to temperature 0 `
           + `(${(m[1].match(/temperature:\s*[0-9.]+/) || ['temperature UNSET — provider default'])[0]})`);
  }
}
if (scanned === 0) bad.push('the scanner found NO model call configs at all — it has gone blind');

if (bad.length) {
  console.log('verdict-determinism: FAIL');
  for (const b of bad) console.log('  -', b);
  process.exit(1);
}
console.log(`  decideChatAction pinned to 0; composeConfirmation deliberately at 0.6 with its `
  + `reason recorded; ${scanned} model call configs scanned, no unpinned verdict sites.`);
console.log('verdict-determinism: PASS');

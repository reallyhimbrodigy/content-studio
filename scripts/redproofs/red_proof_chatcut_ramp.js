// RED proof for the ramp and its kill switch.
const fs = require('fs'), cp = require('child_process'), path = require('path');
const ROOT  = path.join(__dirname, '..', '..');
const SMOKE = path.join(ROOT, 'lib', '__smoke_chatcut_ramp.js');
const RAMP  = path.join(ROOT, 'lib', 'chatcut-ramp.js');
const ROUTE = path.join(ROOT, 'lib', 'chatcut-routing.js');
const FLAGS = path.join(ROOT, 'lib', 'upload-flags.js');

const M = [
  // THE KILL AS ZAC FIRST SPECIFIED IT: percent 0 + enabled_all false, with no
  // separate kill flag. An allowlisted account keeps spending.
  ['kill_does_not_beat_the_allowlist', RAMP,
   "  if (kill && kill.on) {",
   "  if (kill && kill.on && false) {",
   'K2'],
  // THE KILL IS ANDed WITH THE RAMP instead of being absolute — so a ramp hit
  // outvotes it, which is the whole failure the separate flag exists to stop.
  // (The first writing appended `if (false) {}` after the ramp's return: dead
  // code after an unconditional return, which mutates nothing.)
  ['kill_is_anded_with_the_ramp', RAMP,
   "  if (kill && kill.on) {\n    return { allowed: false, reason: 'killed', source: kill.source, dbState: kill.dbState || null };\n  }",
   "  if (kill && kill.on && !(await resolveFlag(RAMP_FLAG, userId)).on) {\n    return { allowed: false, reason: 'killed', source: kill.source, dbState: kill.dbState || null };\n  }",
   'K2'],
  // AN UNREADABLE STORE FAILS OPEN — the spend path routed on a switch we
  // could not read.
  ['an_unreadable_store_fails_open', RAMP,
   "  if (kill && kill.dbState === 'unreadable') {",
   "  if (false) {",
   'K4b'],
  ['an_unreadable_ramp_fails_open', RAMP,
   "  if (ramp && ramp.dbState === 'unreadable') {",
   "  if (false) {",
   'K4a'],
  // "we could not ask" reported as "we were told no" — an outage wearing a
  // configuration's clothes.
  // "we could not ask" reported as "we were told no" — an outage wearing a
  // configuration's clothes. FIRST WRITING WAS VACUOUS (it appended a field
  // nobody reads); this one changes the reason the row records.
  ['unreadable_is_reported_as_ramp_off', RAMP,
   "    return { allowed: false, reason: 'flags_unreadable', source: ramp.source, dbState: 'unreadable' };",
   "    return { allowed: false, reason: 'ramp_off', source: ramp.source, dbState: 'unreadable' };",
   'K4a'],
  // A CHATCUT RE-EDIT IS STRANDED BY THE RAMP — handler gets a plan it cannot
  // read, which is a wrong edit rather than an honest no.
  ['the_ramp_strands_a_chatcut_reedit', RAMP,
   "  if (isChatcutReedit) {\n    return { allowed: true, reason: 'reedit_must_use_chatcut', source: 'bypass', dbState: null };\n  }",
   "  if (false) {}",
   'K3'],
  // THE RE-EDIT BYPASSES THE GUARD TOO, so the hard credit floor stops biting.
  ['the_reedit_bypasses_the_credit_floor', ROUTE,
   "  const guard = decideRoute(accountStatus, { isChatcutReedit, env });\n  return { ...guard, stage: 'guard', rampReason: ramp.reason, rampSource: ramp.source };",
   "  if (isChatcutReedit) return { route: ROUTE_CHATCUT, reason: 'chatcut', stage: 'guard' };\n  const guard = decideRoute(accountStatus, { isChatcutReedit, env });\n  return { ...guard, stage: 'guard', rampReason: ramp.reason, rampSource: ramp.source };",
   'K3'],
  // dbState stops being reported, so no caller can fail closed on it.
  ['dbState_is_no_longer_reported', FLAGS,
   "  const dbState = rows === null ? 'unreadable' : 'ok';",
   "  const dbState = 'ok';",
   'K5'],
  // THE 30-SECOND WINDOW BECOMES TEN MINUTES — a kill that does not land.
  ['the_cache_window_grows', FLAGS,
   "const CACHE_MS = 30 * 1000;",
   "const CACHE_MS = 10 * 60 * 1000;",
   'K8'],
];

const run = () => { try { const o = cp.execFileSync(process.execPath, [SMOKE], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }); return { code: 0, out: o }; } catch (e) { return { code: e.status, out: (e.stdout||'') + (e.stderr||'') }; } };

const base = run();
if (base.code !== 0) { console.error('HARNESS FAILURE: unmutated smoke is not green'); console.error(base.out.slice(-800)); process.exit(2); }
console.log('baseline green.\n');
let red = 0;
for (const [name, file, from, to, leg] of M) {
  const raw = fs.readFileSync(file, 'utf8');
  const n = raw.split(from).length - 1;
  if (n !== 1) { console.log(`  ${name.padEnd(40)} HARNESS FAILURE: anchor ${n}x`); continue; }
  fs.writeFileSync(file, raw.replace(from, to));
  const r = run();
  fs.writeFileSync(file, raw);
  const named = r.out.includes(leg + ':') || r.out.includes(leg + ' ');
  const ok = r.code !== 0 && named;
  if (ok) red++;
  console.log(`  ${name.padEnd(40)} ${ok ? 'RED ' : 'NOT RED'}  exit=${r.code} names_${leg}=${named}`);
  if (!ok) console.log('      | ' + r.out.trim().split('\n').slice(-3).join(' | ').slice(0, 260));
}
console.log(`\n${red}/${M.length} RED-proven`);
process.exit(red === M.length ? 0 : 1);

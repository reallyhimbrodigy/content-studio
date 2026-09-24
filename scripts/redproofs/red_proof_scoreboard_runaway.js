// RED proof for the runaway laws. Each mutation restores a piece of the
// production defect; the smoke must go red on the NAMED leg. A leg that
// cannot fail is not yet a check.
const fs = require('fs'), cp = require('child_process'), path = require('path');
const ROOT  = path.join(__dirname, '..', '..');
const SMOKE = path.join(ROOT, 'lib', '__smoke_scoreboard_scheduler.js');
const SCHED = path.join(ROOT, 'lib', 'scoreboard-scheduler.js');
const SB    = path.join(ROOT, 'scripts', 'scoreboard.js');
const JUDGE = path.join(ROOT, 'scripts', 'fulfillment-judge.js');

const M = [
  ['written_from_the_exit_code', SCHED,
   "      if (after === true) {\n        log.error(`[scoreboard] ${day} written (row read back)`);",
   "      if (true) {\n        log.error(`[scoreboard] ${day} written`);",
   'LAW 6'],
  ["stdio_ignore_discards_the_diagnosis", SCHED,
   "        stdio: ['ignore', 'ignore', 'pipe'],",
   "        stdio: 'ignore',",
   'LAW 7a'],
  ['no_backoff_between_failed_attempts', SCHED,
   "      if (t < st.nextAt) return;   // in backoff; quiet by design",
   "      // backoff removed",
   'LAW 8'],
  ['no_attempt_cap', SCHED,
   "      if (st.n >= maxAttempts) {",
   "      if (false) {",
   'LAW 9'],
  ['judge_spawns_unconditionally', SB,
   "  if (!process.argv.includes('--judge')) {",
   "  if (false) {",
   'LAW 12'],
  ['offset_pagination_returns', JUDGE,
   "`${URL_}/rest/v1/${pathq}${cursor}&order=created_at.asc,id.asc&limit=${PAGE}`)",
   "`${URL_}/rest/v1/${pathq}${cursor}&order=created_at.asc,id.asc&limit=${PAGE}&offset=0`)",
   'LAW 13'],
];

const run = () => { try { const o = cp.execFileSync(process.execPath, [SMOKE], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }); return { code: 0, out: o }; } catch (e) { return { code: e.status, out: (e.stdout||'') + (e.stderr||'') }; } };

const base = run();
if (base.code !== 0) { console.error('HARNESS FAILURE: unmutated smoke is not green'); console.error(base.out.slice(-600)); process.exit(2); }
console.log('baseline green.\n');
let red = 0;
for (const [name, file, from, to, leg] of M) {
  const raw = fs.readFileSync(file, 'utf8');
  const n = raw.split(from).length - 1;
  if (n !== 1) { console.log(`  ${name.padEnd(40)} HARNESS FAILURE: anchor ${n}x in ${path.basename(file)}`); continue; }
  fs.writeFileSync(file, raw.replace(from, to));
  const r = run();
  fs.writeFileSync(file, raw);
  const named = new RegExp(leg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(r.out);
  const ok = r.code !== 0 && named;
  if (ok) red++;
  console.log(`  ${name.padEnd(40)} ${ok ? 'RED ' : 'NOT RED'}  exit=${r.code} names_${leg.replace(' ','')}=${named}`);
  if (!ok) console.log('      | ' + r.out.trim().split('\n').slice(-3).join(' | ').slice(0, 260));
}
console.log(`\n${red}/${M.length} RED-proven`);
process.exit(red === M.length ? 0 : 1);

// RED proof for "a failed job can never cost credits".
const fs = require('fs'), cp = require('child_process'), path = require('path');
const ROOT  = path.join(__dirname, '..', '..');
const SMOKE = path.join(ROOT, 'lib', '__smoke_fail_with_refund.js');
const SRC   = path.join(ROOT, 'lib', 'fail-with-refund.js');
const DIS   = path.join(ROOT, 'lib', 'video-processor', 'dispatch-to-modal.js');

const M = [
  // THE WINDOW COMES BACK: mark failed first, refund after. This is exactly
  // the state the refund-leg sweep leaves behind for up to a minute.
  ['terminalize_before_refund', SRC,
   "  if (o.owed) {\n    try {\n      await refund(o.amount, job);",
   "  await terminalize({});\n  if (o.owed) {\n    try {\n      await refund(o.amount, job);",
   'L1'],
  // TWO WRITES INSTEAD OF ONE: credits_refunded_at no longer rides with
  // status='failed', so the two facts can be observed apart.
  ['the_refund_stamp_leaves_the_patch', SRC,
   "  if (o.owed) patch.credits_refunded_at = now().toISOString();",
   "  // stamp removed",
   'L1'],
  // A FAILED REFUND STILL MARKS THE ROW — the silent charge, restored.
  ['a_failed_refund_still_marks_it', SRC,
   "      return { state: 'REFUND_FAILED', amount: o.amount, detail, marked: false };",
   "      return { state: 'REFUND_FAILED', amount: o.amount, detail, marked: true };",
   'L2'],
  // FIRST WRITING WAS VACUOUS: `if (false) throw e;` left the `return` in
  // place, so control flow was identical and the suite stayed green. A
  // mutation that changes no behaviour is not a mutation. This one deletes
  // the return, so a failed refund falls through to the terminal write —
  // which is the silent charge itself.
  ['a_failed_refund_falls_through_to_terminalize', SRC,
   "      return { state: 'REFUND_FAILED', amount: o.amount, detail, marked: false };",
   "      /* falls through */",
   'L2'],
  // THE ALERT GOES QUIET — a refund failure nobody hears about.
  ['a_refund_failure_stops_alerting', SRC,
   "        await alert('💸 [Promptly] refund failed — job held non-terminal',",
   "        if (false) await alert('💸 [Promptly] refund failed — job held non-terminal',",
   // L2, not L3: L2 asserts the alert on the refund-failure path and reads
   // before L3's across-all-modes sweep does.
   'L2'],
  // A NULL DEBIT IS TREATED AS ZERO AND REFUNDED — crediting users who were
  // never charged, on the dark-answer receipt.
  ['a_null_debit_gets_refunded', SRC,
   "  if (!Number.isFinite(n) || n <= 0) {",
   "  if (false) {",
   'L5'],
  // NOT IDEMPOTENT: a second pass refunds again.
  ['already_refunded_refunds_again', SRC,
   "  if (job.credits_refunded_at) {\n    return { owed: false, amount: null, why: 'already refunded' };\n  }",
   "  if (false) {}",
   'L6'],
  // A THROWING ALERT TAKES THE WHOLE THING DOWN.
  ['a_throwing_alert_breaks_the_refund', SRC,
   "      } catch (_) { /* an alert must never be the thing that fails a refund */ }",
   "      } catch (_e) { throw _e; }",
   'L7'],
  // THE STATE THAT MUST NOT EXIST GETS A NAME — and therefore a path.
  ['the_forbidden_state_is_named', SRC,
   "  'REFUND_FAILED', 'TERMINALIZE_FAILED',",
   "  'REFUND_FAILED', 'TERMINALIZE_FAILED', 'MARKED_WITHOUT_REFUND',",
   'L8'],
  // UNWIRED: the module is correct and nothing calls it — the inert-instrument
  // shape that the guard, the metering column and the scoreboard have all been.
  ['markJobFailed_stops_calling_it', DIS,
   "  const _fw = await _fwr.failWithRefund(",
   "  const _fw = { marked: true, outcome: null }; const _unused = (",
   'L9'],
  // THE HOLD MOVES BELOW THE SSE PUSH — the client is told "failed" first and
  // the hold protects nothing.
  ['the_hold_lands_after_the_client_is_told', DIS,
   "  if (!_fw.marked) {",
   "  if (false) {",
   'L9'],
];

const run = () => { try { const o = cp.execFileSync(process.execPath, [SMOKE], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }); return { code: 0, out: o }; } catch (e) { return { code: e.status, out: (e.stdout||'') + (e.stderr||'') }; } };

const base = run();
if (base.code !== 0) { console.error('HARNESS FAILURE: unmutated smoke is not green'); console.error(base.out.slice(-800)); process.exit(2); }
console.log('baseline green.\n');
let red = 0;
for (const [name, file, from, to, leg] of M) {
  const raw = fs.readFileSync(file, 'utf8');
  const n = raw.split(from).length - 1;
  if (n !== 1) { console.log(`  ${name.padEnd(42)} HARNESS FAILURE: anchor ${n}x`); continue; }
  fs.writeFileSync(file, raw.replace(from, to));
  const r = run();
  fs.writeFileSync(file, raw);
  const named = r.out.includes(leg + ':') || r.out.includes(leg + ' ');
  const ok = r.code !== 0 && named;
  if (ok) red++;
  console.log(`  ${name.padEnd(42)} ${ok ? 'RED ' : 'NOT RED'}  exit=${r.code} names_${leg}=${named}`);
  if (!ok) console.log('      | ' + r.out.trim().split('\n').slice(-3).join(' | ').slice(0, 260));
}
console.log(`\n${red}/${M.length} RED-proven`);
process.exit(red === M.length ? 0 : 1);

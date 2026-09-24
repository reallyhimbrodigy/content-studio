// RED proof for the re-edit 402 contract.
const fs = require('fs'), cp = require('child_process'), path = require('path');
const ROOT  = path.join(__dirname, '..', '..');
const SMOKE = path.join(ROOT, 'lib', '__smoke_reedit_policy.js');
const SRC   = path.join(ROOT, 'lib', 'reedit-policy.js');
const TBL   = path.join(ROOT, 'lib', 'credit-prices.json');

const M = [
  // THE PRICE MOVES BACK INTO THE ROUTE.
  //
  // FIRST ATTEMPT WAS VACUOUS AND THE PROOF SAID SO. Hardcoding it to 5 — the
  // table's own current value — cannot fail C4, because C4 compares the quote
  // against the table and both read 5. A mutation that produces the right
  // answer for the wrong reason is not a mutation.
  //
  // The property "it READS the table" is proven by the_table_price_drifts
  // below: move the table, and the quote must move with it. That is the only
  // mutation that can distinguish a read from a coincidence. This one proves
  // the narrower thing — that the quote is the ruled number.
  ['the_price_is_a_different_constant', SRC,
   "  const row = t && t.our_prices && t.our_prices.reedit_post_cap;",
   "  const row = { credits: 7, why: 'written into the route' };",
   // L2, not C4: the re-aimed boundary leg compares the DECISION's charge
   // against the table and fires first. Naming C4 here would be naming what
   // ought to catch it rather than what does.
   'L2'],
  // A MISSING PRICE QUOTES ZERO — the work given away, and nothing surfaces it.
  ['a_missing_price_quotes_zero', SRC,
   "    : { price: null, state: 'ABSENT',",
   "    : { price: 0, state: 'ABSENT',",
   'C5'],
  // AN UNREAD BALANCE RENDERS AS ZERO. The obvious spelling, and the one I
  // wrote first: Number(null) is 0 and Number.isFinite(0) is true.
  ['an_unread_balance_renders_as_zero', SRC,
   "    balance: (balance == null || !Number.isFinite(Number(balance)))\n      ? null : Number(balance),",
   "    balance: Number.isFinite(Number(balance)) ? Number(balance) : null,",
   'C6'],
  // THE SERVER STARTS WRITING THE COPY — a second authority beside the client.
  ['the_server_writes_the_copy', SRC,
   "    reason: d.reason || 'cap_reached',",
   "    message: 'You have used your included re-edits.',\n    reason: d.reason || 'cap_reached',",
   'C1'],
  // THE SCOPE SILENTLY BECOMES A DAY — the server means one thing, the client
  // renders another.
  ['the_scope_becomes_a_day', SRC,
   "const SCOPE = 'video';",
   "const SCOPE = 'day';",
   'C3'],
  // A FIELD THE CLIENT EXPECTS GOES MISSING — a blank in its copy.
  ['a_field_goes_missing', SRC,
   "    used: Number.isInteger(d.used) ? d.used : 0,",
   "",
   'C1'],
  // THE TABLE DRIFTS. This edits the JSON the server reads, which is the seam
  // the worker-side L9 leg exists to hold from the other end.
  ['the_table_price_drifts', TBL,
   '"credits": 5', '"credits": 3',
   'C4'],
];

const run = () => { try { const o = cp.execFileSync(process.execPath, [SMOKE], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }); return { code: 0, out: o }; } catch (e) { return { code: e.status, out: (e.stdout||'') + (e.stderr||'') }; } };

const base = run();
if (base.code !== 0) { console.error('HARNESS FAILURE: unmutated smoke is not green'); console.error(base.out.slice(-800)); process.exit(2); }
console.log('baseline green.\n');
let red = 0;
for (const [name, file, from, to, leg] of M) {
  const raw = fs.readFileSync(file, 'utf8');
  const n = raw.split(from).length - 1;
  if (n !== 1) { console.log(`  ${name.padEnd(38)} HARNESS FAILURE: anchor ${n}x`); continue; }
  fs.writeFileSync(file, raw.replace(from, to));
  const r = run();
  fs.writeFileSync(file, raw);
  // TWO NAMING CONVENTIONS IN ONE FILE. The pre-existing leg harness prints
  // "L2 some_name"; my assert messages read "C1: ...". Matching only on the
  // colon reported NOT RED for a mutation the suite had caught correctly —
  // the proof was wrong about the check, not the check about the code.
  const named = r.out.includes(leg + ':') || r.out.includes(leg + ' ');
  const ok = r.code !== 0 && named;
  if (ok) red++;
  console.log(`  ${name.padEnd(38)} ${ok ? 'RED ' : 'NOT RED'}  exit=${r.code} names_${leg}=${named}`);
  if (!ok) console.log('      | ' + r.out.trim().split('\n').slice(-3).join(' | ').slice(0, 280));
}
console.log(`\n${red}/${M.length} RED-proven`);
process.exit(red === M.length ? 0 : 1);

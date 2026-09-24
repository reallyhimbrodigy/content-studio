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
   "    balance: (bal == null || !Number.isFinite(Number(bal)))\n      ? null : Number(bal),",
   "    balance: Number.isFinite(Number(bal)) ? Number(bal) : null,",
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
  // ── PRECEDENCE ────────────────────────────────────────────────────────
  // THE PRECEDENCE INVERTS: someone who cannot pay is told "Use 5 credits".
  ['cannot_pay_is_told_cap_reached', SRC,
   "  const short = bal !== null && Number.isFinite(p.price) && bal < p.price;",
   "  const short = false;",
   // P2, not P3: the reachability leg asserts insufficient_credits can be
   // produced at all, and it reads before the precedence band does.
   'P2'],
  // AN UNREAD BALANCE IS TREATED AS ZERO — a user with plenty is sent to a
  // top-up they do not need, on a number we never read.
  ['an_unread_balance_counts_as_short', SRC,
   "  const bal = (balance == null || !Number.isFinite(Number(balance)))\n    ? null : Number(balance);",
   "  const bal = Number(balance) || 0;",
   // L3, not P5: with an unread balance counted as 0, EVERY past-the-cap
   // decision becomes insufficient and stops allowing — the pre-existing
   // "past the cap still allows" leg is the first to see it.
   'L3'],
  // EXACTLY AT THE PRICE IS REFUSED — off by one, and it refuses a user who
  // can afford it.
  ['exactly_at_the_price_is_refused', SRC,
   "bal < p.price;",
   "bal <= p.price;",
   'P3'],
  // pro_required LOSES ITS PRECEDENCE: a free user is told their balance is
  // short instead of that they need Pro.
  ['free_is_told_about_a_balance', SRC,
   "  if (!PAID_TIERS.has(t)) {\n    return { allow: false, status: 402, error: 'payment_required',\n             reason: 'pro_required', actions: ['upgrade'] };\n  }",
   "  if (!PAID_TIERS.has(t) && used === 0) {\n    return { allow: false, status: 402, error: 'payment_required',\n             reason: 'pro_required', actions: ['upgrade'] };\n  }",
   'P4'],
  // A FOURTH REASON APPEARS without a client that can render it.
  ['a_fourth_reason_appears', SRC,
   "const REASONS = ['pro_required', 'cap_reached', 'insufficient_credits'];",
   "const REASONS = ['pro_required', 'cap_reached', 'insufficient_credits', 'try_later'];",
   'P1'],
  // THE BODY RE-DECIDES PRECEDENCE from its own argument, so the reason and
  // the fields it ships with can disagree.
  ['the_body_re_decides_precedence', SRC,
   "  const bal = d.balance != null ? d.balance : balance;",
   "  const bal = balance != null ? balance : d.balance;",
   'P6'],
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

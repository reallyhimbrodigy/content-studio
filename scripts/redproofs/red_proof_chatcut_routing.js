// RED proof for the ChatCut routing guard.
const fs = require('fs'), cp = require('child_process'), path = require('path');
const ROOT  = path.join(__dirname, '..', '..');
const SMOKE = path.join(ROOT, 'lib', '__smoke_chatcut_routing.js');
const SRC   = path.join(ROOT, 'lib', 'chatcut-routing.js');

const M = [
  // UNKNOWN treated as a fact about the account — an outage in B1's publisher
  // becomes "this account is inactive".
  ['unknown_folded_into_inactive', SRC,
   "    const reason = state === 'UNKNOWN' || state === 'STALE'\n      ? 'chatcut_unknown' : 'chatcut_inactive';",
   "    const reason = 'chatcut_inactive';",
   'L4'],
  // A denylist instead of an allowlist — a state nobody listed falls through
  // to the path that spends money.
  ['a_denylist_instead_of_an_allowlist', SRC,
   "  if (state !== 'OK') {",
   "  if (state === 'INACTIVE' || state === 'UNKNOWN' || state === 'STALE') {",
   // L3, not L5: SUSPENDED/CANCELLED are checked before the invented-state
   // names and fall through first. The proof names what FIRES.
   'L3'],
  // OK-with-no-balance routed as if funded — the confident zero, with money.
  ['an_unreadable_balance_is_assumed_fine', SRC,
   "  if (!Number.isFinite(balance)) {",
   "  if (false) {",
   'L4'],
  // The reserve becomes a floor you may land ON, draining the pool to exactly
  // the number it exists to protect.
  ['at_the_reserve_counts_as_above_it', SRC,
   "  if (balance <= res) {",
   "  if (balance < res) {",
   'L2'],
  // A fetch failure throws instead of routing — the guard fails the customer's
  // job to protect our credit balance.
  ['a_fetch_failure_throws', SRC,
   "  } catch (e) {\n    log.warn('[chatcut-route] account_status unavailable — routing to the existing '\n      + `pipeline: ${(e && e.message) || 'unknown'}`);\n    return { status: null, why: `error:${((e && e.message) || 'unknown').slice(0, 60)}` };\n  }",
   "  } catch (e) {\n    throw e;\n  }",
   'L7'],
  // A malformed body throws out of decideRoute.
  ['a_malformed_body_throws', SRC,
   "  if (!status || typeof status !== 'object') {\n    return out(ROUTE_EXISTING, 'chatcut_unknown');\n  }",
   "  if (false) {}",
   'L6'],
  // The reserve defaults to 0 — the pool drains to exactly nothing mid-job.
  ['the_reserve_defaults_to_zero', SRC,
   "const DEFAULT_RESERVE = 500;",
   "const DEFAULT_RESERVE = 0;",
   'L10'],
  // AND THE ONE THAT PASSES EVERY REFUSAL TEST: a guard that always says
  // UNKNOWN. Every fallback leg is satisfied; only L8 sees it.
  // THE SHAPE THAT PASSES EVERY REFUSAL TEST: a fetcher that always reports
  // UNKNOWN. Every fallback leg above is satisfied by it. Only L8 — which
  // insists a HEALTHY answer still comes back — can see it.
  ['the_fetcher_always_reports_unknown', SRC,
   "    const body = await r.json();\n    return { status: body, why: 'ok' };",
   "    await r.json();\n    return { status: null, why: 'ok' };",
   'L8'],
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
  const named = r.out.includes(leg + ':');
  const ok = r.code !== 0 && named;
  if (ok) red++;
  console.log(`  ${name.padEnd(38)} ${ok ? 'RED ' : 'NOT RED'}  exit=${r.code} names_${leg}=${named}`);
  if (!ok) console.log('      | ' + r.out.trim().split('\n').slice(-3).join(' | ').slice(0, 260));
}
console.log(`\n${red}/${M.length} RED-proven`);
process.exit(red === M.length ? 0 : 1);

// RED proof for the guard wiring. Each mutation restores the inert state the
// guard was actually in, or a plausible half-wiring.
const fs = require('fs'), cp = require('child_process'), path = require('path');
const ROOT  = path.join(__dirname, '..', '..');
const SMOKE = path.join(ROOT, 'lib', '__smoke_ops_fire_wiring.js');
const SA    = path.join(ROOT, 'services', 'supabase-admin.js');
const SRV   = path.join(ROOT, 'server.js');
const FIRES = path.join(ROOT, 'lib', 'ops-fire-log.js');
const GUARD = path.join(ROOT, 'lib', 'origin-latency-guard.js');

const M = [
  // THE STATE IT WAS ACTUALLY IN: nothing produces samples.
  ['nothing_produces_samples', SA,
   "    global: { fetch: _timedFetch },\n",
   "",
   'L1'],
  // A rejected fetch is dropped — the instrument goes quietest when the origin
  // is most broken.
  ['a_rejected_fetch_is_dropped', SA,
   "    (e) => { _guard.observe(Date.now() - t0, Date.now(), { status: 599 }); throw e; },",
   "    (e) => { throw e; },",
   'L2'],
  // THE OTHER HALF OF THE INERT STATE: nothing consumes pages.
  ['nothing_consumes_pages', SRV,
   "  _guard.configure({\n    sink: async (title, body, facts = {}) => {",
   "  const _unused_configure = ({\n    sink: async (title, body, facts = {}) => {",
   'L3'],
  // An UNDELIVERED fire is discarded — "nobody got it" becomes "nothing fired",
  // which is the whole reason I wrongly held this back.
  ['undelivered_fires_are_discarded', FIRES,
   "  _ring.unshift(row);",
   "  if (row.delivery === 'DELIVERED') _ring.unshift(row);",
   'L4'],
  // The machine-readable miss is flattened to a boolean.
  ['the_reason_is_flattened', FIRES,
   "    reason: String(rec.reason || ''),",
   "    reason: '',",
   'L4'],
  // UNKNOWN folded into UNDELIVERED.
  ['unknown_folded_into_undelivered', FIRES,
   "    delivery: String(rec.delivery || 'NOT_ATTEMPTED'),",
   "    delivery: String(rec.delivery) === 'DELIVERED' ? 'DELIVERED' : 'UNDELIVERED',",
   'L5'],
  // The ring grows without limit — a leak in the process the guard exists to
  // keep alive.
  ['the_ring_is_unbounded', FIRES,
   "  while (_ring.length > RING_MAX) _ring.pop();",
   "  // unbounded",
   'L6'],
  // A DB outage breaks the fire — during an incident where the DB IS the outage.
  ['a_db_outage_breaks_the_fire', FIRES,
   "  } catch (e) {\n    if (!_tableMissingLogged) {\n      _tableMissingLogged = true;\n      log.error('[ops-fire] ops_alert_fires insert threw:', e && e.message);\n    }\n  }",
   "  } catch (e) {\n    throw e;\n  }",
   'L7'],
  // The sink loses the facts and has to re-derive them from a bucket that has
  // already rolled.
  ['the_page_loses_its_facts', GUARD,
   "  Promise.resolve(_sink(title, body, { why, p95, n, at: now })).catch((e) =>",
   "  Promise.resolve(_sink(title, body)).catch((e) =>",
   'L8'],
  // The bare /healthz probe starts doing work on every Render health check.
  ['healthz_probe_stops_being_constant_time', SRV,
   "    if (parsed.query && parsed.query.ops_fires) {",
   "    if (true) {",
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
  if (n !== 1) { console.log(`  ${name.padEnd(42)} HARNESS FAILURE: anchor ${n}x in ${path.basename(file)}`); continue; }
  fs.writeFileSync(file, raw.replace(from, to));
  const r = run();
  fs.writeFileSync(file, raw);
  const named = r.out.includes(leg + ':');
  const ok = r.code !== 0 && named;
  if (ok) red++;
  console.log(`  ${name.padEnd(42)} ${ok ? 'RED ' : 'NOT RED'}  exit=${r.code} names_${leg}=${named}`);
  if (!ok) console.log('      | ' + r.out.trim().split('\n').slice(-4).join(' | ').slice(0, 300));
}
console.log(`\n${red}/${M.length} RED-proven`);
process.exit(red === M.length ? 0 : 1);

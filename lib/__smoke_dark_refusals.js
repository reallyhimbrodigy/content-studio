'use strict';
// SMOKE — a DARK path must leave a trace, and the defect must not hide inside
// the expected case.
//
// THE DEFECT THIS LOCKS DOWN (2026-09-05). CREDITS_DEBIT_ENABLED=1 with
// FREE_CREDITS_MIN_BUILD unset makes debitApplies() return false for EVERY
// user, so the credits debit was completely inert while /healthz reported
// `debit_armed: true`. Zero rows in free_credit_periods across all time, zero
// debits across 6 post-deploy jobs. Nothing on the path logged anything, so
// establishing it required eliminating five separate conjuncts by hand.
//
// The rule earned: a path that ships dark and refuses must SAY SO.
const fs = require('fs');
const path = require('path');
const dr = require('./dark-refusals');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const fail = [];
const ok = (c, m) => { if (!c) fail.push(m); };

// ── the observer behaves ───────────────────────────────────────────────────
dr._resetForTests();
dr.observeDarkRefusal('a', 'x');
dr.observeDarkRefusal('a', 'x');
dr.observeDarkRefusal('b', 'y');
let st = dr.darkRefusalStats();
ok(st.reasons.a.n === 2 && st.reasons.b.n === 1, 'counts do not accumulate per reason');
ok(typeof st.window_s === 'number' && typeof st.since === 'string',
   'stats carry no window — an in-memory counter without one is unreadable, '
   + 'the exact mistake localeStats already fixed');
ok(typeof st.reasons.a.window_s === 'number', 'per-reason window missing');

// ── THE LOAD-BEARING ONE: the defect and the expected case must not collapse ─
dr._resetForTests();
dr.observeDarkRefusal('debit_INERT:min_build_unset', 'unset');
dr.observeDarkRefusal('debit_skipped:build_below_floor', 'build=230 floor=243');
st = dr.darkRefusalStats();
ok(Object.keys(st.reasons).length === 2,
   'the config DEFECT (unset floor) and the EXPECTED skip (old build) share a '
   + 'bucket — the defect would be buried in normal traffic, which is exactly '
   + 'how it hid for a full day');

// ── the sites are actually wired, not merely available ─────────────────────
ok(/const _darkRefusals = require\('\.\/lib\/dark-refusals'\)/.test(SRC),
   'dark-refusals is not required by server.js');
ok(/debit_INERT:min_build_unset/.test(SRC),
   'the DEBIT site does not report an unset floor — this is the site that '
   + 'silently disabled credits for everyone; the grant endpoint is secondary');
ok(/free_credits:min_build_unset/.test(SRC),
   'the free-grant endpoint refusal is unobserved');
ok(/reverse_trial:min_build_unset/.test(SRC),
   'the reverse-trial endpoint refusal is unobserved');
// The debit observation must be INSIDE a CREDITS_DEBIT_ENABLED guard: logging a
// skip when the whole feature is off is noise, not signal.
ok(/if \(CREDITS_DEBIT_ENABLED && !_debitApplies\) \{/.test(SRC),
   'the debit-skip observation is not gated on CREDITS_DEBIT_ENABLED — it would '
   + 'fire on every request while the feature is deliberately off');

// ── first occurrence logs immediately ──────────────────────────────────────
ok(dr.LOG_INTERVAL_MS >= 60000,
   'log throttle is under a minute — a request-path counter would spam');

if (fail.length) {
  console.error('dark refusals smoke: FAIL');
  for (const f of fail) console.error(`   ✗ ${f}`);
  process.exit(1);
}
console.log('dark refusals smoke: PASS (counts per reason, carries a window, '
  + 'defect never shares a bucket with the expected skip, all three sites wired, '
  + 'debit observation gated, throttled)');

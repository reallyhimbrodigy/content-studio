'use strict';

// ── A MOCK THAT DISCARDS ITS FILTERS SCORES THE BUG AS CORRECT ──────────────
//
// 2026-09-10. `lib/__smoke_chat_attach.js` carried a containment filter that
// had never once filtered: the real client serializes the operand as a JSON
// string, and the mock read `st.contains[0].jobId` — a property of a CHARACTER
// of that string — so `want` was always undefined and every read matched on
// user_id alone. A chat that had lost its render was handed back as one that
// held it. That is the exact production shape the module exists to fix: the
// mock reproduced the defect and called it correct, which is why the unit suite
// structurally could not catch the four renders counted as recovered.
//
// A sweep of the other 72 smokes found the same class in EIGHT more files —
// NINE in total with chat_attach — every one confirmed by mutation against the
// real code, and every one now FIXED (27 mutations flipped from green to red).
//
// This header said "four more" while the sweep was still in progress and was not
// updated when the second half landed. A reader took the stale number together
// with the five KNOWN entries below and concluded that five files were exempted
// rather than fixed. They are not: all nine are fixed on the path that was
// exploitable, and a KNOWN entry means only that some OTHER chain in that file
// still has a no-op filter, with the entry saying which and why. A count left
// behind by its own work is the same failure this gate exists to catch, so:
//
//   FIXED, mutation-proven — chat_attach, source_presence, lumen_access,
//   result_passthrough, completion_delivery, install_seen, bleed_meter,
//   terminal_invariant, completion_repair.
//   ALREADY SOUND — completion_reconcile (enforces its CAS guard BY VALUE; the
//   pattern to copy), dead_upload_fastfail (filters in JS).
//
// The four that opened the sweep, as originally written:
//
//   __smoke_source_presence     dropping .eq('user_id') / .eq('video_url') /
//                               .eq('status','failed') from findDeadSourceJob
//                               all stayed GREEN — one user's dead upload could
//                               block a DIFFERENT user's render.
//   __smoke_lumen_access        hardcoding readMonthlyUsage's month key to
//                               'lumen_render_2020_01' stayed GREEN — every user
//                               reads 0 used, forever, i.e. unlimited premium.
//   __smoke_result_passthrough  pointing the recovery read at another job's row
//                               stayed GREEN.
//   __smoke_completion_delivery pointing the durable poller at another job's row
//                               stayed GREEN — a job settled from another job's
//                               outcome.
//
// THE SHARED SHAPE, and what this gate refuses: a chainable query method
// defined to take NO ARGUMENTS. `eq: () => b` cannot filter; it can only
// pretend to. A stub that answers a question it was not asked tests nothing
// about the question.
//
// Row-count and projection methods are exempt — `select`, `order`, `limit`,
// `range`, `single`, `maybeSingle` do not choose rows BY VALUE, so discarding
// their arguments cannot hand back a row the query did not ask for.

const fs = require('fs');
const path = require('path');

// Methods that select rows by value. These are the ones that must not be no-ops.
const VALUE_FILTERS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'not',
  'contains', 'containedBy', 'match', 'or', 'and', 'filter', 'overlaps',
  'textSearch', 'rangeGt', 'rangeLt', 'rangeGte', 'rangeLte',
]);

// `foo: () =>` and `foo() {` with an empty parameter list.
const ZERO_ARG = /\b(\w+)\s*:\s*\(\s*\)\s*=>|\b(\w+)\s*\(\s*\)\s*\{/g;

/** Remove /* *\/ blocks, // line comments and string/template literals — a
 *  filter name inside any of them is prose or data, not a definition. */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; continue; }
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e === -1 ? n : e; continue; }
    if (c === '"' || c === "'" || c === '`') {
      i += 1;
      while (i < n && src[i] !== c) { i += (src[i] === '\\' ? 2 : 1); }
      i += 1; out += ' '; continue;
    }
    out += c; i += 1;
  }
  return out;
}

// ── KNOWN, RECORDED DEBT ────────────────────────────────────────────────────
//
// These carried the defect before the gate existed. Each entry states what was
// checked. A file NOT listed here fails the gate — that is the point: the class
// cannot silently spread. An entry that no longer offends ALSO fails, so a fix
// cannot leave a stale exemption behind, which is how allowlists rot.
//
// The five that were mutation-verified and FIXED are deliberately absent:
// __smoke_chat_attach (containment operand now parsed), __smoke_source_presence,
// __smoke_lumen_access, __smoke_result_passthrough, __smoke_completion_delivery.
// Where they still appear below it is for a DIFFERENT method on a different
// chain than the one that was exploitable.
const KNOWN = {
  '__smoke_chat_attach.js':
    'not/gte/eq on the RECENT-RENDERS read only. The containment filter — the one '
    + 'that was inert and cost four users their video — now parses its JSON operand '
    + 'and is enforced; see case 8 and the mutation notes there.',
  '__smoke_completion_delivery.js':
    'in/is/not/or on the write chain. The exploitable one was maybeSingle handing '
    + 'back any row: FIXED (rowFor), mutation-verified.',
  '__smoke_completion_reconcile.js':
    'gte only (a lookback window). This mock records eq filters and enforces its '
    + 'is(null) CAS guard BY VALUE — deleting that guard is caught. The reference '
    + 'implementation for the others.',
  '__smoke_dead_upload_fastfail.js':
    'SAFE, verified: clientReportedUploadFailure filters in JS (data.find on '
    + 'props.job_id), so a no-op eq cannot hide a wrong match — its job-OTHER '
    + 'negative control is genuine and passes for a real reason.',
  '__smoke_orphaned_dispatch.js':
    'eq/not on the pre-READ chain. The GUARD that matters is now evaluated from '
    + 'the arguments the caller passes, and three mutations are caught: narrowing '
    + 'the terminal list, dropping members of it, deleting the guard.',
};

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter((f) => /^__smoke_.*\.js$/.test(f) && f !== path.basename(__filename));

const offenders = [];
for (const f of files) {
  // STRIP COMMENTS FIRST. The house rule exists because a gate that greps raw
  // source flags the very sentence explaining the defect it is guarding against
  // — this gate flagged its own explanatory comments on the first run.
  const src = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'));
  // Only files that actually build a query chain can have this defect.
  if (!/\bfrom\s*[(:]/.test(src)) continue;
  const found = new Set();
  let m;
  ZERO_ARG.lastIndex = 0;
  while ((m = ZERO_ARG.exec(src)) !== null) {
    const name = m[1] || m[2];
    if (VALUE_FILTERS.has(name)) found.add(name);
  }
  if (found.size) offenders.push({ file: f, methods: [...found].sort() });
}

const unlisted = offenders.filter((o) => !KNOWN[o.file]);
const offending = new Set(offenders.map((o) => o.file));
const stale = Object.keys(KNOWN).filter((f) => !offending.has(f));

if (unlisted.length || stale.length) {
  console.error('[smoke] mock-filters gate: FAILED\n');
  for (const o of unlisted) {
    console.error(`  NEW  ${o.file}`);
    console.error(`       argument-discarding row filters: ${o.methods.join(', ')}`);
  }
  for (const f of stale) {
    console.error(`  STALE  ${f} is exempted but no longer offends — delete its KNOWN entry.`);
  }
  console.error('\n  A chainable filter defined as `() => b` throws away what it was asked to');
  console.error('  filter on, so the mock returns rows the real query never would. Record the');
  console.error('  arguments and apply them, the way Postgres would — see the mock in');
  console.error('  __smoke_completion_reconcile.js, which enforces its CAS guard BY VALUE.');
  console.error('  If a filter genuinely cannot affect this test, say so in a comment and');
  console.error('  still record it; do not define it as a no-op.');
  process.exit(1);
}

const unverified = Object.entries(KNOWN)
  .filter(([, why]) => why.startsWith('UNVERIFIED')).map(([f]) => f);
const exploitable = Object.entries(KNOWN)
  .filter(([, why]) => why.startsWith('VERIFIED EXPLOITABLE') || why.startsWith('VERIFIED, PARTIAL'))
  .map(([f]) => f);

console.log(`[smoke] mock-filters gate: OK — ${files.length} smoke file(s) scanned; `
  + `${offenders.length} carry recorded debt, no new ones.`);
if (unverified.length) {
  console.log(`  still to mutation-test (${unverified.length}): ${unverified.join(', ')}`);
}
// A mock PROVEN to accept a wrong-row mutation is worse than an unknown one, and
// must not go quiet just because it has been catalogued. Recording a defect is
// not fixing it.
if (exploitable.length) {
  console.log(`\n  ⚠ ${exploitable.length} mock(s) mutation-PROVEN to pass a wrong-row `
    + 'or wrong-window query. These are open defects, not exemptions:');
  for (const f of exploitable) console.log(`      ${f}  — ${KNOWN[f].split('.')[0]}.`);
}

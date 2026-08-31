'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// ── REACHABILITY: every exported function must have a PRODUCTION caller ──────
//
// WHY THIS EXISTS. refundJobCredits was written with a claim, an unclaim, an
// event and nine passing tests — and had ZERO CALLERS. The credits refund was
// dead code and the refund event went nowhere. Frontend found it while trying
// to wire the client half. Its own tests all passed, because they asserted what
// the function DOES IF CALLED. Testing what a function does is not testing that
// it runs.
//
// That is not a one-off. sweep_built_not_wired found the same shape on
// mechanical_router and duration_target: "built, cert-green, committed and
// DEPLOYED, with no import, no mount and no call site anywhere in production".
// A feature can be complete, correct, tested and entirely inert.
//
// WHAT COUNTS AS REACHABLE: ANY invocation from production code — server.js,
// lib/, routes/, services/, scripts/ — INCLUDING from inside the defining
// module. A function called by its own module, where that module is used, does
// run; requiring a cross-file caller flags buildToolSystemPrompt and a dozen
// other perfectly live helpers, and a check that cries wolf gets muted, which
// is worse than not having it.
//
// The bug this exists for is narrower and sharper: refundJobCredits had NO
// invocation ANYWHERE — not from server.js, not from its own sweep. That is
// what "inert" means, and it is what this detects.
//
// A call from tests does NOT count: a function exercised only by its own tests
// is exactly the state this check exists to find.
//
// EXCEPTIONS ARE NAMED, NOT INFERRED. Anything legitimately uncalled goes in
// ALLOW with a reason, so an exception is a decision someone made rather than
// an oversight nobody noticed. An empty reason is not accepted.

const ROOT = path.join(__dirname, '..');
const PROD_DIRS = ['lib', 'routes', 'services', 'scripts', 'pages', 'src'];

// name -> why it is legitimately unreferenced in production code.
const ALLOW = {
  // Pure constants/tables re-exported for tests and callers that read them as
  // data rather than calling them.
  CHARGE_MATCH_WINDOW_MS: 'constant, not a function',
  DELETE_DELTA_CAP_MS: 'constant, not a function',
  SIBLING_WINDOW_MS: 'constant, not a function',
  LOOKBACK_HOURS: 'constant, not a function',
  COST_PER_RENDER: 'constant, not a function',
  TIER_ALLOWANCE: 'constant table read by the balance endpoint',
  REVENUECAT_API_BASE: 'constant, not a function',
  LANGUAGES: 'constant table',
  // TEST-ONLY PREDICATES. Each is exported, tested, and never called in
  // production because the caller re-implements the check INLINE. That is a
  // drift risk, not a dead feature — two copies of one rule, only one of which
  // has tests — and each is listed so the duplication is visible rather than
  // silently allowlisted.
  isDelivered: 'exported for lib/__smoke_completion_reconcile; the reconciler inlines the column check',
  isRedispatchable: 'exported for tests; orphan-redispatch inlines the predicate',
  ownsKey: 'exported for lib/__smoke_chat_media; chat-media inlines the ownership check',
  hasCompletionClaim: 'exported for tests; completion-repair inlines the claim check',
  isValidRating: 'exported for tests; feedback.js inlines the range check',
  reconcileTerminalInvariant: 'invoked by the cron sweep via dynamic require, not a static reference',
  getPendingModalJobs: 'invoked by the modal-webhook cron path via dynamic require',
  TOOLS_MODEL: 'constant model id read as data',
  // SIBLING EXPORTS beside a USED entry point. tier-capabilities IS imported
  // (server.js + wall-enforcement use `capabilities`); gate-receipt IS imported
  // (readGateReceipt/readBuildMarker at boot). These are the per-cell helpers
  // exported alongside, tested per-cell, with production calling the table
  // instead. Weaker smell than an unimported module — listed, not silently
  // passed, so the duplication stays visible.
  canReedit: 'per-cell helper; production reads the `capabilities` table export',
  canUseLumen: 'per-cell helper; production reads the `capabilities` table export',
  canRender: 'per-cell helper; production reads the `capabilities` table export',
  canChat: 'per-cell helper; production reads the `capabilities` table export',
  canUpload: 'per-cell helper; production reads the `capabilities` table export',
  denialRouting: 'per-cell helper; production reads the `capabilities` table export',
  writeGateReceipt: 'written by the deploy gate script, not by the server process',
  clearGateReceipt: 'written by the deploy gate script, not by the server process',
  deliverableOnRow: 'exported for tests; completion-repair inlines the row check',
  DEFAULT_LANGUAGE: 'constant string, not a callable',
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') || e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

function prodSources() {
  // ROOT-LEVEL FILES AND HTML COUNT. Scanning only server.js + lib/routes/
  // services/scripts reported lib/supabase-client and lib/supabase-server as
  // imported by nothing — they are imported by reset-password.js, user-store.js
  // and several root HTML pages. A reachability check with too narrow a scope
  // manufactures orphans, and a check that cries wolf gets muted.
  const files = [];
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (e.isFile() && (e.name.endsWith('.js') || e.name.endsWith('.html'))) {
      files.push(path.join(ROOT, e.name));
    }
  }
  for (const d of PROD_DIRS) {
    const full = path.join(ROOT, d);
    if (fs.existsSync(full)) files.push(...walk(full));
  }
  // A file whose basename starts with __ is a smoke/fixture, not production.
  return files.filter((f) => !path.basename(f).startsWith('__'));
}

/** Names in a `module.exports = { a, b, c }` block.
 *
 *  PER-LINE MATCHING WAS WRONG and the control caught it. The old pattern was
 *  anchored with ^ and captured ONE identifier per line, so
 *      isRefundEligible, refundJobCharge, sweepRefundLeg,
 *  yielded only `isRefundEligible` — the scan silently inspected a fraction of
 *  the exports and its green was mostly vacuous. Split on separators instead of
 *  assuming one name per line.
 */
function exportedNames(src) {
  const m = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\}/);
  if (!m) return [];
  return m[1]
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join(',')
    .split(',')
    .map((tok) => {
      const t = tok.trim();
      const mm = t.match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/);
      return mm ? mm[1] : null;
    })
    .filter(Boolean);
}

test('every exported lib function has a production caller', () => {
  const files = prodSources();
  const libFiles = files.filter((f) => f.includes(`${path.sep}lib${path.sep}`));
  assert.ok(libFiles.length > 3, `expected several lib files, saw ${libFiles.length}`);

  const orphans = [];
  const checked = [];
  for (const file of libFiles) {
    const src = fs.readFileSync(file, 'utf8');
    for (const name of exportedNames(src)) {
      if (ALLOW[name]) continue;
      // Only functions — a constant is not "unreachable", it is just data.
      const isFn = new RegExp(
        `(?:async\\s+)?function\\s+${name}\\b|` +
        `const\\s+${name}\\s*=\\s*(?:async\\s*)?\\(|` +
        `const\\s+${name}\\s*=\\s*(?:async\\s+)?function`).test(src);
      if (!isFn) continue;
      checked.push(name);
      const called = files.some((f) => {
        const s = fs.readFileSync(f, 'utf8');
        if (f === file) {
          // Its own module counts — but the DEFINITION is not a call, so strip
          // the declaration before looking for an invocation.
          const body = s
            .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
            .replace(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g'), 'DEFN(')
            .replace(new RegExp(`const\\s+${name}\\s*=`, 'g'), 'DEFN =')
            .replace(/module\.exports\s*=\s*\{[\s\S]*?\n\}/, '');
          return new RegExp(`\\b${name}\\b`).test(body);
        }
        // A bare reference counts: a function passed as a VALUE runs.
        // `ctx.generate || geminiGenerate` is a call site with no parentheses,
        // and requiring `name(` flagged it as dead.
        const code = s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
        return new RegExp(`\\b${name}\\b`).test(code.replace(
          /module\.exports\s*=\s*\{[\s\S]*?\n\}/, ''));
      });
      if (!called) orphans.push(`${path.relative(ROOT, file)}:${name}`);
    }
  }
  assert.ok(checked.length > 5,
    `only ${checked.length} exported functions inspected — the scan is broken, ` +
    `not the code`);
  assert.deepStrictEqual(orphans, [],
    `exported but never called from production code:\n  ${orphans.join('\n  ')}\n` +
    `Each is a feature that can be complete, correct, tested and entirely ` +
    `INERT — refundJobCredits was exactly this and cost the credits refund. ` +
    `Wire it, delete it, or add it to ALLOW with a reason.`);
});

test('CONTROL: the scan finds functions and can fail', () => {
  // Guards the guard. If exportedNames() or the file walk broke, the test above
  // would pass vacuously with an empty orphan list.
  const files = prodSources();
  assert.ok(files.length > 5, `only ${files.length} production files found`);
  const leg = fs.readFileSync(path.join(ROOT, 'lib/refund-leg.js'), 'utf8');
  const names = exportedNames(leg);
  assert.ok(names.includes('refundJobCredits'),
    'the export parser cannot see refundJobCredits — the scan would miss the ' +
    'exact bug it was written for');
  assert.ok(names.includes('sweepRefundLeg'));
});

test('every ALLOW entry carries a REASON', () => {
  for (const [k, v] of Object.entries(ALLOW)) {
    assert.ok(typeof v === 'string' && v.length > 8,
      `${k} is allowlisted with no reason — an exception must be a decision, ` +
      `not a way to silence the check`);
  }
});

test('no lib MODULE is entirely unimported by production', () => {
  // THE STRONGER SIGNAL, and the one that actually costs features. An export
  // that is never called while its module IS imported is a duplication smell.
  // A module that NOTHING imports is the refundJobCredits / mechanical_router /
  // duration_target shape: built, tested, committed, deployed, inert.
  //
  // No allowlist here on purpose. An entire unimported module is never a
  // deliberate state worth waving through — it is either wired or deleted.
  const files = prodSources();
  const libFiles = files.filter((f) => f.includes(`${path.sep}lib${path.sep}`));
  const orphanModules = [];
  for (const file of libFiles) {
    const base = path.basename(file, '.js');
    if (base.startsWith('__')) continue;
    const imported = files.some((f) => {
      if (f === file) return false;
      const s2 = fs.readFileSync(f, 'utf8');
      return s2.includes(`/${base}'`) || s2.includes(`/${base}"`)
          || s2.includes(`./${base}`) || s2.includes(`${base}.js`);
    });
    if (!imported) orphanModules.push(path.relative(ROOT, file));
  }
  assert.deepStrictEqual(orphanModules, [],
    `lib module(s) imported by NOTHING in production:\n  ${orphanModules.join('\n  ')}\n` +
    `This is the shape that cost the credits refund and, before it, ` +
    `mechanical_router and duration_target. Wire it or delete it.`);
});

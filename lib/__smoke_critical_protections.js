'use strict';

// Regression fence for content-studio's FAIL-CLOSED protections.
//
// A divergent-branch re-merge — or worse, resetting main to a branch tip — can
// silently DROP the worker-auth boot gate, the spend guard, or the surge HALT
// threshold. None of these show up in behavior until it's too late: an unauth
// worker callback lands, or an attacker/bug runs the bill up, or a revert to the
// pre-surge HALT=800 halts dispatch mid-surge. This smoke makes any such drop fail
// the deploy gate LOUDLY instead of shipping silently. (Auto-run by validate_deploy.)
//
// Run: node lib/__smoke_critical_protections.js   (exit 0 = pass, 1 = fail)

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ── 1. Spend guard: exported, thresholds sane, surge HALT floor held ────────────
const sg = require('./spend-guard');
assert.strictEqual(typeof sg.checkSpendGuards, 'function', 'spend-guard must export checkSpendGuards');
assert.ok(Number.isFinite(sg.GLOBAL_ALERT) && sg.GLOBAL_ALERT > 0, 'GLOBAL_ALERT must be a positive number');
assert.ok(Number.isFinite(sg.GLOBAL_HALT) && sg.GLOBAL_HALT > 0, 'GLOBAL_HALT must be a positive number');
assert.ok(sg.GLOBAL_ALERT < sg.GLOBAL_HALT, 'ALERT must sit below HALT (page before dispatch stops)');
assert.ok(sg.PER_ACCOUNT_DAILY_CAP > 0, 'per-account daily render cap must be positive');
// Surge floor — catches a silent revert to the pre-surge HALT=800, which would
// self-inflict an outage mid-surge (~850-900 jobs/day > 800). If HALT is
// DELIBERATELY lowered below this after the surge, update this line on purpose.
assert.ok(
  sg.GLOBAL_HALT >= 1500,
  `GLOBAL_HALT default (${sg.GLOBAL_HALT}) fell below the surge floor 1500 — a silent revert to 800 would halt dispatch mid-surge`
);

// ── 2. server.js source: boot gate + spend guard still wired ────────────────────
// (server.js can't be require()d here — it binds a port on load — so assert on source.)
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.ok(
  /refusing to start \(fail-closed worker auth\)/.test(server),
  'the fail-closed BOOT GATE (refuse to start on a missing worker secret) was dropped from server.js'
);
assert.ok(
  /MODAL_CALLBACK_SECRET/.test(server) && /MODAL_RUN_SECRET/.test(server),
  'worker callback/run secret references missing from server.js — callback auth may have been dropped'
);
assert.ok(
  /require\(['"]\.\/lib\/spend-guard['"]\)/.test(server),
  'server.js no longer requires ./lib/spend-guard — the spend guard was unwired'
);
assert.ok(
  /checkSpendGuards\(/.test(server),
  'server.js no longer CALLS checkSpendGuards before dispatch — the spend guard is inert'
);

console.log(
  `✅ critical-protections smoke: boot gate present, spend guard wired + called, ` +
  `ALERT ${sg.GLOBAL_ALERT} < HALT ${sg.GLOBAL_HALT} (>= 1500 surge floor).`
);

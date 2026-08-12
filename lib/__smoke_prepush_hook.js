'use strict';
// Gate for the pre-push quiet-window hook (2026-08-12).
//
// FORGED FROM MY OWN SLIP. content-studio autoDeploys `main`, so a push to main
// IS a deploy. Every deliberate deploy runs preflight_quiet_window.py first —
// and then a docs-only commit went straight to main without it. It happened to
// land on a quiet window. That was LUCK. The doctrine here is that directives
// become machinery, not memory, and this is that doctrine applied to the one
// place it had not been.
//
// A hook is uniquely easy to lose: it is a file nobody imports, nobody tests,
// and git will not run it unless core.hooksPath points at it. So this asserts
// the three separable things that can each independently silently disable it:
//   1. the hook EXISTS and is EXECUTABLE (a non-executable hook is skipped
//      silently by git — no error, no warning, no gate)
//   2. its LOGIC is intact: main-only, mirrors the preflight's exit codes,
//      blocks on unmeasurable, and has exactly one named override
//   3. its INSTALLATION is automatic (postinstall), because a tracked hook
//      nobody installs is a README line, not machinery

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, '.githooks', 'pre-push');

// ── 1. exists + executable
assert.ok(fs.existsSync(HOOK), '.githooks/pre-push is gone — pushes to main are ungated again');
const mode = fs.statSync(HOOK).mode;
assert.ok(mode & 0o111,
  '.githooks/pre-push is NOT executable — git SKIPS a non-executable hook silently, '
  + 'so this fails open with no error and no warning. chmod +x it.');

const h = fs.readFileSync(HOOK, 'utf8');

// ── 2. logic
assert.ok(/refs\/heads\/main/.test(h), 'the hook must gate refs/heads/main');
assert.ok(/PROMPTLY_ALLOW_BUSY_PUSH/.test(h),
  'the emergency override must exist and be named — a gate with no override gets deleted');
assert.ok(/preflight_quiet_window\.py/.test(h),
  'the hook must run preflight_quiet_window.py — it is the ONLY authority on the window');
// unmeasurable must BLOCK. An unknown is not a quiet window; that conflation is
// the confident-zero class this codebase keeps paying for.
//
// Scoped to the BRANCH, not the file: a bare /exit 1/ over the whole hook also
// matches the BUSY block at the bottom, so it passed even with this branch
// changed to `exit 0`. That is the short-token-matches-prose class the worker
// gate has its own meta-check for, reproduced here in miniature — the known-bad
// caught it, which is the only reason it is not still wrong.
const absentBlock = (h.match(/if \[ -z "\$PREFLIGHT" \]; then[\s\S]*?\nfi/) || [''])[0];
assert.ok(absentBlock, 'the missing-preflight branch is gone entirely');
assert.ok(/exit 1/.test(absentBlock),
  'a missing preflight must BLOCK (exit 1) — an unmeasurable window is not a quiet one, '
  + 'and falling through here silently restores exactly the gap this hook exists to close');
// deletions deploy nothing and must not be gated
assert.ok(/\*\[!0\]\*|delete/i.test(h), 'branch deletion must not be gated (it deploys nothing)');
// the override must be checked BEFORE the preflight lookup, or an absent
// preflight would block even an intentional emergency push
assert.ok(h.indexOf('PROMPTLY_ALLOW_BUSY_PUSH') < h.indexOf('PREFLIGHT='),
  'the override must be evaluated BEFORE the preflight lookup, or it cannot rescue '
  + 'the very case (no preflight on this box) that most needs rescuing');

// ── 3. installation is automatic
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const post = String((pkg.scripts || {}).postinstall || '');
assert.ok(/install-hooks/.test(post),
  'package.json postinstall must run scripts/install-hooks.js — a tracked hook nobody '
  + 'installs is a README line, not machinery');
const inst = path.join(ROOT, 'scripts', 'install-hooks.js');
assert.ok(fs.existsSync(inst), 'scripts/install-hooks.js is gone');
const i = fs.readFileSync(inst, 'utf8');
assert.ok(/core\.hooksPath/.test(i) && /\.githooks/.test(i),
  'the installer must set core.hooksPath to .githooks');
assert.ok(/process\.env\.RENDER/.test(i),
  'the installer must skip on Render — build boxes never push');
assert.ok(/process\.exit\(0\)/.test(i),
  'the installer must never fail an npm install');

console.log('[smoke] pre-push hook: ALL PASS (exists + executable, main-only, preflight is the '
  + 'authority, unmeasurable blocks, override named and evaluated first, deletion ungated, '
  + 'installation automatic via postinstall)');
process.exit(0);

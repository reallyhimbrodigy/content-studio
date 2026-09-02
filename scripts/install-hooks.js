#!/usr/bin/env node
'use strict';
// Point git at the TRACKED hooks directory, automatically, on every local
// `npm install`.
//
// A hook that lives only in .git/hooks is not machinery — it is a note that
// survives on exactly one machine until someone re-clones. Tracking the hook in
// .githooks/ makes the CONTENT version-controlled and gate-asserted; this makes
// the INSTALLATION automatic, so nobody has to remember a setup step. Together
// that is the whole "directives become machinery, not memory" doctrine applied
// to the pre-push gate itself.
//
// core.hooksPath is written to the repo's local config, which is shared by every
// linked worktree of this repo, and `.githooks` resolves per-worktree — so all
// of content-studio, content-studio-main and .worktrees/* are covered by one set.
//
// Guards: skipped on Render (CI/build boxes never push), never overwrites an
// operator's deliberate custom hooksPath, and can NEVER fail an npm install.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function git(args) {
  return execFileSync('git', args, {
    cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'],
  }).toString().trim();
}

try {
  if (process.env.RENDER) process.exit(0);          // build box: nothing to push
  if (!fs.existsSync(path.join(__dirname, '..', '.githooks', 'pre-push'))) process.exit(0);

  try { git(['rev-parse', '--git-dir']); } catch (_) { process.exit(0); }  // not a repo

  let current = '';
  try { current = git(['config', '--local', '--get', 'core.hooksPath']); } catch (_) { current = ''; }

  if (current === '.githooks') process.exit(0);     // already correct, stay quiet
  if (current) {
    // Someone chose a different hooks dir on purpose. Say so; do not clobber.
    console.warn(`[hooks] core.hooksPath is '${current}', not '.githooks' — leaving it alone. `
      + 'The pre-push quiet-window gate will NOT run unless you point it here.');
    process.exit(0);
  }

  git(['config', '--local', 'core.hooksPath', '.githooks']);
  console.log('[hooks] core.hooksPath -> .githooks (pre-push quiet-window gate armed for main)');
} catch (e) {
  // Diagnostics only. An install must never fail because a hook could not be wired.
  console.warn('[hooks] could not set core.hooksPath (non-fatal):', e && e.message);
}
process.exit(0);

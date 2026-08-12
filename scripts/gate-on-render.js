#!/usr/bin/env node
'use strict';
// ARM THE SAFETY GATE ON RENDER, FROM A PLACE THAT ACTUALLY RUNS.
//
// [MEASURED 2026-08-11/12] render.yaml declares
//   buildCommand: npm install --omit=dev && node validate_deploy.js
// on a runtime:node service. Every deploy since came back with
//   /api/health -> {"gate": null, "build": {"at": ...}}
// The build marker is written by npm's postinstall and SURVIVES to runtime; the
// gate receipt, written moments later by validate_deploy.js in the same
// directory, never appears. npm install runs. `node validate_deploy.js` does
// not. The live service is not running the declared buildCommand — a Render
// blueprint that never synced — so the 27 safety smokes have been gating
// NOTHING there since the day they were wired.
//
// The fix that does not depend on a dashboard: npm's own postinstall lifecycle
// DOES run (the marker proves it), so the gate rides that instead. A non-zero
// exit here fails `npm install`, which fails the build, which keeps the previous
// version live — exactly what the buildCommand was supposed to do.
//
// GUARDED BY process.env.RENDER (Render sets it on every build and runtime
// instance) so a local `npm install` never pays for 27 smokes.
//
// Belt and braces on purpose: if the blueprint is ever synced, validate_deploy
// simply runs twice. Two green gates cost seconds; zero green gates cost the
// thing we just spent two days finding.

const path = require('path');
const { spawnSync } = require('child_process');

if (!process.env.RENDER) {
  process.exit(0); // local/CI install — the gate runs via `npm run validate`
}
if (process.env.SKIP_RENDER_GATE === '1') {
  // Deliberate, loud, and never the default. Present so a genuine emergency
  // deploy is possible without editing package.json under pressure.
  console.warn('[gate-on-render] SKIP_RENDER_GATE=1 — smokes NOT run for this build.');
  process.exit(0);
}

console.log('[gate-on-render] RENDER detected — running validate_deploy.js from postinstall');
const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'validate_deploy.js')], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
});
if (r.error) {
  // Could not even start node. Fail: an unverifiable build must not ship.
  console.error('[gate-on-render] could not run validate_deploy.js:', r.error.message);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);

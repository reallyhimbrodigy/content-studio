#!/usr/bin/env node
'use strict';

// Server-side pre-deploy gate (content-studio). Mirror of the worker's
// validate_deploy.py: runs every lib/__smoke_*.js smoke; any non-zero exit
// blocks the deploy. Cheap, standing insurance — a smoke added here runs on
// every future server-side deploy, so a regression in a vouched path is caught
// before it reaches Render, not after.
//
// Run: `npm run validate` (or `node validate_deploy.js`). Add a smoke by
// dropping a self-exiting `lib/__smoke_<name>.js` (exit 0 = pass, non-zero =
// fail); it is auto-discovered here.
//
// SKIP CONTRACT: a smoke that exits 0 having printed a line starting with
// `SKIP(` is recorded as SKIPPED, not passed. It is the honest verdict for
// "this container cannot verify this" (e.g. no ffmpeg binary on Render's Node
// runtime) — which must block the FLIP of the thing it guards, never the
// BUILD. Because this gate runs in render.yaml's buildCommand, a hard failure
// here blocks every future content-studio deploy, not just this one.
//
// RECEIPT: on a passing run we write .gate_receipt.json beside server.js, which
// server.js serves on /api/health as `gate`. That turns "did the Render
// buildCommand gate actually arm?" — previously an owner build-log eyeball
// after every deploy — into a permanent curl, and names any skipped smoke so a
// skip cannot read as a pass at flip time.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { writeGateReceipt, clearGateReceipt } = require('./lib/gate-receipt');

const libDir = path.join(__dirname, 'lib');
const smokes = fs
  .readdirSync(libDir)
  .filter((f) => /^__smoke_.*\.js$/.test(f))
  .sort();

if (smokes.length === 0) {
  console.error('❌ no lib/__smoke_*.js found — the gate must assert something.');
  process.exit(1);
}

// Clear first: a previous build's PASSING receipt must never survive beside a
// build that has not earned one (that is the shape in which `gate` would lie
// green — worse than reporting nothing).
clearGateReceipt(__dirname);

let failed = 0;
const skipped = [];
for (const f of smokes) {
  const p = path.join(libDir, f);
  process.stdout.write(`▶ ${f} ... `);
  try {
    const out = execFileSync(process.execPath, [p], { stdio: 'pipe', timeout: 60000 });
    const s = out.toString().trim();
    const isSkip = /^\s*SKIP\(/m.test(s);
    if (isSkip) skipped.push(f.replace(/^__smoke_|\.js$/g, ''));
    console.log(isSkip ? 'SKIP' : 'OK');
    if (s) console.log(s.split('\n').map((l) => '   ' + l).join('\n'));
  } catch (e) {
    failed++;
    console.log('FAIL');
    if (e.stdout) process.stdout.write(e.stdout.toString());
    if (e.stderr) process.stderr.write(e.stderr.toString());
  }
}

if (failed) {
  console.error(`\n❌ ${failed}/${smokes.length} smoke(s) failed. Deploy blocked.`);
  process.exit(1);
}
const passed = smokes.length - skipped.length;
const receipt = writeGateReceipt(__dirname, { passed, total: smokes.length, skipped });
if (skipped.length) {
  console.log(`\n⚠️  ${skipped.length} smoke(s) SKIPPED — NOT verified on this container: ${skipped.join(', ')}`);
  console.log('   A skip is not a pass. Do NOT flip the flag each one guards on this build.');
}
console.log(`\n✅ ${passed}/${smokes.length} smoke(s) passed`
  + `${skipped.length ? `, ${skipped.length} skipped` : ''}. Safe to deploy.`);
console.log(receipt ? `   receipt: ${path.basename(receipt)} → /api/health .gate`
  : '   ⚠️  receipt NOT written (gate verdict stands; /api/health .gate will read null)');

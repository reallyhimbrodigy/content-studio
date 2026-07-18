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

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, 'lib');
const smokes = fs
  .readdirSync(libDir)
  .filter((f) => /^__smoke_.*\.js$/.test(f))
  .sort();

if (smokes.length === 0) {
  console.error('❌ no lib/__smoke_*.js found — the gate must assert something.');
  process.exit(1);
}

let failed = 0;
for (const f of smokes) {
  const p = path.join(libDir, f);
  process.stdout.write(`▶ ${f} ... `);
  try {
    const out = execFileSync(process.execPath, [p], { stdio: 'pipe', timeout: 60000 });
    console.log('OK');
    const s = out.toString().trim();
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
console.log(`\n✅ ${smokes.length}/${smokes.length} smoke(s) passed. Safe to deploy.`);

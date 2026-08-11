'use strict';

// GATE (LANE-SEAM) — the six-demo acceptance script must stay loadable and
// structurally sound, so ignition day is RUNNING it, not repairing it.
// Auto-discovered by validate_deploy.js.

const assert = require('assert');
const path = require('path');

const { DEMOS } = require(path.join(__dirname, '..', 'scripts', 'seam-acceptance.js'));

assert.ok(Array.isArray(DEMOS) && DEMOS.length === 6,
  `expected exactly 6 demos, found ${DEMOS && DEMOS.length}`);

const names = DEMOS.map((d) => d.name);
for (const expected of ['chat-render', 'chat-reedit', 'caption-spelling',
                        'add-transition', 'caption-translate',
                        'upscale-negotiate']) {
  assert.ok(names.includes(expected), `demo missing: ${expected}`);
}

for (const d of DEMOS) {
  assert.ok(d.name && typeof d.name === 'string', 'demo without a name');
  assert.ok(d.flag && /PROMPTLY_/.test(d.flag),
    `${d.name}: every demo must name the flag that arms it`);
  assert.ok(typeof d.run === 'function', `${d.name}: run() missing`);
  assert.ok(Array.isArray(d.needs), `${d.name}: needs[] missing`);
}

// The spend guard and honest-skip machinery must survive edits.
const fs = require('fs');
const src = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'seam-acceptance.js'), 'utf8');
assert.ok(src.includes('guardSpend()'), 'spend guard vanished');
assert.ok(src.includes("skip: 'flag-dark"), 'honest flag-dark SKIP vanished');
assert.ok(!/require\(['"][^'"]*server(\.js)?['"]\)/.test(src),
  'acceptance script must never require server.js');

console.log('seam-acceptance smoke: PASS (6 demos, flags named, spend-guarded)');
process.exit(0);

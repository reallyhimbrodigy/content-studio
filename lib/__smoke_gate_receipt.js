'use strict';
// Gate for the /api/health build-gate receipt (TRUTH→DELIVERY 2026-08-11).
// Laws: a valid receipt surfaces {passed,total,at}; an ABSENT file reads null
// (the load-bearing "gate never armed" proof); malformed/corrupt content reads
// null, never throws — a broken receipt must never break boot or lie green.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readGateReceipt } = require('./gate-receipt');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-receipt-'));

// absent → null
assert.strictEqual(readGateReceipt(dir), null, 'absent file must read null');

// valid → surfaced
fs.writeFileSync(path.join(dir, '.gate_receipt.json'),
  JSON.stringify({ smokes_passed: 20, smokes_total: 20, at: '2026-08-11T00:00:00Z' }));
const ok = readGateReceipt(dir);
assert.deepStrictEqual(ok, { passed: 20, total: 20, at: '2026-08-11T00:00:00Z' });

// alternate key spelling tolerated
fs.writeFileSync(path.join(dir, '.gate_receipt.json'),
  JSON.stringify({ passed: 19, total: 20 }));
assert.deepStrictEqual(readGateReceipt(dir), { passed: 19, total: 20, at: null });

// malformed JSON → null, no throw
fs.writeFileSync(path.join(dir, '.gate_receipt.json'), '{not json');
assert.strictEqual(readGateReceipt(dir), null, 'malformed must read null');

// wrong shape → null
fs.writeFileSync(path.join(dir, '.gate_receipt.json'), JSON.stringify([1, 2]));
assert.strictEqual(readGateReceipt(dir), null, 'array must read null');
fs.writeFileSync(path.join(dir, '.gate_receipt.json'), JSON.stringify({ at: 'x' }));
assert.strictEqual(readGateReceipt(dir), null, 'missing counts must read null');

console.log('gate-receipt smoke: PASS (absent-null, valid, alt-keys, malformed-null, shape-null)');
process.exit(0);

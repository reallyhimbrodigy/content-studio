'use strict';
// Gate for the /api/health build-gate receipt (TRUTH→DELIVERY 2026-08-11).
// Laws: a valid receipt surfaces {passed,total,skipped,at}; an ABSENT file reads
// null (the load-bearing "gate never armed" proof); malformed/corrupt content
// reads null, never throws — a broken receipt must never break boot or lie
// green; a SKIPPED smoke is never counted as passed.
//
// AND THE WIRING (2026-08-11): this shipped as a reader with no writer, so
// `gate` would have read null on every build forever — an instrument stuck in
// its own alarm state, closing nothing. The round-trip below plus the
// validate_deploy.js wiring assertion is what makes THAT regression impossible,
// not merely fixed once.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  readGateReceipt, writeGateReceipt, clearGateReceipt, watermarkArmingWarning,
} = require('./gate-receipt');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-receipt-'));

// absent → null
assert.strictEqual(readGateReceipt(dir), null, 'absent file must read null');

// valid → surfaced
fs.writeFileSync(path.join(dir, '.gate_receipt.json'),
  JSON.stringify({ smokes_passed: 20, smokes_total: 20, at: '2026-08-11T00:00:00Z' }));
const ok = readGateReceipt(dir);
assert.deepStrictEqual(ok, { passed: 20, total: 20, skipped: [], at: '2026-08-11T00:00:00Z' });

// alternate key spelling tolerated
fs.writeFileSync(path.join(dir, '.gate_receipt.json'),
  JSON.stringify({ passed: 19, total: 20 }));
assert.deepStrictEqual(readGateReceipt(dir), { passed: 19, total: 20, skipped: [], at: null });

// ── WRITER ROUND-TRIP: what validate_deploy.js writes is what /api/health reads
const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-receipt-rt-'));
assert.ok(writeGateReceipt(rt, { passed: 21, total: 22, skipped: ['export_watermark'] }),
  'writeGateReceipt must report the path it wrote');
const back = readGateReceipt(rt);
assert.strictEqual(back.passed, 21, 'round-trip passed');
assert.strictEqual(back.total, 22, 'round-trip total');
assert.deepStrictEqual(back.skipped, ['export_watermark'], 'a SKIPPED smoke must be named, never counted as passed');
assert.ok(back.at && !Number.isNaN(Date.parse(back.at)), 'round-trip timestamp must be a real ISO date');

// clear → back to the load-bearing null (a failed build must not serve a stale pass)
clearGateReceipt(rt);
assert.strictEqual(readGateReceipt(rt), null, 'cleared receipt must read null again');
clearGateReceipt(rt); // idempotent on an already-absent file

// ── WIRING: the writer must actually be CALLED by the gate. A writer nothing
// invokes is the same defect in a new costume.
const vd = fs.readFileSync(path.join(__dirname, '..', 'validate_deploy.js'), 'utf8');
assert.ok(/require\(['"]\.\/lib\/gate-receipt['"]\)/.test(vd),
  'validate_deploy.js must require lib/gate-receipt');
assert.ok(/writeGateReceipt\s*\(/.test(vd),
  'validate_deploy.js must CALL writeGateReceipt — a receipt nothing writes reads null forever');
assert.ok(/clearGateReceipt\s*\(/.test(vd),
  'validate_deploy.js must CALL clearGateReceipt — else a failed build serves the last pass');
assert.ok(/SKIP\\\(/.test(vd) || /\/\^\\s\*SKIP/.test(vd) || /SKIP\(/.test(vd),
  'validate_deploy.js must implement the SKIP( contract that feeds skipped[]');

// ── ARMED-BUT-UNVERIFIED alarm must FIRE, in every direction. The whole point
// of degrading no-ffmpeg to a SKIP is that the un-watermarkable container now
// boots fine; this is the thing that keeps that from being silent.
const ARMED = { EXPORT_WATERMARK_ENABLED: '1' };
const VERIFIED = { passed: 22, total: 22, skipped: [], at: null };
const SKIPPED = { passed: 21, total: 22, skipped: ['export_watermark'], at: null };

assert.strictEqual(watermarkArmingWarning(SKIPPED, {}), null, 'flag OFF → silent, whatever the receipt says');
assert.strictEqual(watermarkArmingWarning(VERIFIED, ARMED), null, 'armed + verified → silent (the good case)');
const warnSkipped = watermarkArmingWarning(SKIPPED, ARMED);
assert.ok(warnSkipped && /SKIPPED/.test(warnSkipped) && /export_watermark/.test(warnSkipped),
  'armed + skipped smoke MUST warn and name the smoke');
const warnAbsent = watermarkArmingWarning(null, ARMED);
assert.ok(warnAbsent && /NO build-gate receipt/.test(warnAbsent),
  'armed + no receipt at all MUST warn (the gate never ran on this build)');
// a receipt that predates skipped[] must not crash the predicate
assert.strictEqual(watermarkArmingWarning({ passed: 20, total: 20 }, ARMED), null,
  'legacy receipt without skipped[] must read as verified, never throw');

// ── server.js must actually CALL it at boot (same wiring law as the writer)
const sv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.ok(/watermarkArmingWarning\s*\(/.test(sv),
  'server.js must call watermarkArmingWarning at boot — an alarm nothing invokes is not an alarm');

// malformed JSON → null, no throw
fs.writeFileSync(path.join(dir, '.gate_receipt.json'), '{not json');
assert.strictEqual(readGateReceipt(dir), null, 'malformed must read null');

// wrong shape → null
fs.writeFileSync(path.join(dir, '.gate_receipt.json'), JSON.stringify([1, 2]));
assert.strictEqual(readGateReceipt(dir), null, 'array must read null');
fs.writeFileSync(path.join(dir, '.gate_receipt.json'), JSON.stringify({ at: 'x' }));
assert.strictEqual(readGateReceipt(dir), null, 'missing counts must read null');

console.log('gate-receipt smoke: PASS (absent-null, valid, alt-keys, malformed-null, shape-null, '
  + 'writer round-trip, skipped-named, clear→null, validate_deploy wiring)');
process.exit(0);

'use strict';
// BUILD-GATE RECEIPT reader (TRUTH→DELIVERY request 2026-08-11).
//
// validate_deploy.js writes `.gate_receipt.json` next to server.js when the
// full smoke gate passes during the Render build:
//   {"smokes_passed": 20, "smokes_total": 20, "at": "<ISO>"}
// server.js reads it ONCE at boot and serves it on /api/health as `gate`.
// null is the load-bearing value: file absent = this build did NOT run the
// gate — exactly what a silently-stale Render buildCommand looks like, and the
// fact that previously decayed to an owner build-log eyeball after every
// deploy. Malformed content also reads as null (a corrupt receipt proves
// nothing). Never throws; a read failure must never affect boot.

const fs = require('fs');
const path = require('path');

function readGateReceipt(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, '.gate_receipt.json'), 'utf8');
    const r = JSON.parse(raw);
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    const passed = Number(r.smokes_passed ?? r.passed);
    const total = Number(r.smokes_total ?? r.total);
    if (!Number.isFinite(passed) || !Number.isFinite(total)) return null;
    return {
      passed,
      total,
      at: typeof r.at === 'string' ? r.at : null,
    };
  } catch (_) {
    return null;
  }
}

module.exports = { readGateReceipt };

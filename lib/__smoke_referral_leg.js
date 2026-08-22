'use strict';

// GATE SMOKE — the referral leg fires once per completed render, and counts.
//
// This leg grants Pro days, so the two things that must never regress are
// (a) it is hung on the once-per-job CAS transition, not on a step label or a
// bare status check, and (b) every grant leaves a counter row. Both are
// asserted in tests/referral-leg.test.js, including a source-level check of the
// server.js call site; this wrapper puts them in front of the deploy gate so a
// refactor that moves the call out of the guard cannot ship.
//
// Delegates rather than duplicates: two copies of a money assertion drift, and
// the copy that drifts is always the one nobody runs.

const { execFileSync } = require('child_process');
const path = require('path');

try {
  execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'tests', 'referral-leg.test.js')],
    { stdio: 'pipe', timeout: 60000 }
  );
  console.log('referral-leg smoke: OK');
  process.exit(0);
} catch (err) {
  const out = `${err.stdout || ''}${err.stderr || ''}`.trim();
  console.error('referral-leg smoke FAILED:\n' + out.slice(-1200));
  process.exit(1);
}

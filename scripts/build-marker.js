#!/usr/bin/env node
'use strict';
// BUILD MARKER — the discriminator for a null gate receipt (2026-08-11).
//
// The first deploy carrying lib/gate-receipt.js came back with
// `/api/health .gate = null` even though render.yaml declares
//   buildCommand: npm install --omit=dev && node validate_deploy.js
// null has two candidate meanings and they demand opposite responses:
//
//   (a) the live service is NOT running that buildCommand — a Render blueprint
//       that never synced. The 24 safety smokes everyone believes are blocking
//       Render builds would then be blocking nothing. Owner fixes it in the
//       dashboard.
//   (b) build-time file writes simply do not survive into the runtime
//       filesystem, so the receipt is the wrong instrument and must be rebuilt.
//
// This marker settles it without needing a Render API key. It runs from npm's
// `postinstall`, which fires on ANY npm install — including the old, un-synced
// buildCommand — so at runtime:
//
//   gate null + marker null    → (b) build writes do not persist (or no install)
//   gate null + marker PRESENT → (a) npm install ran, validate_deploy.js did
//                                   NOT. Blueprint not synced. DECISIVE.
//   gate present               → the gate is armed; this marker is redundant.
//
// It must NEVER fail an install: any error is swallowed and we exit 0. A
// diagnostic that can break the build is worse than the ambiguity it resolves.

const fs = require('fs');
const path = require('path');

try {
  fs.writeFileSync(
    path.join(__dirname, '..', '.build_marker.json'),
    JSON.stringify({ npm_install_ran: true, at: new Date().toISOString(), node: process.version }) + '\n',
  );
} catch (_) {
  // Diagnostic only — never break an install.
}
process.exit(0);

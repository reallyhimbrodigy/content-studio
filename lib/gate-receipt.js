'use strict';
// BUILD-GATE RECEIPT reader (TRUTH→DELIVERY request 2026-08-11).
//
// validate_deploy.js writes `.gate_receipt.json` next to server.js when the
// full smoke gate passes during the Render build:
//   {"smokes_passed": 20, "smokes_total": 20, "smokes_skipped": [], "at": "<ISO>"}
// server.js reads it ONCE at boot and serves it on /api/health as `gate`.
// null is the load-bearing value: file absent = this build did NOT run the
// gate — exactly what a silently-stale Render buildCommand looks like, and the
// fact that previously decayed to an owner build-log eyeball after every
// deploy. Malformed content also reads as null (a corrupt receipt proves
// nothing). Never throws; a read failure must never affect boot.
//
// THE WRITER LIVES HERE TOO, deliberately (2026-08-11). It shipped as a reader
// with no writer anywhere in the repo — validate_deploy.js was byte-identical
// to main — so `gate` would have read null on every build forever, and null
// means "the gate never ran". An instrument that always reports the alarm state
// closes nothing. Keeping write+read in one file, round-tripped by one smoke,
// is what makes that specific regression impossible rather than merely fixed.

const fs = require('fs');
const path = require('path');

const RECEIPT_NAME = '.gate_receipt.json';

function readGateReceipt(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, RECEIPT_NAME), 'utf8');
    const r = JSON.parse(raw);
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    const passed = Number(r.smokes_passed ?? r.passed);
    const total = Number(r.smokes_total ?? r.total);
    if (!Number.isFinite(passed) || !Number.isFinite(total)) return null;
    const rawSkipped = r.smokes_skipped ?? r.skipped;
    return {
      passed,
      total,
      // A SKIPPED smoke is not a passed smoke. It is named so a flip decision
      // ("is the watermark pass proven in this container?") is a curl against
      // /api/health, not a memory of what the build log said.
      skipped: Array.isArray(rawSkipped) ? rawSkipped.filter((s) => typeof s === 'string') : [],
      at: typeof r.at === 'string' ? r.at : null,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Write the receipt for a PASSING gate run. Called by validate_deploy.js only.
 * Returns the path written, or null if the write failed (never throws — the
 * gate's verdict is the gate's exit code; a receipt is evidence, not a gate).
 */
function writeGateReceipt(dir, { passed, total, skipped = [] }) {
  const p = path.join(dir, RECEIPT_NAME);
  try {
    fs.writeFileSync(p, JSON.stringify({
      smokes_passed: passed,
      smokes_total: total,
      smokes_skipped: skipped,
      at: new Date().toISOString(),
    }) + '\n');
    return p;
  } catch (_) {
    return null;
  }
}

/**
 * Remove a stale receipt. Called when the gate FAILS or is about to run, so a
 * previous build's passing receipt can never be served beside a build that did
 * not earn it — the failure mode that would make `gate` lie green.
 */
function clearGateReceipt(dir) {
  try { fs.rmSync(path.join(dir, RECEIPT_NAME), { force: true }); } catch (_) { /* evidence only */ }
}

/**
 * ARMED-BUT-UNVERIFIED check for the watermark flip. Pure function so the smoke
 * can prove it fires — a warning nobody has seen fire is not a warning.
 *
 * The watermark pass is LOCAL ffmpeg, and Render's Node runtime does not ship
 * that binary; its build smoke degrades to SKIP(no-ffmpeg) so it cannot block
 * every content-studio deploy. That means the container which CANNOT watermark
 * boots perfectly. If the flag is armed on such a build, every free export
 * silently ships the clean master — a defect, not a degrade.
 *
 * Returns a warning string when armed-but-unverified, else null.
 */
function watermarkArmingWarning(receipt, env = process.env) {
  if (String(env.EXPORT_WATERMARK_ENABLED || '') !== '1') return null;
  if (!receipt) {
    return '[export] ⚠️  EXPORT_WATERMARK_ENABLED=1 but NO build-gate receipt — this build never ran the smoke '
      + 'gate, so the watermark pass is UNVERIFIED on this container. Free exports may ship clean.';
  }
  const skipped = Array.isArray(receipt.skipped) ? receipt.skipped : [];
  if (skipped.some((s) => /export.?watermark/i.test(s))) {
    return '[export] ⚠️  EXPORT_WATERMARK_ENABLED=1 but the export-watermark smoke SKIPPED on this build '
      + `(${skipped.join(', ')}) — ffmpeg is not executable here. Free exports WILL fall back to the clean `
      + 'master and count export_watermark_failed. Disarm the flag or install ffmpeg on Render.';
  }
  return null;
}

module.exports = {
  readGateReceipt, writeGateReceipt, clearGateReceipt, watermarkArmingWarning, RECEIPT_NAME,
};

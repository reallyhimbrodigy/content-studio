'use strict';

// Single source of truth for the KNOWN, TIME-BOXED render outage — the Modal
// $1,500 spend-cap stop (2026-07-30 → the billing cycle rolls Aug 1). Driven by
// ONE env var:
//
//   KNOWN_OUTAGE_UNTIL   an ISO-8601 instant, e.g. "2026-08-01T07:00:00Z"
//
// Active  ⇔  the var is set AND now < that instant.
// Expiry  is UNCONDITIONAL — a pure timestamp compare. No renewal path, no
//         persistence, no manual re-arm. Once now ≥ the instant it is simply
//         off. Unset ⇒ inactive (normal operation), so this is a no-op until
//         Zac sets the var, and it cannot get "stuck on".
//
// While active it drives three honest behaviours (wired at their call sites):
//   1. MAINTENANCE GATE  — POST /api/video-jobs refuses BEFORE any quota claim,
//      job row, or Modal dispatch, with a message the client renders inline. No
//      failed render (a failure costs an App Store review; a refusal costs one
//      session), no quota burn, and NO queued job (4 days of pent-up jobs firing
//      at once on Aug 1 would just re-cap the workspace).
//   2. OWNER-PAGE MUTE   — the dispatch-layer alert stops PAGING for the cap
//      signature (an all-MODAL_404 cluster) only; any OTHER error class still
//      pages loudly + immediately, so the mute can never hide a new break.
//   3. RECOVERY PAGE     — the first successful completion after the outage
//      fires a single owner page (latched in dispatch-to-modal.js).

const DEFAULT_MESSAGE = "Renders are paused until tomorrow — we'll be back August 1.";

function knownOutageUntilMs() {
  const raw = process.env.KNOWN_OUTAGE_UNTIL;
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0; // unparseable ⇒ treat as unset (fail safe: OFF)
}

function isKnownOutageActive(nowMs = Date.now()) {
  const until = knownOutageUntilMs();
  return until > 0 && nowMs < until;
}

// Env-overridable so the copy can be tweaked without a deploy.
function maintenanceUserMessage() {
  return String(process.env.KNOWN_OUTAGE_MESSAGE || '').trim() || DEFAULT_MESSAGE;
}

module.exports = { isKnownOutageActive, knownOutageUntilMs, maintenanceUserMessage };

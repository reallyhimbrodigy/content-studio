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

// EXPECTED FORMAT: an ISO-8601 instant, e.g. "2026-08-01T07:00:00Z" (UTC). A
// date-only "2026-08-01" also parses (= that day's UTC midnight). Epoch ms is
// NOT accepted. An unparseable value does NOT silently no-op — it LOGS LOUDLY
// (once) so a fat-fingered env can't leave the gate silently inert (the boolean-
// preview-column / unmounted-editor failure class). It still returns 0 (gate
// OFF) rather than fail-closed, because a typo must not be able to WEDGE the
// product into permanent maintenance with no valid expiry — the loud log +
// Zac's one-upload visual check catch the misconfig in seconds.
let _parseWarned = false;
function knownOutageUntilMs() {
  const raw = process.env.KNOWN_OUTAGE_UNTIL;
  if (!raw) return 0;
  const t = Date.parse(String(raw).trim());
  if (!Number.isFinite(t)) {
    if (!_parseWarned) {
      _parseWarned = true;
      console.error(`[known-outage] ⚠️  KNOWN_OUTAGE_UNTIL is set to ${JSON.stringify(raw)} but is UNPARSEABLE — the maintenance gate is NOT engaging (renders are NOT paused). Expected an ISO-8601 instant like "2026-08-01T07:00:00Z". Fix the value.`);
    }
    return 0;
  }
  _parseWarned = false; // a subsequent good value re-arms the warning
  return t;
}

// Boot-time visibility (Zac's verification hook): state the outcome ONCE at load,
// so a Render redeploy after setting the env immediately shows whether it took.
(function announceKnownOutageAtBoot() {
  const raw = process.env.KNOWN_OUTAGE_UNTIL;
  if (!raw) { console.log('[known-outage] KNOWN_OUTAGE_UNTIL not set — maintenance gate OFF (normal operation).'); return; }
  const until = knownOutageUntilMs(); // logs loudly itself if unparseable
  if (!until) return;
  const active = Date.now() < until;
  console.log(`[known-outage] ARMED — until ${new Date(until).toISOString()} · currently ${active ? 'ACTIVE (renders paused; users see the honest maintenance message; no quota consumed)' : 'EXPIRED (past that instant → gate OFF)'}.`);
})();

function isKnownOutageActive(nowMs = Date.now()) {
  const until = knownOutageUntilMs();
  return until > 0 && nowMs < until;
}

// Env-overridable so the copy can be tweaked without a deploy.
function maintenanceUserMessage() {
  return String(process.env.KNOWN_OUTAGE_MESSAGE || '').trim() || DEFAULT_MESSAGE;
}

module.exports = { isKnownOutageActive, knownOutageUntilMs, maintenanceUserMessage };

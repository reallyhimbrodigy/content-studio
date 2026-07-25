// Owner-alert shim — DELEGATES to services/push.js (the proven transport).
//
// MAILMAN POST-MORTEM (2026-07-24): this module used to carry its own APNs
// client with a DIFFERENT env convention from services/push.js:
//   - it required APNS_KEY (raw PEM) — prod carries APNS_AUTH_KEY_BASE64
//     (push.js's convention; proven configured by prod push_sent analytics
//     events with sent=1), so buildAPNsJWT() threw "APNS env vars missing"
//     and every owner alert died at "[alert] JWT build failed";
//   - its gateway defaulted to the SANDBOX host unless APNS_PRODUCTION=true
//     — push.js defaults to the PRODUCTION host unless APNS_USE_SANDBOX=1,
//     and prod device tokens are production tokens.
// Either divergence alone kills delivery while "working in logs". The owner's
// device token (registered 2026-04-28, still on file 2026-07-25) was never
// pruned — consistent with the sends dying before/at the gateway, never with
// a BadDeviceToken. Fix: ONE transport. This file now only re-exports the
// owner-alert entrypoint from services/push.js so the four existing call
// sites (lib/job-reaper.js, lib/bleed-meter.js, lib/video-processor/
// dispatch-to-modal.js, server.js) keep working unchanged.
//
// The old sendRenderCompleteNotification (the "✨" completion push) is gone:
// user-facing render-lifecycle pushes are consolidated in lib/lifecycle-push.js
// (claim-gated, USER_LIFECYCLE_PUSHES flag), which server.js and the dispatch
// tail now call at the settle-once terminal transitions.

const push = require('./push');

/// Signature-compatible with the legacy sendOwnerAlert: the supabaseAdmin
/// param is accepted and ignored (push.js owns its admin client — the same
/// service-role client every caller was passing in).
async function sendOwnerAlert({ ownerUserId, title, body, threadId, supabaseAdmin } = {}) {
  void supabaseAdmin;
  return push.sendOwnerAlert({ ownerUserId, title, body, threadId });
}

module.exports = { sendOwnerAlert };

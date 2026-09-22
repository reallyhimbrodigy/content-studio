'use strict';

// ── validate_token — a PER-USER, SHORT-LIVED, SIGNED token for /validate ────
//
// WHAT /validate IS. It is the ONE worker endpoint the iOS app calls DIRECTLY,
// with no server proxy in front of it, so it cannot carry a server-side secret
// the way run_job / prewarm / warmup do. Build 256 already reads
// `validate_token` off the /api/usage snapshot and sends it as `_worker_auth`;
// nothing in the app changes here. The producer is what was never written —
// measured 2026-09-21, `validate_token` appears ZERO times in server.js on
// main AND on 4d11fcf, which is why 11 of 11 real /validate calls arrived
// unauthenticated.
//
// WHY IT IS NOT THE SHARED SECRET. Handing clients MODAL_RUN_SECRET would mean
// an extraction from any app binary buys arbitrary GPU dispatch — the whole
// point of the separate key. This mints a token that is:
//   * PER USER   — bound to the user_id it was issued for, so a lifted token
//                  cannot be replayed as somebody else;
//   * SHORT LIVED— expiry is stamped IN the token and capped at 1 hour, so a
//                  lifted token dies on its own rather than on a rotation;
//   * OPAQUE     — the app treats it as a string and never parses it, so the
//                  format below can change without a client release.
//
// FAIL CLOSED, AND NEVER TO MODAL_RUN_SECRET. With MODAL_VALIDATE_SECRET unset
// this mints NOTHING and returns null: the field is simply absent from the
// snapshot, the app's `validateToken` stays nil, and /validate is exactly as
// unauthenticated as it is today — no worse, and no dispatch secret shipped to
// clients to make it "work". A fallback to MODAL_RUN_SECRET would be the
// silent-inert pattern paying for itself in the wrong direction.

const crypto = require('crypto');

// Hard ceiling, not a default to be overridden upward at a call site. An hour
// is the blast radius of a lifted token; a knob here is a knob someone widens.
const MAX_TTL_SECONDS = 3600;
const VERSION = 'v1';

/** The signing secret, or '' when unset. NEVER falls back to MODAL_RUN_SECRET. */
function validateSecret() {
  return String(process.env.MODAL_VALIDATE_SECRET || '').trim();
}

function sign(userId, expEpochSec, secret) {
  return crypto.createHmac('sha256', secret)
    .update(`${VERSION}.${userId}.${expEpochSec}`)
    .digest('hex');
}

/**
 * Mint a token for one user, or null when unmintable.
 *
 * @param {string} userId    the authenticated user's id
 * @param {object} [opts]    { ttlSeconds, nowMs } — ttl is CLAMPED to 1h
 * @returns {string|null}    `v1.<exp>.<hmac>` or null
 */
function mintValidateToken(userId, opts = {}) {
  const secret = validateSecret();
  if (!secret) return null;                       // fail closed, no fallback
  const uid = String(userId || '').trim();
  if (!uid) return null;                          // unbound token = shared secret
  const ttlRaw = Number(opts.ttlSeconds);
  const ttl = Math.min(
    MAX_TTL_SECONDS,
    Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.floor(ttlRaw) : MAX_TTL_SECONDS,
  );
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const exp = Math.floor(nowMs / 1000) + ttl;
  return `${VERSION}.${exp}.${sign(uid, exp, secret)}`;
}

/**
 * Verify a token for a user. Here so the SHAPE has one definition rather than
 * two that drift — the worker enforces in Python, and this is what that side
 * is mirroring. Timing-safe compare; an expired token is a distinct state from
 * a forged one so the worker can log them apart.
 *
 * @returns {{ok:boolean, reason:string}}
 */
function verifyValidateToken(token, userId, opts = {}) {
  const secret = validateSecret();
  if (!secret) return { ok: false, reason: 'unconfigured' };
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' };
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'malformed' };
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, reason: 'no_user' };
  const expected = sign(uid, exp, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(parts[2] || ''), 'utf8');
  // EQUAL LENGTH FIRST — timingSafeEqual THROWS on a length mismatch, which
  // would turn a forged token into a 500 instead of a refusal.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }
  const nowSec = Math.floor(
    (Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now()) / 1000,
  );
  if (nowSec >= exp) return { ok: false, reason: 'expired' };
  return { ok: true, reason: 'ok' };
}

module.exports = {
  MAX_TTL_SECONDS,
  validateSecret,
  mintValidateToken,
  verifyValidateToken,
};

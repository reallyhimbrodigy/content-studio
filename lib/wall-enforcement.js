'use strict';

// Wall enforcement decisions (Wall Correctness item 2), pure + testable. The
// server gates (render / chat / upload) call these so `.none` is denied at the
// API — not merely hidden in the UI. This is the difference between a wall and
// wallpaper: a jailbroken client, an old binary, or a UI bug is never a free tier.
//
// SAFETY: the master switch defaults OFF, so wiring these into the live gates is
// a no-op until the knob flips — building the spine changes no one's behavior yet.

const { capabilities } = require('./tier-capabilities');

/** Master switch (server knob). Default OFF. */
function wallEnabled() {
  const v = String(process.env.WALL_ENFORCEMENT || '').toLowerCase().trim();
  return v === 'on' || v === '1' || v === 'true';
}

/** The flip instant (ms). Accounts created at/after it are always enforced. Knob. */
function flipDateMs() {
  const t = Date.parse(process.env.WALL_FLIP_DATE || '');
  return Number.isFinite(t) ? t : null;
}

/** A wall-capable client (≥1.2.0) sends this header; old binaries don't. */
function clientWallCapable(headers) {
  return String((headers || {})['x-promptly-wall-capable'] || '') === '1';
}

/**
 * Rollout policy — RATIFIED 2026-07-21 (Zac): "WALL existing users." Enforce
 * when the master switch is ON **and** (the account was created at/after the
 * flip **or** the client is wall-capable). The `|| clientWallCapable` is
 * DELIBERATE, not an oversight: an existing free user IS walled on gated
 * actions once they update to a wall-capable (1.2.0+) client after the flip.
 * The considered alternative — grandfather all pre-flip accounts free (key on
 * createdAfterFlip alone) — was explicitly rejected. Do not drop the
 * `|| clientWallCapable` term without a new ruling.
 *
 * Existing accounts on OLD binaries (neither term true) keep today's capped
 * free tier until they update — no mid-session hard-break, and the ~1k live
 * pre-1.2.0 users are untouched by a flip until they update.
 */
function shouldEnforceWall({ accountCreatedAt, clientWallCapable = false, enabled = wallEnabled(), flip = flipDateMs() } = {}) {
  if (!enabled) return false;
  const created = accountCreatedAt != null ? Date.parse(accountCreatedAt) : NaN;
  const createdAfterFlip = flip != null && Number.isFinite(created) && created >= flip;
  return !!(createdAfterFlip || clientWallCapable);
}

/**
 * The tier a gate should ACT on.
 *
 * Knob OFF (default, today) is byte-for-byte the legacy behavior, where the gate
 * keyed off `isPro`: any active entitlement (trial OR paid) → `paid` (unlimited),
 * no entitlement → `trial` (today's 3/day free caps).
 *
 * Knob ON is now FREEMIUM (2026-07-21 pivot — supersedes the trial wall):
 *   - any ACTIVE pro, including a still-running purchased trial → `paid`
 *     (unlimited). This is how the one mid-trial user is grandfathered for the
 *     trial's remaining days; when RC lapses them they fall to `none` → `free`.
 *   - everyone else → `free` (the permanent 2/day free tier), NEVER `none`.
 * So the 403 wall is structurally unreachable under freemium — a non-pro user is
 * always `free` (usable), and hits the upgrade paywall (402) on a limit, not a wall.
 */
function effectiveTier(tier, enforce) {
  if (enforce) {
    if (tier === 'paid' || tier === 'trial') return 'paid'; // active pro / grandfathered trial
    return 'free';                                          // freemium free tier
  }
  if (tier === 'trial') return 'paid'; // active trial == isPro == unlimited (today)
  if (tier === 'none') return 'trial'; // no entitlement == 3/day free (today)
  return tier;
}

/**
 * Gate decision for a daily-capped action (render / chat). Returns
 * `{ allow, route, status }`:
 *   - not app-usable (enforced `.none`) → deny, route 'wall', 403.
 *   - under the cap → allow, 200.
 *   - at/over the cap → deny, route 'paywall', 402.
 */
function gateDecision({ tier, kind, todayCount = 0, enforce = false }) {
  const caps = capabilities(effectiveTier(tier, enforce));
  if (!caps.appUsable) return { allow: false, route: 'wall', status: 403 };
  const limit = kind === 'chat' ? caps.chatLimit : caps.renderLimit;
  if (todayCount < limit) return { allow: true, route: null, status: 200 };
  return { allow: false, route: caps.limitHitRouting || 'paywall', status: 402 };
}

/** Gate decision for an upload of `count` files. Same shape as gateDecision. */
function uploadDecision({ tier, count, enforce = false }) {
  const caps = capabilities(effectiveTier(tier, enforce));
  if (!caps.appUsable) return { allow: false, route: 'wall', status: 403, max: caps.uploadMax };
  const allow = count >= 1 && count <= caps.uploadMax;
  return { allow, route: allow ? null : 'paywall', status: allow ? 200 : 402, max: caps.uploadMax };
}

module.exports = {
  wallEnabled, flipDateMs, clientWallCapable,
  shouldEnforceWall, effectiveTier, gateDecision, uploadDecision,
};

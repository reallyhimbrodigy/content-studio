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
 * A FREEMIUM client (≥1.3.0) sends `X-Promptly-Freemium: 1`. It means: "freemium
 * is my UNCONDITIONAL behavior — enforce the permanent free tier (1/day, 1 upload,
 * Flare-only, no re-edit) and the upgrade wall for me regardless of the
 * WALL_ENFORCEMENT knob." The knob is NOT consulted for these clients.
 *
 * The live 1.2.0 build NEVER sends this header (it shipped before 1.3.0 existed),
 * so its trial-wall path continues to key off `shouldEnforceWall` alone (knob off
 * → never enforced). This header is the ONLY thing that distinguishes a 1.3.0
 * client from a 1.2.0 client, which is exactly why removing the gate for freemium
 * can't accidentally activate a trial wall for the ~live 1.2.0 users.
 */
function clientFreemium(headers) {
  return String((headers || {})['x-promptly-freemium'] || '') === '1';
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
 * The enforcement decision a gate ACTS on — freemium-aware. This is what every
 * server door should call (not `shouldEnforceWall` directly):
 *
 *   - 1.3.0+ FREEMIUM client (X-Promptly-Freemium: 1) → ALWAYS enforce. Freemium
 *     is unconditional for these clients; the WALL_ENFORCEMENT knob is not read.
 *   - otherwise (the live 1.2.0 build, old binaries, server-to-server) → the
 *     legacy knob-gated rollout via `shouldEnforceWall`. With the knob off
 *     (default, and it stays off) this is `false` — byte-for-byte today's
 *     behavior, so no trial wall can ever activate for a 1.2.0 client.
 *
 * The two paths are fully separated by the header: a request that omits it can
 * never reach the freemium branch, so this change is provably a no-op for 1.2.0.
 */
function resolveEnforce({ headers, accountCreatedAt, enabled = wallEnabled(), flip = flipDateMs() } = {}) {
  if (clientFreemium(headers)) return true; // 1.3.0+ freemium: unconditional, knob-independent
  return shouldEnforceWall({
    accountCreatedAt,
    clientWallCapable: clientWallCapable(headers),
    enabled,
    flip,
  });
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
 *   - everyone else → `free` (the permanent 1/day free tier), NEVER `none`.
 * So the 403 wall is structurally unreachable under freemium — a non-pro user is
 * always `free` (usable), and hits the upgrade paywall (402) on a limit, not a wall.
 */
function effectiveTier(tier, enforce) {
  if (enforce) {
    // MAX SURVIVES THE COLLAPSE (2026-09-02). It used to fall to the `return
    // 'free'` below — a Max subscriber resolved to the 1-render/day free tier,
    // which is what "effectiveTier lies" meant: TIER_RANK ranked max:40 above
    // pro:30 while every gate downstream saw 'free'.
    //
    // SAFE ONLY BECAUSE tier-capabilities.js NOW HAS A `max` ROW. Before that
    // row, passing 'max' through hit `capabilities()`'s fail-closed default —
    // appUsable:false — and every Max subscriber got a 403 WALL, not a paywall.
    // If that row is ever removed, this line must go first, not second.
    if (tier === 'max') return 'max';
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
  wallEnabled, flipDateMs, clientWallCapable, clientFreemium,
  shouldEnforceWall, resolveEnforce, effectiveTier, gateDecision, uploadDecision,
};

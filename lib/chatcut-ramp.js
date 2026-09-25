'use strict';
// THE RAMP AND THE KILL SWITCH — allowlist → percent → all, resolved PER JOB,
// on top of the account guard.
//
// Zac 2026-09-25: "Kill switch = percent 0 and enabled_all false, effective
// within the 30 s cache."
//
// ── THE KILL SWITCH AS SPECIFIED HAS A HOLE, AND IT IS THE ALLOWLIST ─────
// `percent 0 + enabled_all false` does NOT stop a user who is on the row's
// allowlist — resolve() checks the allowlist BEFORE the percent, which is
// correct for a canary and wrong for a switch. Killing would be three fields
// to get right (percent 0, enabled_all false, allowlist []) at the moment
// somebody is under pressure, and the one they would forget is the one that
// keeps spending.
//
// WORSE, WITH NO ROW AT ALL: the env path falls back to DEFAULT_ALLOWLIST, so
// deleting the chatcut_route row turns routing back ON for three accounts.
// A kill switch you can defeat by deleting a row is not a kill switch.
//
// So the kill is its OWN flag. `chatcut_route_kill` with enabled_all = true
// stops every new job within the 30 s cache, whatever chatcut_route says, and
// it is ONE field.
const KILL_FLAG = 'chatcut_route_kill';
const RAMP_FLAG = 'chatcut_route';

// ── FAIL CLOSED, BECAUSE THIS PATH SPENDS ────────────────────────────────
// If the flag store cannot be read we do not know whether we have been told to
// stop. The existing pipeline always works; ChatCut spends from a pool that
// lasts DAYS at August's volume. So an unreadable switch routes away from the
// thing that costs money, which is the opposite of how the upload flags fail
// (a canary that cannot read its flag is correctly OFF-by-absence, and that
// is the same direction for a different reason).
//
// resolve() could not previously express this — "no row" and "database down"
// both surfaced as from:'env'. It now returns dbState, and this is the caller
// that needed it.
const REASONS = [
  'reedit_must_use_chatcut',   // bypasses the ramp: it cannot run anywhere else
  'killed',                    // the kill flag is on
  'flags_unreadable',          // we could not read the switch — fail closed
  'allowlist', 'percent', 'all',
  'ramp_off',
];

/**
 * -> { allowed, reason, source, dbState }
 *
 * `resolveFlag(flag, userId)` is injected — the real one is
 * lib/upload-flags.js resolve(flag, userId, supabaseAdmin), which already does
 * allowlist → percent → all with a stable per-(flag,user) hash and a 30 s
 * cache. Nothing here re-implements a rollout; this decides what the rollout
 * is ALLOWED to say.
 */
async function rampAllows({ userId, isChatcutReedit = false, resolveFlag,
  log = console } = {}) {
  // ── A CHATCUT RE-EDIT BYPASSES THE RAMP ENTIRELY ───────────────────────
  // It is a re-edit of a project that exists in ChatCut and nowhere else, so
  // "route it to the existing pipeline instead" is not a fallback, it is a
  // failure — handler cannot read that plan. The ramp governs which NEW work
  // we send there; it must never strand work already sent. The account guard
  // still applies (lib/chatcut-routing.js), and that is where the hard credit
  // floor stops it.
  if (isChatcutReedit) {
    return { allowed: true, reason: 'reedit_must_use_chatcut', source: 'bypass', dbState: null };
  }
  if (!userId) return { allowed: false, reason: 'ramp_off', source: 'no-user', dbState: null };

  let kill = null;
  try {
    kill = await resolveFlag(KILL_FLAG, userId);
  } catch (e) {
    log.warn(`[chatcut-ramp] kill flag unreadable (${(e && e.message) || 'unknown'}) — `
      + 'routing to the existing pipeline');
    return { allowed: false, reason: 'flags_unreadable', source: 'kill-threw', dbState: 'unreadable' };
  }
  // THE KILL IS CHECKED FIRST AND IT IS ABSOLUTE. Not ANDed with the ramp,
  // not overridable by an allowlist.
  if (kill && kill.on) {
    return { allowed: false, reason: 'killed', source: kill.source, dbState: kill.dbState || null };
  }
  // AND AN UNREADABLE STORE IS A KILL WE MIGHT NOT HAVE HEARD.
  if (kill && kill.dbState === 'unreadable') {
    return { allowed: false, reason: 'flags_unreadable', source: kill.source,
             dbState: 'unreadable' };
  }

  let ramp = null;
  try {
    ramp = await resolveFlag(RAMP_FLAG, userId);
  } catch (e) {
    log.warn(`[chatcut-ramp] ramp flag unreadable (${(e && e.message) || 'unknown'})`);
    return { allowed: false, reason: 'flags_unreadable', source: 'ramp-threw', dbState: 'unreadable' };
  }
  if (ramp && ramp.dbState === 'unreadable') {
    return { allowed: false, reason: 'flags_unreadable', source: ramp.source, dbState: 'unreadable' };
  }
  if (ramp && ramp.on) {
    return { allowed: true, reason: ramp.source, source: ramp.source, dbState: ramp.dbState || 'ok' };
  }
  return { allowed: false, reason: 'ramp_off', source: (ramp && ramp.source) || 'off',
           dbState: (ramp && ramp.dbState) || 'ok' };
}

module.exports = { rampAllows, KILL_FLAG, RAMP_FLAG, REASONS };

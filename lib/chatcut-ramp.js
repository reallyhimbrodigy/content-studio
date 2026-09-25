'use strict';
// THE RAMP AND THE KILL SWITCH — ONE ROW, `server_flags.chatcut_route`,
// resolved per job by the existing DB-first resolver, on top of the account
// guard.
//
// Zac 2026-09-25, RULING THAT REPLACED MY DESIGN, verbatim:
//   "server_flags.chatcut_route exists now: allowlist = the 3 internal
//    accounts + Frontend's test account d14d30e7, percent 0, enabled_all
//    false. Wire the routing decision to it through the existing DB-first
//    resolver; don't create a second row or name. Kill switch = percent 0 AND
//    enabled_all false."
//
// ── WHAT I BUILT FIRST, AND WHY IT IS GONE ──────────────────────────────
// This file previously added a SECOND flag, `chatcut_route_kill`, on the
// argument that `percent 0 + enabled_all false` cannot stop an allowlisted
// user — resolve() checks the allowlist before the percent, so a kill would be
// three fields to get right under pressure. That argument is still true and it
// is recorded here rather than removed, because the residual is real and
// somebody will need to know it at 2am:
//
//   THE KILL STOPS EVERY NON-ALLOWLISTED USER. The four accounts ON the
//   allowlist keep routing until the allowlist is emptied. That is the
//   POINT of the ruling — the allowlist holds the three internal accounts and
//   Frontend's test account, and killing customer traffic must not blind the
//   people diagnosing it. To stop absolutely everything: percent 0,
//   enabled_all false, allowlist '{}'.
//
// A second name was the wrong fix for it. Two rows means two things to read
// when answering "is ChatCut on", and the one you did not read is the one that
// is spending. One row, one answer, and the residual written down.
const RAMP_FLAG = 'chatcut_route';

// ── FAIL CLOSED, BECAUSE THIS PATH SPENDS ────────────────────────────────
// If the flag store cannot be read we do not know whether we have been told to
// stop. The existing pipeline always works; ChatCut spends from a pool that
// lasts DAYS at August's volume. So an unreadable switch routes away from the
// thing that costs money.
//
// This is the OPPOSITE direction from lib/upload-flags.js's own fallback,
// deliberately: that file falls back to env so a canary keeps working, and its
// DEFAULT_ALLOWLIST would turn routing ON for three accounts from a read that
// failed. `dbState` is what lets this caller refuse that — resolve() returns
// 'unreadable' whenever the rows could not be read, including when the env
// path then answered.
const REASONS = [
  'reedit_must_use_chatcut',   // bypasses the ramp: it cannot run anywhere else
  'flags_unreadable',          // we could not read the switch — fail closed
  'allowlist', 'percent', 'all',
  'ramp_off',                  // percent 0 AND enabled_all false = the kill
];

/**
 * -> { allowed, reason, source, dbState }
 *
 * `resolveFlag(flag, userId)` is injected — the real one is
 * lib/upload-flags.js resolve(flag, userId, supabaseAdmin), which already does
 * allowlist -> percent -> all with a stable per-(flag,user) hash and a 30 s
 * cache. Nothing here re-implements a rollout; this decides what the rollout
 * is ALLOWED to say.
 *
 * THE 30 s IS THE RESOLVER'S CACHE, NOT A TIMER HERE. A SQL update to the row
 * lands on the next request after the cache expires, with no deploy — which is
 * the whole reason the switch is a row and not an env var.
 */
async function rampAllows({ userId, isChatcutReedit = false, resolveFlag,
  log = console } = {}) {
  // ── A CHATCUT RE-EDIT BYPASSES THE RAMP ENTIRELY ───────────────────────
  // It is a re-edit of a project that exists in ChatCut and nowhere else, so
  // "route it to the existing pipeline instead" is not a fallback, it is a
  // failure — handler cannot read that plan. The ramp governs which NEW work
  // we send there; it must never strand work already sent. The account guard
  // still applies (lib/chatcut-routing.js), and that is where the hard credit
  // floor stops it. Zac: "ChatCut re-edits still route while credits last."
  if (isChatcutReedit) {
    return { allowed: true, reason: 'reedit_must_use_chatcut', source: 'bypass', dbState: null };
  }
  if (!userId) return { allowed: false, reason: 'ramp_off', source: 'no-user', dbState: null };

  let f = null;
  try {
    f = await resolveFlag(RAMP_FLAG, userId);
  } catch (e) {
    log.warn(`[chatcut-ramp] ${RAMP_FLAG} unreadable (${(e && e.message) || 'unknown'}) — `
      + 'routing to the existing pipeline');
    return { allowed: false, reason: 'flags_unreadable', source: 'threw', dbState: 'unreadable' };
  }
  // AN UNREADABLE STORE IS A KILL WE MIGHT NOT HAVE HEARD. Checked BEFORE
  // `on`, because the env fallback can answer `on` from DEFAULT_ALLOWLIST off a
  // failed read — and that is exactly the case where we must not spend.
  if (f && f.dbState === 'unreadable') {
    return { allowed: false, reason: 'flags_unreadable', source: (f && f.source) || 'unknown',
             dbState: 'unreadable' };
  }
  if (f && f.on) {
    // `source` is 'allowlist' | 'percent' | 'all' — the ramp stage that
    // admitted this user. A job row that cannot say WHICH stage let it through
    // cannot tell an internal e2e from a customer in the percentage.
    return { allowed: true, reason: f.source, source: f.source, dbState: f.dbState || 'ok' };
  }
  // percent 0 AND enabled_all false AND not on the allowlist = THE KILL.
  return { allowed: false, reason: 'ramp_off', source: (f && f.source) || 'off',
           dbState: (f && f.dbState) || 'ok' };
}

/**
 * IS THIS USER FIRST-PARTY? -> { firstParty, source, dbState }
 *
 * B1's worker refuses customer traffic until Zac's written-permission record
 * exists, and marks a request exempt only on `first_party: true`. This answers
 * that question and nothing else.
 *
 * THE ALLOWLIST RUNG, NOT "THE RAMP SAID YES". rampAllows() returns true for
 * three different rungs — allowlist, percent, all — and two of them are
 * CUSTOMERS. A job that reached ChatCut through the percentage and then marked
 * itself first-party would be spending Zac's exemption on somebody else's
 * video, which is the one thing the gate exists to stop. So this reads
 * `source === 'allowlist'` and refuses every other answer, including `all`.
 *
 * FALSE ON ANYTHING UNREADABLE. An exemption we cannot prove is not an
 * exemption; B1's gate fails closed on absence and so does this.
 */
async function firstPartyFor({ userId, resolveFlag, log = console } = {}) {
  if (!userId) return { firstParty: false, source: 'no-user', dbState: null };
  let f = null;
  try {
    f = await resolveFlag(RAMP_FLAG, userId);
  } catch (e) {
    log.warn(`[chatcut-ramp] ${RAMP_FLAG} unreadable for first-party check `
      + `(${(e && e.message) || 'unknown'}) — treating as customer traffic`);
    return { firstParty: false, source: 'threw', dbState: 'unreadable' };
  }
  if (!f || f.dbState === 'unreadable') {
    return { firstParty: false, source: (f && f.source) || 'unknown', dbState: 'unreadable' };
  }
  return { firstParty: f.on === true && f.source === 'allowlist',
           source: f.source, dbState: f.dbState || 'ok' };
}

module.exports = { rampAllows, firstPartyFor, RAMP_FLAG, REASONS };

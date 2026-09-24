'use strict';
// THE RE-EDIT DECISION, AS A FUNCTION THE ROUTE CALLS.
//
// Module level and PURE so a test can drive it. A rule that lives inline in a
// route handler can only be exercised by reimplementing it, and then the test
// proves the reimplementation while the shipped path goes untested — already
// paid for twice in this repo (spec_shortfall, the re-edit merge).
//
// ── THE THREE RULES ────────────────────────────────────────────────────────
//   FREE      402 pro_required. Free has no re-edit at all, so the cap is
//             never consulted — a free user is refused BEFORE the count is
//             read, because "you have used 10 of 10" tells them a limit
//             applies to them that does not.
//   PRO/MAX   0 credits up to the cap, then a normal edit's price.
//   ALWAYS    a new version row; the parent is never mutated.
//
// ── THE CAP IS CONFIG AND ITS ABSENCE IS NOT ZERO ──────────────────────────
// A missing or unreadable cap falls back to DEFAULT_CAP, never to 0. Zero
// would mean "every re-edit is charged" and would arrive silently the first
// time the config read failed — charging users because a row could not be
// read is the expensive direction to be wrong in.

const DEFAULT_CAP = 10;
const PAID_TIERS = new Set(['pro', 'max']);

/** -> a positive integer cap. Never 0 from an absent value. */
function capFrom(flagValue) {
  const n = flagValue && typeof flagValue === 'object'
    ? Number(flagValue.per_video) : Number(flagValue);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CAP;
}

/**
 * -> { allow, charge, reason, cap, used } or a 402/409 shape.
 *
 * `used` is re-edits ALREADY COMPLETED for this video. In-flight is handled
 * by the database, not here — see conflictFrom().
 */
function decideReedit({ tier, used, capValue, now }) {
  const t = String(tier || '').toLowerCase();
  // FREE IS REFUSED BEFORE THE COUNT IS READ.
  if (!PAID_TIERS.has(t)) {
    return { allow: false, status: 402, error: 'payment_required',
             reason: 'pro_required', actions: ['upgrade'] };
  }
  const cap = capFrom(capValue);
  const n = Number.isInteger(used) && used >= 0 ? used : 0;
  if (n < cap) {
    return { allow: true, charge: 0, reason: 'within_free_reedits', cap, used: n,
             remaining: cap - n };
  }
  // PAST THE CAP IS NOT A REFUSAL. It is a normal edit's price, and the
  // caller quotes it the same way it quotes any edit — a re-edit that costs
  // money is still a re-edit, and 402ing here would end the path at ten.
  return { allow: true, charge: 'standard_edit', reason: 'cap_reached',
           cap, used: n, remaining: 0 };
}

/**
 * Translate the serialization constraint into an answer the client can act on.
 *
 * THE DATABASE IS THE GATE, and this only names what it said. Postgres reports
 * a partial-unique violation as 23505; PostgREST surfaces it with that code.
 * Returning 500 for it would read as an outage for a condition that is
 * ORDINARY — the user tapped twice, or two tabs are open.
 */
function conflictFrom(error) {
  const code = String((error && (error.code || error.status)) || '');
  const msg = String((error && error.message) || '');
  const isDup = code === '23505'
    || /duplicate key|unique constraint/i.test(msg);
  if (!isDup) return null;
  const mine = /one_inflight_reedit_per_project/i.test(msg)
    || /video_jobs_one_inflight/i.test(msg);
  return {
    status: 409,
    error: 'reedit_in_flight',
    // NAMED ONLY WHEN THE INDEX NAME CONFIRMS IT. A different unique
    // violation on the same insert is NOT "a re-edit is already running" —
    // saying so would send someone to wait for a render that is not there.
    reason: mine ? 'one_reedit_at_a_time' : 'conflict',
    retryable: true,
  };
}

module.exports = { decideReedit, capFrom, conflictFrom, DEFAULT_CAP, PAID_TIERS };

'use strict';
// REFERRAL LADDER AND CAP — the arithmetic, kept pure and testable.
//
// WHY THIS MOVED SERVER-SIDE (2026-08-29). The reward lived entirely in Postgres
// functions (grant_referral_reward, qualify_referral) that exist only in
// Supabase — no definition, no migration, no review, nothing in this repo. Two
// consequences that matter more than tidiness:
//
//   • The grant was UNCAPPED and UNAUDITED. There was no ledger of any kind, so
//     "how many free days have we given away" had no answer. Granted Pro is
//     unmetered renders, so an uncapped grant converts directly into GPU spend
//     with nothing to read afterwards.
//   • Anti-abuse at claim time lived inside a function we cannot see or gate,
//     while claim_referral is directly callable from the client with a user JWT.
//
// The ladder is here, pure and unit-tested, because it is the part that must not
// be wrong: it decides how much unmetered compute we hand out.

/// Each qualified referral earns a day. A referral QUALIFIES when the referred
/// user completes their first render — not when they sign up. That bar is
/// deliberate and load-bearing: signups are free to mint, so a signup ladder
/// converts throwaway email addresses into our render bill, and Apple's
/// guideline 3.2.2 targets incentivised installs specifically.
const DAYS_PER_QUALIFIED = 2;

/// Ruled 2026-08-29: 1 qualified referral pays 2 days, 3 pays 7 in total —
/// which is the week the database default and the unified copy already promise,
/// so the milestone reward is UNCHANGED and only the path to it changes. Two
/// per referral plus a 1-day bonus at the third gives 2 / 4 / 7.
///
/// The bonus stays at 3 because that is where the old scheme paid its ONLY
/// reward. Keeping the week intact while making the first invite pay is the
/// whole change: a user who shared once and succeeded previously got nothing
/// and learned the loop did not work.
///
/// The 14-day cap is then exactly two full rewards per rolling month, which is
/// why that number and this ladder have to be read together.
const BONUS_AT = 3;
const BONUS_DAYS = 1;

/// Hard ceiling per referrer per rolling 30 days. This is the number that
/// bounds the liability: 14 days of unmetered rendering is the most any one
/// account can extract in a month, however many referrals they produce.
///
/// ENFORCED AGAINST THE EXISTING LEDGER, not a new one. `referral_rewards`
/// already records every grant — user_id, days_granted, granted_at,
/// pro_until_before/after, and the referral_ids that earned it. I had designed
/// a second table before finding it; two ledgers for one payout is how a cap
/// gets enforced against half the total. The cap query is therefore:
///
///   SELECT COALESCE(SUM(days_granted), 0) FROM referral_rewards
///    WHERE user_id = $referrer AND granted_at > now() - interval '30 days'
///
/// which must run in the SAME transaction as the insert, or two concurrent
/// reconciles both read an under-count and both grant.
const CAP_DAYS_PER_30D = 14;

/**
 * Days earned by crossing from `priorQualified` to `priorQualified + newlyQualified`.
 *
 * Computed as a DIFFERENCE of cumulative totals rather than per-referral, so it
 * is idempotent under replay: reconciling twice with the same inputs yields the
 * same answer, and a batch that spans the bonus threshold pays the bonus exactly
 * once.
 */
function daysEarned(priorQualified, newlyQualified) {
  const prior = Math.max(0, Number(priorQualified) || 0);
  const added = Math.max(0, Number(newlyQualified) || 0);
  if (added === 0) return 0;
  return cumulativeDays(prior + added) - cumulativeDays(prior);
}

/** Total days a referrer has earned for `n` lifetime qualified referrals. */
function cumulativeDays(n) {
  const q = Math.max(0, Number(n) || 0);
  return q * DAYS_PER_QUALIFIED + (q >= BONUS_AT ? BONUS_DAYS : 0);
}

/**
 * Apply the rolling-30-day cap.
 *
 * Returns what may actually be granted plus WHY it was reduced, because a
 * silently truncated grant is indistinguishable from a small one — and the
 * difference is the whole point of having a cap. `capped` is what the caller
 * reports; `withheld` is what a user would otherwise be owed and is the number
 * worth watching if abuse starts.
 */
function applyCap(daysWanted, daysGrantedInWindow) {
  const want = Math.max(0, Number(daysWanted) || 0);
  const used = Math.max(0, Number(daysGrantedInWindow) || 0);
  const remaining = Math.max(0, CAP_DAYS_PER_30D - used);
  const grant = Math.min(want, remaining);
  return {
    grant,
    capped: grant < want,
    withheld: want - grant,
    remainingAfter: Math.max(0, remaining - grant),
  };
}

/** Milliseconds a grant of `days` should extend entitlement, from `nowMs`. */
function endTimeMs(days, nowMs) {
  const base = Number.isFinite(nowMs) ? nowMs : Date.now();
  return base + Math.max(0, Number(days) || 0) * 24 * 3600 * 1000;
}

/** Self-referral is the cheapest abuse there is; it is not a judgement call. */
function isSelfReferral(referrerId, referredId) {
  return Boolean(referrerId) && String(referrerId) === String(referredId);
}

module.exports = {
  DAYS_PER_QUALIFIED, BONUS_AT, BONUS_DAYS, CAP_DAYS_PER_30D,
  daysEarned, cumulativeDays, applyCap, endTimeMs, isSelfReferral,
};

'use strict';
// THE REFERRAL REWARD, as ruled 2026-09-05: three installs → seven days of Pro.
//
// An INSTALL is a referred account that claimed the code at sign-in (a row in
// `referrals`; the claim itself refuses the referrer's own device and any
// device that has already been referred). Nothing about renders, nothing
// about a `qualified_at` flag — the flag was settable by any authenticated
// caller for a while and the render rule paid nothing for two weeks because
// nothing computed it. Counting rows is the only definition every layer can
// agree on.
//
// Paid ONCE, when the count crosses three. Not per install, not again at six.
const REWARD_AT = 3;
const REWARD_DAYS = 7;
// Belt and braces against a mis-wired loop granting repeatedly: no more than
// this many days in any 30-day window, however many times reconcile runs.
const CAP_DAYS_PER_30D = 14;

/**
 * Days newly owed when `newlyEligible` installs are counted on top of
 * `priorCounted`. Zero unless this pass crosses the threshold and the
 * referrer has never been paid.
 */
function daysEarned(priorCounted, newlyEligible, alreadyRewarded = false) {
  const prior = Math.max(0, Number(priorCounted) || 0);
  const added = Math.max(0, Number(newlyEligible) || 0);
  if (alreadyRewarded || added === 0) return 0;
  return prior < REWARD_AT && prior + added >= REWARD_AT ? REWARD_DAYS : 0;
}

function applyCap(daysWanted, daysGrantedInWindow) {
  const want = Math.max(0, Number(daysWanted) || 0);
  const used = Math.max(0, Number(daysGrantedInWindow) || 0);
  const remaining = Math.max(0, CAP_DAYS_PER_30D - used);
  const grant = Math.min(want, remaining);
  return { grant, capped: grant < want, withheld: want - grant, remainingAfter: Math.max(0, remaining - grant) };
}

function endTimeMs(days, nowMs) {
  const base = Number.isFinite(nowMs) ? nowMs : Date.now();
  return base + Math.max(0, Number(days) || 0) * 24 * 3600 * 1000;
}

function isSelfReferral(referrerId, referredId) {
  return Boolean(referrerId) && String(referrerId) === String(referredId);
}

module.exports = { REWARD_AT, REWARD_DAYS, CAP_DAYS_PER_30D, daysEarned, applyCap, endTimeMs, isSelfReferral };

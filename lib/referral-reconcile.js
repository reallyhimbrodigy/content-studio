'use strict';
// Decide what a referrer is owed from their `referrals` rows alone.
//
// Eligible = a claimed row not yet counted and not a self-referral. The device
// rules live in `claim_referral` (a row that exists has already passed them),
// so this stays a pure function of the rows: easy to smoke, impossible to
// disagree with the database.
const { daysEarned, applyCap, isSelfReferral } = require('./referral-rewards');

function reconcile({ referrerId, referrals, priorCounted, alreadyRewarded, grantedInWindow }) {
  const rows = Array.isArray(referrals) ? referrals : [];
  const eligible = [];
  const rejected = [];
  for (const r of rows) {
    if (r.counted_at) continue;                         // already counted; not an error
    if (isSelfReferral(referrerId, r.referred_id)) { rejected.push({ referred_id: r.referred_id, reason: 'self_referral' }); continue; }
    eligible.push({ referred_id: r.referred_id });
  }
  const prior = Math.max(0, Number(priorCounted) || 0);
  const wanted = daysEarned(prior, eligible.length, Boolean(alreadyRewarded));
  const cap = applyCap(wanted, grantedInWindow);
  return {
    eligible, rejected, days: cap.grant, cap,
    countedAfter: prior + eligible.length,
    reason: eligible.length === 0 ? 'nothing_new'
      : wanted === 0 ? (alreadyRewarded ? 'already_rewarded' : 'below_threshold')
      : (cap.capped ? 'capped' : 'granted'),
  };
}

module.exports = { reconcile };

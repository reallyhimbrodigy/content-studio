'use strict';
// REFERRAL RECONCILE — decide what a referrer has earned, without trusting the
// flag that says they earned it.
//
// THE QUESTION THAT SHAPED THIS. `referrals.qualified_at` is what the old
// scheme paid against, and nothing in either tree writes it — qualification
// happens inside the database. A probe of the PostgREST surface shows ZERO RPCs
// exposed to the `anon` role, but the client calls claim_referral with a USER
// JWT, so the `authenticated` role must hold EXECUTE on at least one of these
// functions. Which of them, exactly, cannot be enumerated without SQL access.
//
// That uncertainty is not worth carrying into a payout path, and it does not
// have to be: if qualification were reachable by a logged-in user, the cap would
// bound the payout while the ledger recorded capped grants against referrals
// that were never earned. So this does not trust `qualified_at` at all.
//
// INSTEAD: a referral counts only when the REFERRED USER ACTUALLY HAS A
// COMPLETED RENDER. That is the fact `qualified_at` is supposed to represent,
// and it is checked directly against video_jobs. A flag can be set; a completed
// render costs GPU time and cannot be forged by calling a function. Verifying
// the fact rather than the marker is the same discipline that caught
// source_type=NULL being tautological and picker_asset_unresolved being
// unfilterable — read the thing itself, not the thing that claims it.
//
// Pure: takes rows, returns decisions. The caller performs the writes so the
// ledger insert and the cap check land in one transaction.

const { daysEarned, applyCap, isSelfReferral } = require('./referral-rewards');

/**
 * @param {object}   input
 * @param {string}   input.referrerId
 * @param {Array}    input.referrals        rows: { referred_id, qualified_at, counted_at }
 * @param {Set}      input.referredWithRender  referred_ids CONFIRMED to have a completed render
 * @param {number}   input.priorCounted     lifetime referrals already counted for this referrer
 * @param {number}   input.grantedInWindow  days already granted in the rolling window
 * @returns {{ eligible:Array, rejected:Array, days:number, cap:object, reason:string }}
 */
function reconcile({ referrerId, referrals, referredWithRender, priorCounted, grantedInWindow }) {
  const rows = Array.isArray(referrals) ? referrals : [];
  const confirmed = referredWithRender instanceof Set ? referredWithRender : new Set(referredWithRender || []);

  const eligible = [];
  const rejected = [];

  for (const r of rows) {
    if (r.counted_at) continue;                     // already paid; not an error
    const id = r.referred_id;

    // Self-referral: the cheapest abuse, and free to check.
    if (isSelfReferral(referrerId, id)) {
      rejected.push({ referred_id: id, reason: 'self_referral' });
      continue;
    }
    // THE INDEPENDENT CHECK. qualified_at may be set; we do not care unless the
    // render exists. A referral marked qualified with no completed render is
    // reported rather than silently skipped — if that count is ever non-zero,
    // qualification is reachable by something that is not a render, and that is
    // a finding, not noise.
    if (!confirmed.has(id)) {
      rejected.push({
        referred_id: id,
        reason: r.qualified_at ? 'qualified_without_render' : 'not_yet_qualified',
      });
      continue;
    }
    eligible.push({ referred_id: id });
  }

  const prior = Math.max(0, Number(priorCounted) || 0);
  const wanted = daysEarned(prior, eligible.length);
  const cap = applyCap(wanted, grantedInWindow);

  return {
    eligible,
    rejected,
    days: cap.grant,
    cap,
    reason: eligible.length === 0
      ? 'nothing_newly_earned'
      : (cap.capped ? 'capped' : 'granted'),
  };
}

/**
 * Rows that claim qualification without a render. Surfaced separately because
 * a non-zero count here means the qualification path is reachable by something
 * other than finishing a video — which is the exact hole the independent check
 * exists to make visible rather than merely survive.
 */
function suspiciousQualifications(result) {
  return (result.rejected || []).filter((r) => r.reason === 'qualified_without_render');
}

module.exports = { reconcile, suspiciousQualifications };

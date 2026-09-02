'use strict';

// ── FREE-TIER CREDITS — the decisions, separated from the I/O ────────────────
//
// Everything here is PURE so it can be tested without a database or a
// RevenueCat key. The orchestration (reads, inserts, the RC credit) lives at the
// call sites in server.js, exactly as the reverse-trial grant does.
//
// WHAT THIS IS FOR. Free users have no subscription product, so RevenueCat's
// recurring virtual-currency grant — which is what gives Pro 200 and Max 1000 on
// renewal — has nothing to hang on. The free 30 is therefore the one allowance
// this server has to grant itself.
//
// WHY THERE IS NO CRON. Granting to every free profile monthly is O(registered):
// 19,478 accounts today against 5,480 that rendered in the last 30 days, growing
// ~14k/month, and RevenueCat rate-limits virtual-currency endpoints to 480
// req/min. The roll is LAZY instead — checked at the debit site and the balance
// read — which is O(active), needs no scheduler, and self-heals a missed month
// on next use. A cron that fails silently leaves users at zero.

const FREE_MONTHLY_ALLOWANCE = 30;

/**
 * The allowance period a moment belongs to: a UTC calendar month, 'YYYY-MM'.
 *
 * Calendar rather than a rolling 30 days from each user's first grant: a
 * per-user anchor drifts, needs its own column, and makes "did this account
 * already get this period" a range query instead of an equality. As a text key
 * it is directly comparable and sorts correctly.
 *
 * UTC on purpose. A local-time boundary would grant twice to a user who crosses
 * a timezone at month end.
 */
function periodKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

/**
 * How much to credit to bring `balance` up to `allowance`.
 *
 * TOP UP TO, NEVER ADD. Adding a flat 30 every period accumulates without bound
 * for anyone who does not spend — the exact thing RevenueCat's auto-expire
 * toggle exists to prevent for subscription grants, which we cannot use here.
 *
 * AND NEVER DOWN. A user sitting ABOVE the allowance is holding credits they
 * bought as a top-up, or Pro credits from before a lapse. Returning 0 rather
 * than a negative delta means the monthly free grant can never confiscate
 * something a user paid for.
 */
function topUpDelta(balance, allowance = FREE_MONTHLY_ALLOWANCE) {
  const b = Number.isFinite(balance) ? balance : 0;
  const a = Number.isFinite(allowance) ? allowance : FREE_MONTHLY_ALLOWANCE;
  return b >= a ? 0 : a - b;
}

/**
 * What to do with a device presenting itself for the free grant.
 *
 * `row` is the existing free_credit_grants row for this device_id, or null.
 * Callers MUST distinguish a null row from a failed read before calling this —
 * a failed read that arrives here as null reads as 'claim' and re-grants. That
 * is the absence-versus-failure shape this codebase keeps paying for, and it is
 * the caller's job because only the caller can see the error.
 */
function decideDeviceClaim({ row, userId }) {
  if (!row) return { action: 'claim', reason: 'unseen_device' };
  if (row.user_id !== userId) {
    // A DIFFERENT account on a device that already seeded one. This is the
    // multi-account case the PK exists for: one phone, N accounts, 30 each.
    return { action: 'conflict', reason: 'device_claimed_by_other' };
  }
  return { action: 'already_claimed', reason: 'same_user' };
}

/**
 * Whether this account still needs its allowance for `period`.
 *
 * `periodRow` is the free_credit_periods row for (user_id, period), or null.
 * Same null-versus-error rule as above.
 */
function decidePeriodGrant({ periodRow, period, currentPeriod }) {
  if (period !== currentPeriod) return { action: 'skip', reason: 'not_current_period' };
  if (periodRow && periodRow.provider_ok === true) {
    return { action: 'skip', reason: 'already_granted' };
  }
  if (periodRow && periodRow.provider_ok === false) {
    // Claimed but never landed at RevenueCat — the credit failed after the row
    // was written. Retrying is CORRECT and safe: topUpDelta is computed from
    // the live balance, so a retry after a credit that actually succeeded
    // computes a delta of 0 and grants nothing.
    return { action: 'retry', reason: 'claimed_not_landed' };
  }
  return { action: 'grant', reason: 'new_period' };
}

module.exports = {
  FREE_MONTHLY_ALLOWANCE,
  periodKey,
  topUpDelta,
  decideDeviceClaim,
  decidePeriodGrant,
};

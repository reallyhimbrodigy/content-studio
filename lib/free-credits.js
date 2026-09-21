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

/**
 * The build number out of a client version string like "1.3.25 (243)".
 * null when absent or unparseable — and callers MUST treat null as "do not
 * charge", never as "charge anyway".
 */
function parseBuild(appVersion) {
  const m = String(appVersion || '').match(/\((\d+)\)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isInteger(n) ? n : null;
}

/**
 * THE DEBIT BUILD FLOOR — may this client be charged credits?
 *
 * WHY IT EXISTS. Credits can only be GRANTED to a build that can claim a device
 * (the free-grant endpoint refuses below FREE_CREDITS_MIN_BUILD). Charging a
 * build that cannot be granted is charging against a balance that can never
 * exist. Recent renders span builds 224-243 and a new cut moves the installed
 * base slowly, so without this, arming the debit 402s nearly every free user
 * until they happen to upgrade.
 *
 * ONE ENV VAR WAS SUPPOSED TO GOVERN BOTH SIDES — and it could not. The env
 * floor decides whether the SERVER will accept a claim. It says nothing about
 * whether the CLIENT makes one, and that is a property of the shipped binary.
 * See CLIENT_CLAIM_MIN_BUILD: build 246 was cut 22.6 hours before the caller
 * existed, so with the env floor at 245 every free user on 246 was chargeable
 * and permanently ungrantable — refused at the wall on 30 credits they were
 * never given. The effective floor is now max(env, CLIENT_CLAIM_MIN_BUILD), so
 * the env can only ever make it STRICTER.
 *
 * FAILS OPEN, DELIBERATELY, IN BOTH DIRECTIONS:
 *   - floor unset  -> no charge (the feature ships dark, same as the endpoint)
 *   - build unreadable -> no charge
 * An unreadable version header must let the render through free rather than
 * 402 a user we cannot identify. Leaking a free render is recoverable; refusing
 * a paying customer over a missing header is not, and it would fail silently
 * across whatever client stopped sending it.
 */
/**
 * THE FIRST BUILD WHOSE CLIENT ASKS FOR THE GRANT.
 *
 * The monthly free 30 is gated on a device claim, and the claim only happens if
 * the app calls POST /api/credits/free-grant. That caller
 * (CreditsService.claimFreeGrantIfNeeded, reached from AuthService.saveSession
 * and CreditBadge.seed) landed 2026-09-05 14:50 PDT. Build 246 was cut
 * 2026-09-04 16:13 PDT — 22.6 hours earlier — so the 246 binary carries the
 * server half and no caller. Build 247 was cut 43 minutes after the caller, and
 * its own commit message calls itself "the grant fix".
 *
 * MEASURED, not reasoned: since 2026-09-05, build 246 has 882 signed-in active
 * users and ONE device claim — recorded 44 minutes BEFORE the caller was
 * committed, so a development build rather than the shipped one. Every build
 * from 247 up claims at 25-100% of its active users.
 *
 * This is a fact about a binary, so it lives in code where an operator cannot
 * set it lower. Raising it is correct when a still-newer client is required;
 * lowering it charges users who cannot be granted.
 */
const CLIENT_CLAIM_MIN_BUILD = 247;

/**
 * The floor actually applied: never below the build that can ask for a grant.
 * Returns null when the feature is dark (env unset), preserving ship-dark.
 */
function effectiveDebitFloor(envFloor) {
  if (!Number.isInteger(envFloor)) return null;
  return Math.max(envFloor, CLIENT_CLAIM_MIN_BUILD);
}

function debitApplies({ build, minBuild }) {
  const floor = effectiveDebitFloor(minBuild);
  if (floor === null) return false;
  if (!Number.isInteger(build)) return false;
  return build >= floor;
}

module.exports = {
  FREE_MONTHLY_ALLOWANCE,
  periodKey,
  topUpDelta,
  decideDeviceClaim,
  decidePeriodGrant,
  parseBuild,
  debitApplies,
  effectiveDebitFloor,
  CLIENT_CLAIM_MIN_BUILD,
};

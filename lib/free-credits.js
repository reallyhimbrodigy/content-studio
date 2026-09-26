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

// REVERSAL, 2026-09-22: 30 until today, 10 now, alongside free dropping from
// three videos a month to one. The prose above still argues the 30 case and is
// LEFT STANDING as the record of what was believed when it was written — a
// silently corrected justification is the one an agent re-derives next time
// instead of checking.
const FREE_MONTHLY_ALLOWANCE = 10;

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
 * The floor actually applied.
 *
 * THE CLAMP IS ABOUT GRANTABILITY, AND GRANTABILITY IS A FREE-USER PROPERTY.
 * CLIENT_CLAIM_MIN_BUILD exists because a free user's balance comes from a
 * DEVICE CLAIM the client has to make, so charging a build with no caller
 * charges against a balance that can never exist. Every word of that
 * reasoning is about free users — and the clamp was being applied to paid
 * ones, whose balance comes from RevenueCat's grant and has nothing to do
 * with which binary they are running.
 *
 * MEASURED 2026-09-24, paid first edits since metering armed on 2026-09-07:
 *
 *     build band     paid edits   uncharged   users   credits taken
 *     < 245                  25          25       1               0   by design
 *     245-246               109         106      12              30   <-- THE LEAK
 *     >= 247                 70           0      10             700   working
 *
 * 106 paid renders across 12 users, roughly 1,060 credits, uncharged because
 * of a rule whose justification does not apply to them. It also explains the
 * "metering ramp" I reported as arming: 25% -> 54% -> 65% was never a ramp,
 * it was the BUILD MIX moving. Where the floor lets it work, metering is
 * 70/70.
 *
 * So `isPaid` splits the two rules rather than sharing one number:
 *   free  -> max(env, CLIENT_CLAIM_MIN_BUILD)   unchanged, still protected
 *   paid  -> env floor alone                    their balance already exists
 *
 * This is the set-named-for-the-schedule shape from CLAUDE.md: the gate said
 * "build >= 247" and the property was "can this user hold a balance". They
 * agreed for every free user, which is why it read as correct.
 *
 * Returns null when the feature is dark (env unset), preserving ship-dark.
 */
function effectiveDebitFloor(envFloor, { isPaid = false } = {}) {
  if (!Number.isInteger(envFloor)) return null;
  return isPaid ? envFloor : Math.max(envFloor, CLIENT_CLAIM_MIN_BUILD);
}

function debitApplies({ build, minBuild, isPaid = false }) {
  const floor = effectiveDebitFloor(minBuild, { isPaid });
  if (floor === null) return false;
  // AN UNREADABLE BUILD STILL FAILS OPEN, FOR BOTH TIERS. Refusing a paying
  // customer over a missing version header is not recoverable; leaking one
  // render is. That half of the original reasoning does apply to everyone.
  if (!Number.isInteger(build)) return false;
  return build >= floor;
}

/**
 * DID THE ROLL FAIL FOR A REASON THAT IS OURS? (Zac's (c), 2026-09-25.)
 *
 * THE DEFECT THIS CLOSES. The lazy roll runs immediately before the debit and
 * NEVER THROWS — every failure returns a reason string. The debit site ignored
 * the reason and debited anyway. So when the roll could not establish a grant
 * because RevenueCat was unreachable, or a read failed, the user reached
 * RevenueCat with no balance, got the documented 422, and the server answered
 *
 *     402 "You've used all 1 videos in your plan this month."
 *
 * to a user who was never granted anything. MEASURED: 4 distinct users in 7
 * days have a debited job and no landed grant for the period.
 *
 * TOLD NO versus COULD NOT ASK — the same distinction the upload-knob contract
 * needed and the same one lib/credits.js already draws between INSUFFICIENT and
 * UNREACHABLE. A 402 is a statement about the user's balance. If we could not
 * read the balance, or could not grant against it, we have no such statement to
 * make and the honest answer is the retryable 503 the site already has for
 * exactly this.
 *
 * `no_device_claim` IS NOT HERE, DELIBERATELY. That is the anti-abuse gate
 * working: an account with no claimed device is one we have decided not to
 * grant, which is a product decision and a real "no". Whether its 402 copy
 * should differ is Zac's call, not this function's — and quietly 503ing it would
 * turn a deliberate refusal into an apparent outage.
 *
 * `paid_tier`, `already_granted`, `not_current_period` are all correct no-ops:
 * the user's allowance exists or is not ours to grant. They must NOT block.
 */
const ROLL_REASONS_OURS = new Set([
  'rc_unreachable',      // the provider did not answer — not the user's problem
  'claim_read_failed',   // could not read the device claim
  'period_read_failed',  // could not read the period row
  'period_claim_lost',   // a concurrent request is granting; its money is not
                         // in place yet, so a debit now 402s on a race
  'exception',           // anything unforeseen inside the roll
  'no_db',               // no database to ask
  'credits_not_configured',
]);

function rollBlocksDebit(reason) {
  // A MISSING REASON BLOCKS. An absent reason is not "fine" — it is a roll whose
  // outcome we cannot read, and on a spend path that fails closed. This is the
  // same rule as the unreadable flag on the upload knobs: never spend on a
  // switch you could not read.
  if (reason === undefined || reason === null || reason === '') return true;
  return ROLL_REASONS_OURS.has(String(reason));
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
  ROLL_REASONS_OURS,
  rollBlocksDebit,
};

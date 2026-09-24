'use strict';
//
// THE FREE TIER ON A CALLER-LESS BUILD WAS UNCAPPED PER MONTH.
//
// MEASURED (Zac, 2026-09-24): this month, free tier on builds under 247 —
// 808 users, 918 completed videos, 0 debited. At least 110 videos beyond one
// each; some accounts between 3 and 23. The daily cap (3/day) was the only
// limiter, and a daily cap is not a monthly one.
//
// WHY THOSE BUILDS HAVE NOTHING. Credits can only be GRANTED to a build that
// can claim a device, and the claiming caller first shipped in 247. So a free
// user below 247 has no balance to charge — `debitApplies` correctly returns
// false, `creditsAreTheLimiter` is false, and the request falls through to the
// daily cap. "Free on 246 charged: false" is right about credits and says
// nothing about volume. Nothing limited volume.
//
// On the old pipeline that is small money. On ChatCut every video spends from
// a fixed pool of ~5,000 credits a month, so it closes before customer traffic
// reaches ChatCut.
//
// THE REFUSAL SHAPE IS NOT A CHOICE — it is read out of the 246 binary.
// APIService.swift at 8aa237d ("1.3.27 (246)") decodes a 402 on the render
// path as {kind, limit, message, error, needed, balance_known} and routes:
//
//     if error == "insufficient_credits" || kind == "credits"
//         -> insufficientCredits(needed:balanceKnown:)      << states a BALANCE
//     else
//         -> paymentRequired(kind:limit:message:)           << renders `message`
//
// So the refusal below carries kind:'render' and an `error` that is NOT
// "insufficient_credits", which lands it in the branch that renders our copy
// verbatim. A 402 in the credits branch would state a balance that cannot
// exist for a build with no claim path — the confident-zero mistake, told to
// the user.

// One completed video per calendar month (Zac 2026-09-24). Env-overridable so
// the number can move without a code change; the DEFAULT is the ruling.
const FREE_MONTHLY_VIDEOS = 1;
const USAGE_KIND = 'render_free_month';

/** The ruled cap, or the env override when it is a sane positive integer. */
function monthlyLimit(env = process.env) {
  const raw = parseInt(env.FREE_MONTHLY_VIDEO_CAP || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : FREE_MONTHLY_VIDEOS;
}

/** Off only by explicit kill-switch. The leak is the reason this exists. */
function capEnabled(env = process.env) {
  return String(env.FREE_MONTHLY_CAP_ENABLED ?? '1') !== '0';
}

/**
 * Does the monthly cap govern THIS request?
 *
 * Returns a STATE, never a bare boolean, because "does not apply" has three
 * different causes and collapsing them is how an inert feature hides:
 *   APPLIES            — free tier, caller-less build: this cap is the limiter
 *   NOT_FREE           — paid/comped: credits or nothing governs, never this
 *   HAS_CLAIM_PATH     — build >= 247: credits are the limiter, untouched
 *   BUILD_UNKNOWN      — unparseable client version
 *   DISABLED           — kill-switch
 *
 * BUILD_UNKNOWN FAILS OPEN, deliberately and narrowly. An unreadable version
 * header must not cap a paying-adjacent user at one video a month on our
 * guess; debitApplies() already fails open on the same input for the same
 * reason, and the two must not disagree about what "unknown build" means.
 */
function capState({ isFree, build, claimMinBuild, env = process.env } = {}) {
  if (!capEnabled(env)) return 'DISABLED';
  if (!isFree) return 'NOT_FREE';
  if (!Number.isInteger(build)) return 'BUILD_UNKNOWN';
  if (!Number.isInteger(claimMinBuild)) return 'BUILD_UNKNOWN';
  if (build >= claimMinBuild) return 'HAS_CLAIM_PATH';
  return 'APPLIES';
}

const capApplies = (args) => capState(args) === 'APPLIES';

/**
 * The 402 body. `proVideos` is the Pro promise in the unit the user was sold.
 *
 * NO `needed`, NO `balanceKnown`, NO kind:'credits' — see the header. This
 * refusal is about VOLUME, and a build with no claim path has no balance for
 * a credits refusal to be about.
 */
function refusalBody({ limit, proVideos } = {}) {
  const n = Number.isInteger(limit) ? limit : FREE_MONTHLY_VIDEOS;
  return {
    // Read by newer clients; 246 ignores it unless it is "insufficient_credits".
    error: 'monthly_limit_reached',
    kind: 'render',
    limit: n,
    // The window, named. `limit: 1` alone reads as a daily cap to anyone
    // looking at a log, and that is the wrong story to tell twice.
    window: 'month',
    message: n === 1
      ? `You've used your free video for this month.${proVideos ? ` Pro includes ${proVideos} videos a month.` : ''}`
      : `You've used all ${n} free videos this month.${proVideos ? ` Pro includes ${proVideos} videos a month.` : ''}`,
  };
}

/**
 * THE NEW-SUBSCRIBER RACE (Zac, 2026-09-24).
 *
 * The client auto-sends a free user's kept re-edit the instant StoreKit
 * confirms Pro. profiles.tier updates from the RevenueCat webhook, which can
 * land seconds later — so the first request from someone who has just paid can
 * hit a free-tier refusal.
 *
 * assertProEntitled already re-checks RevenueCat before returning a denial
 * (grant-only, throttled, and it admits `max` as well as `pro` —
 * lib/entitlement.js resolves a customer holding ONLY the max entitlement).
 * What it did not do is report WHETHER that check succeeded. A refusal site
 * reading only the VALUE cannot tell "RC says free" from "RC never answered",
 * and those are different failures: one is the user's, the other is ours.
 *
 * So the entitlement decision carries an rcCheck STATE and every free-tier
 * refusal asks this function what that state permits:
 *
 *   FAILED  -> 503 retryable. Never a 402 against someone who may have paid,
 *              and never a 500: this is a dependency being unreachable, which
 *              is a retry, not a bug report.
 *   others  -> the refusal stands.
 */
const RC_STATES = ['NOT_NEEDED', 'SKIPPED_THROTTLED', 'GRANTED', 'NEGATIVE', 'FAILED'];

function refusalForRcState(rcCheck, refusal) {
  if (rcCheck === 'FAILED') {
    return {
      status: 503,
      body: {
        error: 'entitlement_unavailable',
        kind: 'entitlement',
        retryable: true,
        message: 'We could not confirm your subscription just now. Please try again in a moment.',
      },
    };
  }
  return { status: 402, body: refusal };
}

module.exports = {
  FREE_MONTHLY_VIDEOS, USAGE_KIND, RC_STATES,
  monthlyLimit, capEnabled, capState, capApplies, refusalBody, refusalForRcState,
};

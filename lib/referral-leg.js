'use strict';

// Referral qualification + reward leg (owner instruction 2026-08-21).
//
// THE HOOK: the non-terminal -> 'completed' CAS transition in server.js. That
// update is consumed EXACTLY ONCE per job (`wonCompletedTransition`), which is
// the same guarantee the lifecycle push rides. So a job qualifies its referral
// once, no matter how many progress events the worker sends or how many writers
// race — the same reason the push is gated there rather than on the step label.
//
// THE CHAIN, and where it currently stops:
//   1. get_or_create_referral_code(p_user)   -> a user's shareable code
//   2. claim_referral(p_code, p_referred)    -> writes the `referrals` row
//   3. qualify_referral(p_referred, p_job)   -> stamps qualified_at + job   <- HERE
//   4. grant_referral_reward(p_user)         -> writes `referral_rewards`   <- HERE
//
// MEASURED 2026-08-21, before writing a line of this: steps 1 and 2 have NO
// caller anywhere in this repo, and `referrals` holds 0 rows. So 3 and 4 have
// nothing to act on and will report zero for every user until a claim surface
// exists. That is not a reason to skip the wiring — it IS the wiring that makes
// the zero legible — but it is the reason the counter below reports
// `qualified` and `granted` separately from `attempted`. A leg that fires 200
// times a day and grants nothing must SAY so; the alternative is the class of
// feature that ships green and does nothing for a month.
//
// IDEMPOTENCY IS THE RPC'S, AND IS NOT VERIFIED HERE. The owner states both
// functions are idempotent and safe to call every time. Their bodies were
// created out-of-band — there is no migration in this repo and PostgREST does
// not expose function source — so this module cannot confirm it, and
// grant_referral_reward writes real Pro days (`days_granted`,
// `pro_until_before` -> `pro_until_after`). The counter is therefore built to
// make a NON-idempotent grant obvious within one reporting window rather than
// to defend against it: `referral_reward_granted` carries days_granted and the
// before/after, so a second grant to the same user is visible as a second row
// with a moved pro_until_before.
//
// FIRE-AND-FORGET: a referral failure must never touch the render success path.
// The user's video is ready; a reward RPC erroring is our problem, not theirs.

/**
 * Qualify a referral on a completed render, then grant any reward owed.
 *
 * Both RPCs are called unconditionally, per the owner instruction that both are
 * idempotent. The qualify result is inspected only for TELEMETRY — never to
 * gate the grant — so the counter can distinguish "fired and there was nothing
 * to do" from "fired and paid", which is the whole point of the counter.
 *
 * @param {object} supabaseAdmin service-role client
 * @param {{userId: string, jobId: string}} args
 * @returns {Promise<{attempted: boolean, qualified: boolean, granted: boolean, error: string|null}>}
 */
async function qualifyAndRewardReferral(supabaseAdmin, { userId, jobId } = {}) {
  const out = { attempted: false, qualified: false, granted: false, error: null };
  if (!supabaseAdmin || !userId || !jobId) {
    out.error = 'missing supabaseAdmin, userId or jobId';
    return out;
  }
  out.attempted = true;

  let qualifyResult = null;
  let grantResult = null;

  try {
    // Param names are the RPC's own: p_referred is the user who just rendered
    // (the REFERRED party), p_job is the render that qualified them.
    const { data, error } = await supabaseAdmin.rpc('qualify_referral', {
      p_referred: userId,
      p_job: jobId,
    });
    if (error) throw new Error(`qualify_referral: ${error.message}`);
    qualifyResult = data ?? null;
    out.qualified = _truthy(qualifyResult);
  } catch (err) {
    out.error = err.message;
    console.error(`[referral] qualify FAILED job=${jobId} user=${userId}: ${err.message}`);
    // Fall through: the grant is independent and may still owe this user a
    // reward from an EARLIER qualified referral. Skipping it on a qualify
    // error would make a transient failure permanently cost a payout.
  }

  try {
    const { data, error } = await supabaseAdmin.rpc('grant_referral_reward', {
      p_user: userId,
    });
    if (error) throw new Error(`grant_referral_reward: ${error.message}`);
    grantResult = data ?? null;
    out.granted = _truthy(grantResult);
  } catch (err) {
    out.error = out.error ? `${out.error}; ${err.message}` : err.message;
    console.error(`[referral] grant FAILED job=${jobId} user=${userId}: ${err.message}`);
  }

  // Grep-stable line. `granted=false` on every job is the EXPECTED reading
  // until a claim surface exists, and saying so here keeps the zero honest
  // rather than silent.
  console.log(
    `[referral] job=${jobId} user=${userId} qualified=${out.qualified} `
    + `granted=${out.granted}${out.error ? ` error=${out.error}` : ''}`
  );

  await _count(supabaseAdmin, {
    userId, jobId, out, qualifyResult, grantResult,
  });
  return out;
}

// A reward is only real if it is COUNTED. Two events, not one: `attempted`
// gives the denominator (Rule 2 — a zero means nothing without what it is zero
// OUT OF), `granted` is the numerator and carries the payout shape so a
// double-grant shows up as a second row rather than as silence.
async function _count(supabaseAdmin, { userId, jobId, out, qualifyResult, grantResult }) {
  try {
    const rows = [{
      event: 'referral_qualify_attempted',
      platform: 'server',
      props: {
        job_id: String(jobId),
        user_id: String(userId),
        qualified: !!out.qualified,
        granted: !!out.granted,
        error: out.error || null,
      },
    }];
    if (out.granted) {
      rows.push({
        event: 'referral_reward_granted',
        platform: 'server',
        props: {
          job_id: String(jobId),
          user_id: String(userId),
          // Whatever the RPC hands back — days, before/after, referral ids.
          // Kept RAW rather than reshaped: a payout audit that reformats its
          // source cannot be reconciled against referral_rewards later.
          grant_result: _small(grantResult),
          qualify_result: _small(qualifyResult),
        },
      });
    }
    await supabaseAdmin.from('analytics_events').insert(rows);
  } catch (err) {
    // A counter failing must not fail the leg, but it must not be silent
    // either — an uncounted reward is an unreportable one.
    console.error(`[referral] counter insert failed job=${jobId}: ${err.message}`);
  }
}

function _truthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (v === true) return true;
  if (typeof v === 'number') return v > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  if (typeof v === 'string') return v !== '' && v !== 'false';
  return Boolean(v);
}

// Bound what lands in props — an RPC could return a large row set and
// analytics_events is not the place to discover that.
function _small(v) {
  try {
    const s = JSON.stringify(v ?? null);
    return s && s.length > 2000 ? { truncated: true, head: s.slice(0, 2000) } : (v ?? null);
  } catch {
    return null;
  }
}

module.exports = { qualifyAndRewardReferral };

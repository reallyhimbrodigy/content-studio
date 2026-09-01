'use strict';

const _credits = require('./credits');

// Generalized refund leg (Frontend Wave 1, item 1) — review-hardened, marker-gated.
//
// THE LAW (Zac ruling 2026-07-11, supersedes mark-gated eligibility): a refund
// fires on EVERY transition to a terminal failure state, regardless of source —
// worker-reported error (RENDER_FATAL, timeouts), designed rejection, reaper
// stall. Users pay for renders, not failures. ONE hook: this sweep picks up any
// failed primary row within a cycle (~60s of the transition); the reaper and
// cancel paths refund inline for immediacy but land on the same claim gate, so
// every route is idempotent against every other.
//
// DURABLE IDEMPOTENCY (zero over-refund): each job carries an app-owned
// `refunded_at` marker (migration 2026-07-06). The leg CLAIMS a job by flipping
// refunded_at NULL -> now() ATOMICALLY; only the winning pass proceeds to delete
// the charge, and the sweep never selects a claimed job again. So every job gets
// exactly ONE shot at the leg — the deleted-sibling repeat-eating residual is
// structurally impossible (a refunded job never re-sweeps to eat an orphan).
// Transient DB errors during charge deletion UNCLAIM the job so it retries.
//
// FIRST-PASS CORRECTNESS (right charge on that one shot): usage_events is not
// job-linked, so the leg attributes a charge to its job by time and deletes only:
//   - within the DELETE cap (800 ms), and
//   - when THIS job is the nearest existing job to that charge (attribution).
// A job whose own charge is already gone (manual-era refund) claims + no-ops and
// stays marked — correct and one-shot.
//
// CAP CALIBRATION (2026-07-11 W4 measurement, n=40 completed): the render charge
// is minted just BEFORE the job row (charge-then-insert), so charge.created_at -
// job.created_at is NEGATIVE: min -521ms, p50 -79ms, p90 -36ms. The old 400ms cap
// (set from a wrong "mints 33-181ms AFTER" assumption) left ~2.5% of jobs — the
// far-charge tail — CLAIMED-but-not-returned (a silent under-refund the refunded_at
// census can't see). 800ms covers the observed -521ms max with ~1.5x margin and
// stays well inside the 1500ms match + 2500ms sibling windows; the attribution
// guard (nearest-existing-job) — not the cap — is what prevents grabbing a
// sibling's charge, so widening the cap is safe.

const CHARGE_MATCH_WINDOW_MS = 1500;   // candidate search radius
const DELETE_DELTA_CAP_MS = 800;       // hard cap: charge minted -33..-521ms before job (W4 meas.), 1.5x margin
const SIBLING_WINDOW_MS = 2500;        // attribution: sibling-job search radius
const LOOKBACK_HOURS = 48;
// Three tries, then dead-letter. Bounded because an UNBOUNDED retry is what
// produced a ~2s error loop running for two days.
const MAX_REFUND_ATTEMPTS = 3;

/**
 * Claim + refund one job. Claim (refunded_at NULL -> now) is the one-shot gate;
 * the charge deletion is best-effort within cap + attribution. Returns an outcome.
 */
async function refundJobCharge(supabaseAdmin, job) {
  const jobMs = new Date(job.created_at).getTime();

  // --- CLAIM: atomic one-shot gate. Only the winner of the NULL->now flip proceeds.
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from('video_jobs')
    .update({ refunded_at: new Date().toISOString() })
    .eq('id', job.id)
    .is('refunded_at', null)
    .select('id');
  if (claimErr) return { job: job.id, action: 'error', detail: claimErr.message };
  if (!Array.isArray(claimed) || claimed.length === 0) {
    return { job: job.id, action: 'noop-already-handled' }; // a prior/concurrent pass owns it
  }

  // BOUNDED unclaim. Releasing the claim on a transient error is right — that is
  // how a refund survives a blip. Releasing it UNCONDITIONALLY is what turned one
  // bad row into an infinite loop, because the released row matches the sweep's
  // own `refunded_at IS NULL` predicate on the very next pass.
  //
  // So every failure now RECORDS something. Past the cap the row stays CLAIMED —
  // dead-lettered rather than retried — which is the only state that removes it
  // from the set without pretending it was refunded. refund_last_error keeps the
  // reason visible, because a row that silently stops retrying is its own bug.
  const unclaim = async (detail) => {
    const attempts = Number(job.refund_attempts || 0) + 1;
    const patch = { refund_attempts: attempts,
                    refund_last_error: String(detail || '').slice(0, 500) };
    if (attempts >= MAX_REFUND_ATTEMPTS) {
      console.error(
        `[refund-leg] job=${job.id} DEAD-LETTERED after ${attempts} attempts: ${detail}`);
    } else {
      patch.refunded_at = null;      // release for one more try
    }
    await supabaseAdmin.from('video_jobs').update(patch).eq('id', job.id);
  };

  // --- find the job's own charge (attribution + cap)
  const lo = new Date(jobMs - CHARGE_MATCH_WINDOW_MS).toISOString();
  const hi = new Date(jobMs + CHARGE_MATCH_WINDOW_MS).toISOString();
  const { data: charges, error: readErr } = await supabaseAdmin
    .from('usage_events')
    .select('id, created_at')
    .eq('user_id', job.user_id)
    .eq('kind', 'render')
    .gte('created_at', lo)
    .lte('created_at', hi);
  if (readErr) { await unclaim(readErr.message); return { job: job.id, action: 'error', detail: readErr.message }; }
  if (!Array.isArray(charges) || charges.length === 0) {
    return { job: job.id, action: 'noop' }; // own charge already gone (manual-era); stays claimed
  }

  // Guard 1 — attribution: nearest EXISTING job row to the candidate charge wins it.
  const slo = new Date(jobMs - SIBLING_WINDOW_MS).toISOString();
  const shi = new Date(jobMs + SIBLING_WINDOW_MS).toISOString();
  const { data: siblings, error: sibErr } = await supabaseAdmin
    .from('video_jobs')
    .select('id, created_at')
    .eq('user_id', job.user_id)
    .gte('created_at', slo)
    .lte('created_at', shi);
  if (sibErr) { await unclaim(sibErr.message); return { job: job.id, action: 'error', detail: sibErr.message }; }
  const jobInstants = (Array.isArray(siblings) && siblings.length ? siblings : [{ id: job.id, created_at: job.created_at }])
    .map((s) => ({ id: s.id, ms: new Date(s.created_at).getTime() }));
  const attributedToThisJob = (charge) => {
    const cMs = new Date(charge.created_at).getTime();
    let best = null;
    for (const j of jobInstants) {
      const d = Math.abs(cMs - j.ms);
      if (!best || d < best.d) best = { id: j.id, d };
    }
    return best && best.id === job.id;
  };

  const ranked = charges
    .map((c) => ({ ...c, delta: Math.abs(new Date(c.created_at).getTime() - jobMs) }))
    .sort((a, b) => a.delta - b.delta);
  const candidate = ranked[0];
  // Guard 2 — delta cap; Guard 1 — attribution. Either failing means this job's
  // own charge is already gone; stay claimed (one-shot), refund nothing.
  if (candidate.delta > DELETE_DELTA_CAP_MS) return { job: job.id, action: 'noop-capped', deltaMs: candidate.delta };
  if (!attributedToThisJob(candidate)) return { job: job.id, action: 'noop-attributed-elsewhere' };

  const { data: deleted, error: delErr } = await supabaseAdmin
    .from('usage_events')
    .delete()
    .eq('id', candidate.id)
    .eq('user_id', job.user_id)
    .select('id');
  if (delErr) { await unclaim(delErr.message); return { job: job.id, action: 'error', detail: delErr.message }; }
  if (!Array.isArray(deleted) || deleted.length === 0) return { job: job.id, action: 'noop-race' };
  return { job: job.id, action: 'refunded', charge: candidate.id, deltaMs: candidate.delta };
}

/**
 * One sweep pass: unclaimed (refunded_at IS NULL), primary (no parent_job_id /
 * reedit_mode), worker-marked failed rows in the lookback → claim + refund.
 * Idempotent by construction.
 */
async function sweepRefundLeg(supabaseAdmin) {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
  const { data: rows, error } = await supabaseAdmin
    .from('video_jobs')
    .select('id, user_id, created_at, result, status, parent_job_id, reedit_mode, refunded_at, credits_debited, credits_refunded_at, demo, refund_attempts')
    .eq('status', 'failed')
    .is('refunded_at', null)
    // user_id NULL is EXCLUDED SERVER-SIDE. Every downstream query filters
    // .eq('user_id', job.user_id); PostgREST serialises a JS null as the STRING
    // "null", so the row dies with `invalid input syntax for type uuid: "null"`.
    // That error then UNCLAIMED the row, which put it straight back in this
    // set — seven demo rows retried every ~2s from 2026-08-30 until this line.
    .not('user_id', 'is', null)
    .gte('created_at', since);
  if (error) {
    console.error('[refund-leg] sweep read failed:', error.message);
    return { scanned: 0, eligible: 0, refunded: 0, outcomes: [] };
  }

  // EVERY failed primary row refunds (2026-07-11 law). Re-edit/resume rows
  // never minted a charge, so they stay excluded; the claim gate + attribution
  // + delta cap make any cause safe to sweep.
  //
  // DEMO ROWS ARE NOT USER JOBS. They never minted a charge and never debited a
  // credit, so there is nothing to give back — sweeping them can only produce
  // errors. Filtered in JS rather than with .neq('demo', true), because
  // `demo <> true` is NULL for a NULL demo and PostgREST would drop every
  // legacy row where the column was never set.
  //
  // user_id NULL is already excluded server-side above; the guard below is kept
  // as a second line because this filter is what feeds refundJobCharge.
  const eligible = (Array.isArray(rows) ? rows : []).filter(
    (r) => r.parent_job_id == null && r.reedit_mode == null
      && r.demo !== true && r.user_id != null
  );
  const outcomes = [];
  const creditOutcomes = [];
  for (const job of eligible) {
    const outcome = await refundJobCharge(supabaseAdmin, job);
    outcomes.push(outcome);
    // CREDITS REFUND — this was written, tested, and NEVER CALLED. The function
    // existed with a claim, an unclaim and an event, and no caller, so the
    // credits refund was dead code and the event went nowhere. Frontend found
    // it while trying to wire CreditsRefundedMessage.
    //
    // It runs beside the charge refund rather than inside it: the two have
    // separate claims and fail independently, so a charge refund that errors
    // must not prevent the credits coming back.
    try {
      const c = await refundJobCredits(supabaseAdmin, job, _credits);
      if (c.action !== 'noop-never-debited') creditOutcomes.push(c);
      if (c.action === 'refunded') {
        console.log(`[refund-leg] credits refunded job=${c.job} amount=${c.amount}`);
      } else if (String(c.action).startsWith('error')) {
        console.error(`[refund-leg] credits error job=${c.job}: ${c.detail}`);
      }
    } catch (e) {
      console.error('[refund-leg] credits refund threw:', job.id, e && e.message);
    }
    if (outcome.action === 'refunded') {
      console.log(`[refund-leg] refunded job=${outcome.job} charge=${outcome.charge} (Δ${outcome.deltaMs}ms)`);
    } else if (outcome.action === 'error') {
      console.error(`[refund-leg] error job=${outcome.job}: ${outcome.detail}`);
    }
  }
  return {
    scanned: Array.isArray(rows) ? rows.length : 0,
    eligible: eligible.length,
    refunded: outcomes.filter((o) => o.action === 'refunded').length,
    creditsRefunded: creditOutcomes.filter((o) => o.action === 'refunded').length,
    outcomes,
    creditOutcomes,
  };
}


// ── CREDITS REFUND (ruling 2: credit back on failure, and the user SEES it) ──
//
// SEPARATE CLAIM from the charge refund above, on purpose. The two return
// different things (a usage_events row vs RevenueCat credits), can fail
// independently, and a job may legitimately have one and not the other — a demo
// has a credit debit of NULL and no charge, a re-edit has neither. Sharing
// `refunded_at` would make "the charge came back" and "the credits came back"
// indistinguishable, and a partial failure unrecoverable.
//
// EXACTLY-ONCE COMES FROM HERE, not from RevenueCat: RC documents no idempotency
// key on the transactions endpoint, so a retried credit would double-grant.
// Hence the same NULL -> now() claim the charge leg uses.
//
// CLAIM, THEN CALL RC. If the RC call fails we UNCLAIM so the next sweep
// retries; claiming after the call would drop refunds on a transient RC error.
async function refundJobCredits(supabaseAdmin, job, credits, emitEvent) {
  const amount = Number(job.credits_debited);
  if (!Number.isInteger(amount) || amount <= 0) {
    // NULL receipt = never debited (re-edit, demo, credits disabled). Skipping
    // is correct; assuming a default would invent credits nobody spent.
    return { job: job.id, action: 'noop-never-debited' };
  }
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from('video_jobs')
    .update({ credits_refunded_at: new Date().toISOString() })
    .eq('id', job.id)
    .is('credits_refunded_at', null)
    .select('id, user_id');
  if (claimErr) return { job: job.id, action: 'error', detail: claimErr.message };
  if (!Array.isArray(claimed) || claimed.length === 0) {
    return { job: job.id, action: 'noop-already-refunded' };
  }
  const userId = (claimed[0] && claimed[0].user_id) || job.user_id;
  try {
    await credits.credit(userId, amount);
  } catch (e) {
    await supabaseAdmin.from('video_jobs')
      .update({ credits_refunded_at: null }).eq('id', job.id);
    return { job: job.id, action: 'error-unclaimed', detail: (e && e.code) || String(e) };
  }
  // THE USER MUST SEE IT (ruling 2). A silent restore is indistinguishable from
  // having been charged. reason_code, never a sentence — the words belong in the
  // String Catalog behind the localization gate, or every reader gets English.
  if (typeof emitEvent === 'function') {
    try {
      await emitEvent({
        type: 'credits_refunded',
        job_id: job.id,
        amount,
        reason_code: creditsRefundReasonCode(job),
      });
    } catch (e) {
      // The credits ARE back; failing the refund because the notification
      // failed would be worse. Loud, not fatal.
      console.warn('[credits] refunded but the event failed to emit', job.id, e && e.message);
    }
  }
  return { job: job.id, action: 'refunded', amount };
}

/** The refund reason, as a CODE the client renders from its catalog. */
function creditsRefundReasonCode(job) {
  const res = (job && job.result) || {};
  if (res.designed_rejection) return 'DESIGNED_REJECTION';
  const code = String(res.error_code || '');
  if (code === 'PLATFORM_TIMEOUT' || code === 'WORKER_DIED') return 'STALLED';
  if (String(job && job.status) === 'canceled') return 'CANCELLED';
  return 'RENDER_FAILED';
}

module.exports = {
  refundJobCharge, sweepRefundLeg,
  refundJobCredits, creditsRefundReasonCode,
  CHARGE_MATCH_WINDOW_MS, DELETE_DELTA_CAP_MS, SIBLING_WINDOW_MS, LOOKBACK_HOURS,
};

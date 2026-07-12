'use strict';

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
//   - within the DELETE cap (400 ms; measured mint band 33-181 ms, ~2.2x margin), and
//   - when THIS job is the nearest existing job to that charge (attribution).
// A job whose own charge is already gone (manual-era refund) claims + no-ops and
// stays marked — correct and one-shot.

const CHARGE_MATCH_WINDOW_MS = 1500;   // candidate search radius
const DELETE_DELTA_CAP_MS = 400;       // hard cap: measured mints 33-181ms, 2.2x margin
const SIBLING_WINDOW_MS = 2500;        // attribution: sibling-job search radius
const LOOKBACK_HOURS = 48;

/** Worker-marked eligibility. NO LONGER the sweep's gate (every failed row
 * refunds as of 2026-07-11); retained for classification/telemetry uses. */
function isRefundEligible(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.designed_rejection === true) return true;
  return result.error_code === 'INTEGRITY_TRIP' || result.error === 'INTEGRITY_TRIP';
}

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

  const unclaim = async () => {
    await supabaseAdmin.from('video_jobs').update({ refunded_at: null }).eq('id', job.id);
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
  if (readErr) { await unclaim(); return { job: job.id, action: 'error', detail: readErr.message }; }
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
  if (sibErr) { await unclaim(); return { job: job.id, action: 'error', detail: sibErr.message }; }
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
  if (delErr) { await unclaim(); return { job: job.id, action: 'error', detail: delErr.message }; }
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
    .select('id, user_id, created_at, result, parent_job_id, reedit_mode, refunded_at')
    .eq('status', 'failed')
    .is('refunded_at', null)
    .gte('created_at', since);
  if (error) {
    console.error('[refund-leg] sweep read failed:', error.message);
    return { scanned: 0, eligible: 0, refunded: 0, outcomes: [] };
  }

  // EVERY failed primary row refunds (2026-07-11 law). Re-edit/resume rows
  // never minted a charge, so they stay excluded; the claim gate + attribution
  // + delta cap make any cause safe to sweep.
  const eligible = (Array.isArray(rows) ? rows : []).filter(
    (r) => r.parent_job_id == null && r.reedit_mode == null
  );
  const outcomes = [];
  for (const job of eligible) {
    const outcome = await refundJobCharge(supabaseAdmin, job);
    outcomes.push(outcome);
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
    outcomes,
  };
}

module.exports = {
  isRefundEligible, refundJobCharge, sweepRefundLeg,
  CHARGE_MATCH_WINDOW_MS, DELETE_DELTA_CAP_MS, SIBLING_WINDOW_MS, LOOKBACK_HOURS,
};

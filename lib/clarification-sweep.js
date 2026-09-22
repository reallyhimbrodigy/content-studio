'use strict';

// EXPIRY FOR PARKED CLARIFICATIONS — Zac's ruling: a parked ask must be
// answerable or cancellable, and it expires at 24 hours, releasing the root.
//
// His reason, worth keeping next to the code: an ask that sits 62 days is a
// refusal that is neither satisfiable nor terminal, and the standing rule
// forbids that shape.
//
// ANSWERING IS THE PRIMARY EXIT, NOT THIS. The re-edit route clears a parked
// clarification in the same operation that creates the reply, so a user who
// answers never waits on this sweep and never meets the root lock. This catches
// only the user who walked away — which, measured, is most of them: 18 of 19
// parked rows were already past a week and the oldest was 63 days.
//
// CLARIFICATION PARKS ONLY. A Phase D ask-back park owns its own timeout path
// (the worker resumes it with skip:true from partial_state), so cancelling one
// here would terminalize a job the worker still intends to finish. The status is
// shared between the two mechanisms; the envelope is what tells them apart.
//
// ORDERING NOTE — this sweep is also the PRE-STEP for the partial unique index.
// `UNIQUE (root_job_id) WHERE status IN (...)` cannot be CREATED while two
// non-terminal rows share a root, and two roots do exactly that today
// (a8d9538c and fdda063b, four rows, all one user, 426-503h old). The index
// migration has to run AFTER this has cleared them, not before.

const { isClarificationPark, isExpired, EXPIRY_MS } = require('./clarification');

/**
 * One sweep pass. Idempotent by construction: every write is a CAS on
 * status='needs_input', so a row already cancelled by a reply, by a concurrent
 * pass, or by the reaper is a no-op rather than a double-cancel.
 *
 * @param {object} supabaseAdmin
 * @param {object} [opts] { now, limit, log }
 * @returns {Promise<{scanned:number, expired:number, skipped:number}>}
 */
async function sweepExpiredClarifications(supabaseAdmin, opts = {}) {
  const now = Number(opts.now || Date.now());
  const limit = Number(opts.limit || 200);
  const log = opts.log || console;
  const out = { scanned: 0, expired: 0, skipped: 0 };
  if (!supabaseAdmin) return out;

  // Bound the read by the clock in SQL rather than filtering in JS, so a large
  // parked population cannot be pulled into memory to discard most of it.
  const cutoff = new Date(now - EXPIRY_MS).toISOString();
  const { data: rows, error } = await supabaseAdmin
    .from('video_jobs')
    .select('id, user_id, status, parent_job_id, root_job_id, result, created_at')
    .eq('status', 'needs_input')
    .lt('created_at', cutoff)
    .limit(limit);
  if (error) {
    log.error(`[clarification-expiry] read failed: ${error.message}`);
    return out;
  }

  for (const row of rows || []) {
    out.scanned += 1;
    // Both guards, not one. isExpired re-checks the clock against the row we
    // actually read (the SQL cutoff and this must agree), and the envelope check
    // keeps an ask-back park out of a sweep that has no business terminalizing it.
    if (!isClarificationPark(row) || !isExpired(row, now)) { out.skipped += 1; continue; }

    const { data: won, error: updErr } = await supabaseAdmin
      .from('video_jobs')
      .update({
        status: 'canceled',
        current_step: 'clarification_expired',
        step_message: null,
        updated_at: new Date(now).toISOString(),
      })
      .eq('id', row.id)
      .eq('status', 'needs_input')     // CAS — a reply may have just cleared it
      .select('id');
    if (updErr) {
      log.error(`[clarification-expiry] cancel failed job=${row.id}: ${updErr.message}`);
      continue;
    }
    if (!Array.isArray(won) || won.length === 0) { out.skipped += 1; continue; }

    out.expired += 1;
    log.log(`[clarification-expiry] expired job=${row.id} root=${row.root_job_id || '?'} `
      + `age=${Math.round((now - Date.parse(row.created_at)) / 3600e3)}h`);
    try {
      await supabaseAdmin.from('analytics_events').insert({
        event: 'clarification_expired', platform: 'server',
        props: {
          job_id: row.id,
          root_job_id: row.root_job_id || null,
          parent_job_id: row.parent_job_id || null,
          age_hours: Math.round((now - Date.parse(row.created_at)) / 3600e3),
        },
      });
    } catch (_) { /* analytics is never allowed to fail the sweep */ }
  }
  return out;
}

module.exports = { sweepExpiredClarifications };

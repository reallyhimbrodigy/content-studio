// A ROW WITH A DELIVERABLE MAY NEVER BE TERMINAL-FAILED. [Law 2, Rule 1]
//
// THE COHORT, MEASURED: 34 rows across 29 DISTINCT USERS [Rule 7] sit at
// status='failed' while carrying a rendered_video_url. 32 of them carry
// completion_delivery='repair' and a completed_at — the repair had already
// found the render in S3, written the URL, and set status='completed'. Then
// something wrote 'failed' on top, ~41-47 minutes later, and told the user
// "This render hit our time limit."
//
// Those users have a finished video. We told them it failed. That is worse than
// a failure: it is a lie about work we successfully did, and it costs the user
// their result while we pay for the render anyway.
//
// WHY THIS EXISTS AS AN INVARIANT AND NOT AS ANOTHER GUARD. Every writer that
// sets status='failed' ALREADY guards on non-terminal — the reaper has carried
// `.eq('status', stage)` since 2026-07-10, which PREDATES the whole cohort, and
// the repair guards `.not('status','in',TERMINAL)`. Both guards were present and
// the loss happened anyway: 32 of 60 repairs (53%) ended failed. So the mechanism
// is NOT reconstructible from the write guards, and one more guard of the same
// shape would be a guess.
//
// An invariant does not care which writer is wrong. It states the property that
// must hold no matter who writes, and it is checkable on the row itself, after
// the fact, by anyone. That is the difference between fixing a race you can name
// and closing a class you cannot.
//
// THE SELF-HEAL IS THE POINT. terminalizeFailure does not merely REFUSE the bad
// write — refusing would leave the row stuck non-terminal, which is the 900s
// reaper wall all over again. When a deliverable exists it COMPLETES the row
// instead, because a finished video is the honest outcome. Fail loudly to us,
// never to the user.

// A rendered artifact by any of the names the pipeline uses. `result.video_url`
// is included because the worker's envelope carries it there before the column
// is projected — the OUTPUT vs ENVELOPE split that has already cost this repo a
// wrong `_delivered` predicate.
function deliverableOn(row) {
  if (!row || typeof row !== 'object') return null;
  const direct = row.rendered_video_url || row.result_url || row.hls_manifest_url;
  if (direct) return direct;
  const res = row.result;
  if (res && typeof res === 'object') {
    const nested = res.video_url || res.rendered_video_url
      || (res.output && typeof res.output === 'object' ? res.output.video_url : null);
    if (nested) return nested;
  }
  return null;
}

// THE INVARIANT ITSELF. True = this row violates it.
function violatesTerminalInvariant(row) {
  if (!row || typeof row !== 'object') return false;
  const status = String(row.status || '').trim().toLowerCase();
  if (status !== 'failed' && status !== 'error') return false;
  return Boolean(deliverableOn(row));
}

// Strip the failure story off a result being healed, keeping everything else.
// `healed_from` preserves WHICH class stranded the row, so the cohort stays
// countable after the fact — a heal that erased its own cause would make the
// class unmeasurable, which is how this one survived four days.
const _ERR_KEYS = new Set(['error', 'error_code', 'error_class', 'error_where',
  'error_detail', 'user_message', 'reaped', 'reason', 'retryable', 'http_status']);

function healedResult(result) {
  const src = (result && typeof result === 'object') ? result : {};
  const out = {};
  for (const k of Object.keys(src)) if (!_ERR_KEYS.has(k)) out[k] = src[k];
  const from = src.error_code || src.error;
  if (from) out.healed_from = from;
  out.healed_at = new Date().toISOString();
  return out;
}

/**
 * The ONE way to write a terminal failure.
 *
 * Re-reads the row inside the same call, so a deliverable that landed between
 * the caller's decision and this write is still caught — that window is exactly
 * where the repair/reaper interleaving lives.
 *
 * Returns {outcome: 'failed'|'healed'|'noop', ...}. Never throws on the heal
 * path: a heal that fails must still let the honest failure land.
 */
async function terminalizeFailure(supabaseAdmin, jobId, patch, {
  log = console, terminalList = '(completed,failed,canceled,needs_input)',
} = {}) {
  let row = null;
  try {
    const { data } = await supabaseAdmin
      .from('video_jobs')
      .select('id,status,rendered_video_url,result_url,hls_manifest_url,result')
      .eq('id', jobId)
      .limit(1);
    row = Array.isArray(data) && data[0] ? data[0] : null;
  } catch (e) {
    // Could not read. FAIL SAFE toward today's behaviour: write the failure.
    // A read outage must not strand every failing job as non-terminal.
    log.error(`[terminal-invariant] pre-read failed job=${jobId} (${e && e.message}) `
      + '— proceeding with the failure write');
  }

  const url = row ? deliverableOn(row) : null;
  if (url) {
    // THE HEAL. We were about to tell a user their finished video failed.
    log.error(`[terminal-invariant] REFUSED to fail job=${jobId} — it carries a `
      + 'deliverable. Completing it instead. This is the class that told 29 users '
      + 'their finished video had failed.');
    try {
      const { data } = await supabaseAdmin
        .from('video_jobs')
        .update({
          status: 'completed',
          current_step: 'complete',
          progress: 100,
          step_message: 'Your video is ready!',
          // THE COPY MUST HEAL TOO — found by staging the first batch of three.
          // The row flipped to completed while error_message still read "This
          // render hit our time limit — you weren't charged", and result still
          // carried error_code=PLATFORM_TIMEOUT + reaped:true. A completed job
          // that also says it timed out is a contradiction the USER READS, and
          // a lingering result.error_code is exactly what breaks a _delivered
          // predicate downstream. Clearing status without clearing the story is
          // half a heal.
          error_message: null,
          result: healedResult(row.result),
          completion_delivery: row.completion_delivery || 'invariant_heal',
          completed_at: row.completed_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .not('status', 'in', terminalList)
        .select('id');
      if (Array.isArray(data) && data.length) {
        return { outcome: 'healed', url };
      }
      return { outcome: 'noop', reason: 'already_terminal', url };
    } catch (e) {
      log.error(`[terminal-invariant] heal FAILED job=${jobId} (${e && e.message})`);
      return { outcome: 'noop', reason: 'heal_failed', url };
    }
  }

  const { data } = await supabaseAdmin
    .from('video_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .not('status', 'in', terminalList)
    .select('id');
  return { outcome: Array.isArray(data) && data.length ? 'failed' : 'noop' };
}

/**
 * Sweep existing violations. Read-only unless apply=true — the 34 rows already
 * in this state are USER-VISIBLE and flipping them sends real notifications, so
 * the default reports and changes nothing.
 */
async function reconcileTerminalInvariant(supabaseAdmin, { apply = false, log = console } = {}) {
  const { data } = await supabaseAdmin
    .from('video_jobs')
    .select('id,user_id,status,rendered_video_url,result_url,hls_manifest_url,result,completed_at,completion_delivery')
    .eq('status', 'failed')
    .not('rendered_video_url', 'is', null)
    .limit(2000);
  const bad = (data || []).filter(violatesTerminalInvariant);
  const users = new Set(bad.map((r) => r.user_id));
  log.error(`[terminal-invariant] ${bad.length} violating row(s) / ${users.size} users`);
  if (!apply) return { violations: bad.length, users: users.size, applied: 0 };
  let applied = 0;
  for (const r of bad) {
    const { data: up } = await supabaseAdmin
      .from('video_jobs')
      .update({
        status: 'completed', current_step: 'complete', progress: 100,
        step_message: 'Your video is ready!',
        error_message: null, result: healedResult(r.result),
        completion_delivery: r.completion_delivery || 'invariant_heal',
        completed_at: r.completed_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', r.id).eq('status', 'failed').select('id');
    if (Array.isArray(up) && up.length) applied += 1;
  }
  return { violations: bad.length, users: users.size, applied };
}

module.exports = {
  deliverableOn, violatesTerminalInvariant, terminalizeFailure, healedResult,
  reconcileTerminalInvariant,
};

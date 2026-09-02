'use strict';

// ── Completion reconciliation: a rendered video must reach its owner ─────────
//
// THE DEFECT (2026-08-02): 9 users had a finished video they never received.
// Since 07-28, 9 of 693 completions (1.3%, trending up: 2 on 07-28, 3 on 08-01,
// 4 on 08-02) sit with status='completed', a complete success envelope in
// `result` — video_url, hls_manifest_url, thumbnail_url, edit_recipe, all of it
// — and EVERY delivery column NULL. The client reads the columns. They got
// nothing, and nothing counted it.
//
// WHY THE TAIL CANNOT BE FIXED IN PLACE. The projection from result -> columns
// runs in dispatchJobToModal's completion tail, which is only reached when an
// in-process `await` resolves. That await lives in a plain
// `new Map()` (modal-webhook.js:1). A deploy or restart drops every in-flight
// entry, so the tail never runs — while the WORKER's own durable write has
// already marked the job completed. content-studio auto-deploys main, and the
// affected days are the deploy-heavy ones. No amount of tail logic makes an
// in-process Map survive a restart; the recovery has to be external and
// stateless, which is what this is.
//
// It is also the reason the "recovered fully from Supabase" double-loss alert
// was wrong on job 476fe663: it verified the ROW, not the COLUMNS. 476fe663 is
// one of the nine. An alert that claims recovery must check what the client
// actually reads.
//
// FINGERPRINT: status='completed' AND rendered_video_url IS NULL. All 9 also
// carry completed_at IS NULL, which is the cheapest index-friendly probe.

const DEFAULT_LOOKBACK_HOURS = 72;

/** Rows the client cannot play: completed, but no deliverable URL projected. */
async function findUnprojectedCompletions(supabaseAdmin, { lookbackHours = DEFAULT_LOOKBACK_HOURS } = {}) {
  const since = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('video_jobs')
    .select('id, user_id, created_at, status, rendered_video_url, result_url, '
            + 'hls_manifest_url, thumbnail_url, completed_at, result')
    .eq('status', 'completed')
    .is('rendered_video_url', null)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw new Error(`unprojected-completions query failed: ${error.message}`);
  // Only rows whose result actually HOLDS a deliverable — anything else is a
  // different (worse) bug and must not be silently "reconciled" into looking fine.
  return (data || []).filter((r) => {
    const res = (r && r.result) || {};
    return Boolean(res.video_url || res.public_url || res.rendered_video_url);
  });
}

/**
 * Project one row's stored result into the columns the client reads.
 *
 * Writes ONLY delivery columns, never status/result/phase — the worker owns
 * terminal state (single-writer law). Idempotent: re-running is a no-op because
 * the `.is('rendered_video_url', null)` guard makes the second write match zero
 * rows, so a sweep racing the real tail can never clobber a live completion.
 */
async function projectCompletion(supabaseAdmin, row) {
  const res = (row && row.result) || {};
  const rawUrl = res.video_url || res.public_url || res.rendered_video_url;
  if (!rawUrl) return { id: row.id, projected: false, reason: 'no_url_in_result' };

  // THIS IS THE PATH THAT PRODUCED 6,200 PERMANENT PUBLIC LINKS. `res.public_url`
  // is the url WE handed the worker to upload to — a bare, non-expiring CDN
  // link — and storing it verbatim is what made `renders/` impossible to
  // restrict without 403ing 5,121 users at once. Every other completion path
  // (dispatch, repair) already presigned; this one, the dominant one, never did.
  // A grant expires; a link does not.
  const { toDeliverableUrl } = require('./deliverable-url');
  const videoUrl = await toDeliverableUrl(rawUrl, { label: 'reconcile' });

  const update = {
    rendered_video_url: videoUrl,
    completed_at: row.completed_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    progress: 100,
    current_step: 'complete',
    step_message: 'Your video is ready!',
  };
  // Only fill what is actually missing — never overwrite a column that already
  // has a value from the real tail.
  if (!row.hls_manifest_url && res.hls_manifest_url) update.hls_manifest_url = res.hls_manifest_url;
  if (!row.thumbnail_url && res.thumbnail_url) update.thumbnail_url = res.thumbnail_url;

  const { data, error } = await supabaseAdmin
    .from('video_jobs')
    .update(update)
    .eq('id', row.id)
    .is('rendered_video_url', null)      // idempotency + anti-clobber guard
    .select('id');
  if (error) return { id: row.id, projected: false, reason: `write_failed: ${error.message}` };
  const won = Array.isArray(data) && data.length > 0;
  return {
    id: row.id, user_id: row.user_id, projected: won,
    reason: won ? 'projected' : 'raced_or_already_projected',
    video_url: videoUrl,
    hls: Boolean(update.hls_manifest_url || row.hls_manifest_url),
    thumb: Boolean(update.thumbnail_url || row.thumbnail_url),
  };
}

/**
 * Sweep + repair. Returns {found, projected, results}. Loud by design: a
 * rendered video that did not reach its owner is a P1, so every occurrence
 * prints a grep-stable line even though it self-heals — a silent self-heal is
 * how this class stayed invisible for six days.
 */
async function reconcileCompletions(supabaseAdmin, { lookbackHours, log = console } = {}) {
  const rows = await findUnprojectedCompletions(supabaseAdmin, { lookbackHours });
  if (!rows.length) return { found: 0, projected: 0, results: [] };
  log.error(`[ALERT] undelivered completions: ${rows.length} job(s) rendered but never `
    + `projected to their delivery columns — ${rows.map((r) => String(r.id).slice(0, 8)).join(', ')}`);
  const results = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const out = await projectCompletion(supabaseAdmin, row);
    results.push(out);
    log.error(`[ALERT] undelivered completion job=${String(out.id).slice(0, 8)} `
      + `user=${String(out.user_id || '').slice(0, 8)} -> ${out.reason}`);
  }
  return { found: rows.length, projected: results.filter((r) => r.projected).length, results };
}

/**
 * Did a completion actually land where the CLIENT reads it? The double-loss
 * recovery path claimed "recovered fully from Supabase" on job 476fe663 while
 * every delivery column was NULL — it verified the row, not the delivery.
 */
function isDelivered(row) {
  return Boolean(row && (row.rendered_video_url || row.result_url));
}

module.exports = {
  DEFAULT_LOOKBACK_HOURS,
  findUnprojectedCompletions,
  projectCompletion,
  reconcileCompletions,
  isDelivered,
};

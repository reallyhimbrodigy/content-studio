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

// ── THE SECOND HANDOVER: projected, but never attached to a chat ────────────
//
// THE DEFECT (2026-09-07): 19 completed jobs across 8 users have every delivery
// column populated — rendered_video_url, HLS, thumbnail, result — and NO CHAT
// anywhere that references them. The client renders videos out of chat message
// bubbles, so a job with no chat is invisible no matter how complete the row
// is. Users watched their videos never arrive while every server-side metric
// said success.
//
// SAME CLASS AS THE PROJECTION FAILURE ABOVE, ONE LAYER LATER. That one was
// "rendered but the columns are NULL"; this is "columns are fine but nothing
// hands them over". Both are a finished video that never reached its owner, and
// both were invisible because every check stopped at the layer it owned. The
// newest instance is from TODAY on 1.3.27, so the list is still growing.
//
// IT CANNOT SELF-HEAL HERE. The chat is written by the CLIENT, so the server
// cannot conjure the missing bubble without inventing a message the app never
// produced — which is a recovery decision, not a sweep. This detects and PAGES;
// the recovery is deliberate and separate.
//
// GRACE PERIOD, because the client writes the chat moments after completion and
// a sweep at 2-minute cadence would page on every healthy job in flight.
const HANDOVER_GRACE_MINUTES = 45;

/** Completed + fully projected + no chat references it. The client's own view. */
async function findUnhandedOverCompletions(
  supabaseAdmin, { lookbackHours = DEFAULT_LOOKBACK_HOURS, graceMinutes = HANDOVER_GRACE_MINUTES } = {},
) {
  const since = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
  const until = new Date(Date.now() - graceMinutes * 60_000).toISOString();
  const { data: jobs, error } = await supabaseAdmin
    .from('video_jobs')
    .select('id, user_id, created_at, rendered_video_url')
    .eq('status', 'completed')
    .not('rendered_video_url', 'is', null)
    .not('user_id', 'is', null)      // ownerless jobs are a separate class
    .gte('created_at', since)
    .lt('created_at', until)
    .limit(1000);
  if (error) throw new Error(`findUnhandedOverCompletions: ${error.message}`);
  if (!jobs || !jobs.length) return [];

  // ONE query for the chats, not one per job. A LIKE over the whole messages
  // jsonb per job is a sequential scan each time; pulling the window's chats
  // once and matching in memory is the same answer without the quadratic.
  const userIds = [...new Set(jobs.map((j) => j.user_id))];
  const { data: chats, error: cErr } = await supabaseAdmin
    .from('chats')
    .select('user_id, messages')
    .in('user_id', userIds)
    .limit(2000);
  if (cErr) throw new Error(`findUnhandedOverCompletions chats: ${cErr.message}`);

  // Match on jobId, which is the field the client actually writes on the
  // assistant bubble — not a substring of the blob, which would also match a
  // job id quoted inside someone's prompt text.
  const seen = new Set();
  for (const c of (chats || [])) {
    const msgs = Array.isArray(c.messages) ? c.messages : [];
    for (const m of msgs) if (m && m.jobId) seen.add(String(m.jobId));
  }
  return jobs.filter((j) => !seen.has(String(j.id)));
}

/**
 * Sweep. DETECTS AND PAGES — it does not repair, because the missing artifact is
 * a chat the CLIENT writes and manufacturing one server-side is a recovery
 * decision rather than a reconciliation.
 */
async function reconcileHandover(supabaseAdmin, { lookbackHours, graceMinutes, log = console } = {}) {
  const rows = await findUnhandedOverCompletions(supabaseAdmin, { lookbackHours, graceMinutes });
  if (!rows.length) return { found: 0, users: 0, rows: [] };
  const users = new Set(rows.map((r) => String(r.user_id)));
  // PER USER FIRST. Rule 7: a user with five stranded videos is one lost user,
  // not five failures, and per-job counting inflates every class by the retry
  // multiplier.
  log.error(`[ALERT] undelivered handover: ${users.size} user(s), ${rows.length} completed `
    + `job(s) rendered and projected but attached to NO CHAT — the client cannot `
    + `show them. jobs: ${rows.map((r) => String(r.id).slice(0, 8)).join(', ')}`);
  for (const r of rows) {
    log.error(`[ALERT] stranded completion job=${String(r.id).slice(0, 8)} `
      + `user=${String(r.user_id).slice(0, 8)} created=${r.created_at}`);
  }
  return { found: rows.length, users: users.size, rows };
}

module.exports = {
  DEFAULT_LOOKBACK_HOURS,
  HANDOVER_GRACE_MINUTES,
  findUnprojectedCompletions,
  findUnhandedOverCompletions,
  projectCompletion,
  reconcileCompletions,
  reconcileHandover,
  isDelivered,
};

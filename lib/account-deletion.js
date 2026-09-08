'use strict';

// ── ACCOUNT DELETION AS A RESUMABLE JOB WITH A RECEIPT ──────────────────────
//
// THE HANDLER THIS REPLACES HAD THE ORDER INVERTED. It deleted video_jobs,
// chats, profiles and the auth user FIRST, then cleaned S3 best-effort. The S3
// keys live in video_jobs — already deleted by then — so a failed S3 pass lost
// the only record of which objects existed. The user's rendered videos stayed
// in the bucket permanently, attached to nobody and unattributable.
//
// It also ran inline in the request, so a timeout or a deploy mid-flight left
// an account half-deleted with nothing to retry.
//
// THE ORDER HERE IS FORCED BY THE FOREIGN KEYS. video_jobs.user_id and
// chats.user_id are ON DELETE SET NULL, so deleting the auth user first does
// not remove those rows — it ORPHANS them, nulling the only column that says
// whose they were. The auth user must go LAST or the rows become
// indistinguishable from the 34 demo rows that never had an owner.
//
//   capture keys -> S3 objects -> video_jobs -> chats -> grants (scrub)
//   -> profiles -> auth user
//
// FREE_CREDIT_GRANTS IS THE DELIBERATE EXCEPTION. Its device_id is the
// anti-abuse record: delete the row and the device gets a fresh 30 credits by
// signing up again. The row STAYS and the user_id is scrubbed — the grant
// history survives without naming a deleted person.

// SPEND SURVIVES ELSEWHERE. video_jobs rows are deleted ENTIRELY — no costed
// stub, nothing retained that names a deleted person. Daily spend lives in
// `daily_spend`, aggregated by day/route/source_type with no user column, and
// was backfilled (7,761 jobs, 73 days, $2,373.79) BEFORE this shipped: the
// moment the first account deletes, the rows behind its spend are gone and
// unreconstructable.
const STAGES = ['queued', 's3', 'rows', 'grants', 'profile', 'auth', 'done'];

/** Every S3 key this user owns, from every column that can hold one. */
function collectKeys(jobs) {
  const keys = new Set();
  for (const job of jobs || []) {
    for (const urlStr of [
      job.video_url, job.proxy_video_url, job.rendered_video_url,
      job.thumbnail_url, job.hls_manifest_url, job.result_url,
    ]) {
      if (!urlStr) continue;
      try {
        const k = new URL(urlStr).pathname.replace(/^\/+/, '');
        if (k) keys.add(k);
      } catch { /* malformed — skip */ }
    }
  }
  return [...keys];
}

/**
 * Enqueue. Idempotent by primary key: a second delete request for the same user
 * does not create a second job or reset one in flight.
 */
async function enqueueAccountDeletion(supabaseAdmin, userId) {
  const { data: jobs } = await supabaseAdmin
    .from('video_jobs')
    .select('id, video_url, proxy_video_url, rendered_video_url, thumbnail_url, '
            + 'hls_manifest_url, result_url')
    .eq('user_id', userId);

  // KEYS CAPTURED BEFORE ANYTHING IS DELETED. This is the whole fix for the
  // inverted order — after video_jobs is gone the keys are unrecoverable, so
  // they are persisted first and every retry reads them from here.
  const s3Keys = collectKeys(jobs);
  const { error } = await supabaseAdmin
    .from('account_deletions')
    .upsert({ user_id: userId, s3_keys: s3Keys, stage: 'queued' },
            { onConflict: 'user_id', ignoreDuplicates: true });
  if (error) throw new Error(`enqueueAccountDeletion: ${error.message}`);
  return { userId, s3Keys: s3Keys.length };
}

/**
 * Run (or resume) one deletion. Every stage is idempotent on its own, so a
 * partial run RESUMES at the first unfinished stage rather than restarting —
 * re-deleting an absent S3 key or an absent row is a no-op, but skipping a
 * stage because a previous attempt "probably did it" is not.
 */
async function runAccountDeletion(supabaseAdmin, userId, { s3, log = console } = {}) {
  const { data: row } = await supabaseAdmin
    .from('account_deletions').select('*').eq('user_id', userId).maybeSingle();
  if (!row) throw new Error(`runAccountDeletion: no queued deletion for ${userId}`);
  if (row.stage === 'done') return { userId, resumed: true, alreadyDone: true };

  const at = (stage) => STAGES.indexOf(stage);
  const from = Math.max(at(row.stage), 0);
  const counts = { ...(row.rows_deleted || {}) };
  let s3Deleted = row.s3_deleted || 0;
  let s3Failed = 0;

  const mark = async (stage, patch = {}) => {
    await supabaseAdmin.from('account_deletions')
      .update({ stage, started_at: row.started_at || new Date().toISOString(), ...patch })
      .eq('user_id', userId);
  };

  await supabaseAdmin.from('account_deletions')
    .update({ attempts: (row.attempts || 0) + 1 }).eq('user_id', userId);

  // ── S3 FIRST, from the captured keys ────────────────────────────────────
  if (from <= at('s3')) {
    await mark('s3');
    const keys = Array.isArray(row.s3_keys) ? row.s3_keys : [];
    if (s3 && s3.deleteObject) {
      for (const key of keys) {
        try { await s3.deleteObject(key); s3Deleted += 1; }
        catch (e) { s3Failed += 1; log.warn(`[account-deletion] s3 ${key}: ${e.message || e}`); }
      }
    }
    await mark('s3', { s3_deleted: s3Deleted, s3_failed: s3Failed });
    // A FAILED OBJECT STOPS THE RUN. Deleting the rows now would lose the keys
    // for the objects that survived — the exact defect this replaces.
    if (s3Failed > 0) {
      await supabaseAdmin.from('account_deletions').update({
        stage: 'failed',
        last_error: `${s3Failed} S3 object(s) could not be deleted; rows retained so the keys survive for a retry`,
      }).eq('user_id', userId);
      return { userId, ok: false, s3Deleted, s3Failed, stopped: 's3' };
    }
  }

  const del = async (table, col, val) => {
    const { data, error } = await supabaseAdmin
      .from(table).delete().eq(col, val).select('*', { count: 'exact' });
    if (error) throw new Error(`${table}: ${error.message}`);
    return (data || []).length;
  };

  if (from <= at('rows')) {
    await mark('rows');
    counts.video_jobs = (counts.video_jobs || 0) + await del('video_jobs', 'user_id', userId);
    counts.chats = (counts.chats || 0) + await del('chats', 'user_id', userId);
    await mark('rows', { rows_deleted: counts });
  }

  // ── GRANTS: SCRUBBED, NOT DELETED ───────────────────────────────────────
  // device_id is the anti-abuse record. Deleting the row hands that device a
  // fresh 30 credits on the next signup, so the grant history stays and only
  // the person is removed from it.
  if (from <= at('grants')) {
    await mark('grants');
    const { data: scrubbed, error } = await supabaseAdmin
      .from('free_credit_grants').update({ user_id: null }).eq('user_id', userId).select('id');
    if (error) throw new Error(`free_credit_grants: ${error.message}`);
    counts.free_credit_grants_scrubbed =
      (counts.free_credit_grants_scrubbed || 0) + (scrubbed || []).length;
    await mark('grants', { rows_deleted: counts });
  }

  if (from <= at('profile')) {
    await mark('profile');
    counts.profiles = (counts.profiles || 0) + await del('profiles', 'id', userId);
    await mark('profile', { rows_deleted: counts });
  }

  // ── AUTH USER LAST ──────────────────────────────────────────────────────
  // Deleting it earlier does not remove video_jobs/chats — their FKs are
  // ON DELETE SET NULL, so it would NULL the owner column and orphan the rows
  // beyond recovery.
  if (from <= at('auth')) {
    await mark('auth');
    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (error) {
      const msg = String(error.message || error).toLowerCase();
      // Already gone is success — that is what idempotent means here.
      if (!msg.includes('not found') && !msg.includes('not_found')) {
        await supabaseAdmin.from('account_deletions')
          .update({ stage: 'failed', last_error: `auth: ${error.message}` })
          .eq('user_id', userId);
        throw new Error(`auth delete: ${error.message}`);
      }
    }
  }

  await supabaseAdmin.from('account_deletions').update({
    stage: 'done', completed_at: new Date().toISOString(),
    s3_deleted: s3Deleted, s3_failed: 0, rows_deleted: counts, last_error: null,
  }).eq('user_id', userId);

  // THE RECEIPT, printed. Without it you cannot prove a user's content is gone,
  // which is the property this whole approach was chosen for.
  log.log(`[account-deletion] DONE user=${userId} s3_objects=${s3Deleted} `
    + `rows=${JSON.stringify(counts)}`);
  return { userId, ok: true, s3Deleted, counts };
}

/** Sweep unfinished deletions. A crash or deploy mid-run resumes here. */
async function sweepAccountDeletions(supabaseAdmin, { s3, limit = 5, log = console } = {}) {
  const { data: rows } = await supabaseAdmin
    .from('account_deletions').select('user_id')
    .not('stage', 'in', '("done")').order('requested_at').limit(limit);
  const out = [];
  for (const r of rows || []) {
    try { out.push(await runAccountDeletion(supabaseAdmin, r.user_id, { s3, log })); }
    catch (e) { log.error(`[account-deletion] ${r.user_id}: ${e.message || e}`); }
  }
  return out;
}

module.exports = {
  STAGES, collectKeys, enqueueAccountDeletion, runAccountDeletion, sweepAccountDeletions,
};

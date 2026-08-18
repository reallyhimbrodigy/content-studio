'use strict';

// ── Server-authoritative chat membership ────────────────────────────────────
//
// THE DEFECT (frontend, service-role read, SERVER_CHAT_ATTACH_SPEC §1): 498
// completed videos across 441 users — 10.6% of everyone who has ever made a
// video — have a jobId that appears in NO chat. 140 of them are from the last
// 7 days, so it is a live leak, not history. It is worst on exactly the slow
// sessions where renders take longest, because that is when the client is most
// likely to background before its chat write lands.
//
// ROOT CAUSE — two decoupled writes, one durable and one best-effort:
//
//   DURABLE      POST /api/video-jobs creates the video_jobs row server-side.
//   BEST-EFFORT  the chat message that REFERENCES the render is written by the
//                CLIENT, as a PATCH of the whole `messages` jsonb, 600ms
//                debounced, never force-flushed on background, in-memory retry
//                only. On a suspended session it is simply dropped.
//
// So the video exists, is paid for, is playable — and is in no chat. The iOS
// 1.3.8 build narrowed the window; it did not close it, because a client-owned
// write can always be lost. The fix has to be server-authoritative: the job row
// already knows its own id and its user, so the server can guarantee membership
// at completion without the client participating at all.
//
// ═══ WHY THIS IS A READ-MODIFY-WRITE, AND WHY IT CAS's ═══════════════════════
//
// Healing a message means rewriting the `messages` jsonb array — the exact
// shape that cost us 38.6% of result envelopes (180 completions across 161
// users) to a LOST UPDATE, where two writers each read, each merged, and the
// slower one erased the other. The client PATCHes this same column from the
// device, so the race is not hypothetical here, it is the normal case.
//
// Every write below therefore CAS's on `updated_at` (the house idiom, mirrored
// from lib/lifecycle-push.js claimLifecyclePush, including its null-handling:
// a null updated_at is matched AS null rather than silently skipped, because a
// dropped guard is how this class comes back). Losing the CAS is a NO-OP, never
// an overwrite — the sweep re-attempts within minutes, and a delayed attach is
// cheap while a clobbered chat is unrecoverable.
//
// ═══ CREATION IS IDEMPOTENT BY CONSTRUCTION, NOT BY CHECKING ═════════════════
//
// The inline attach and the sweep can both decide to reconstruct the same
// chat at the same time. A check-then-act guard ("look for it, then insert")
// has a window between the two halves and would produce duplicate chats for
// the same render. Instead the chat's PRIMARY KEY is DERIVED from the job id
// (uuidv5), so the second insert collides on the PK and fails harmlessly —
// there is no window to lose, by construction.
//
// ═══ WHAT THIS DELIBERATELY DOES NOT DO ═════════════════════════════════════
//
//   - It never attaches a FAILED render (§5). A playable bubble for a job that
//     failed is a worse lie than a missing one.
//   - It never touches `content`, `role`, or any key it did not put there. A
//     heal fills delivery fields on an existing message and nothing else.
//   - It never writes to video_jobs. The worker owns that row (single-writer).

const crypto = require('crypto');

// Fixed namespace for every derived id in this module. It must NEVER change:
// the value is what makes reconstruction idempotent across processes, deploys
// and the sweep. Changing it would orphan every previously-derived chat id and
// re-open the duplicate-creation window this design exists to close.
const CHAT_ATTACH_NAMESPACE = '7c9e5a41-3f2b-5d18-9a6e-2b4c8d1f0e73';

const DEFAULT_LOOKBACK_HOURS = 3;   // the sweep is a backstop for the INLINE
                                    // path, so it only needs to reach back far
                                    // enough to cover a restart. History is the
                                    // one-time backfill's job (§8.2), not this.
const DEFAULT_SWEEP_LIMIT = 60;
const CAS_ATTEMPTS = 3;

/** RFC 4122 v5 (SHA-1, name-based). Dependency-free on purpose: the repo has no
 *  existing `uuid` import, and adding an ESM-only dep to a CJS server file is a
 *  deploy-blocking risk for 12 lines of arithmetic. */
function uuidv5(name, namespaceUuid = CHAT_ATTACH_NAMESPACE) {
  const ns = Buffer.from(String(namespaceUuid).replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1')
    .update(Buffer.concat([ns, Buffer.from(String(name), 'utf8')]))
    .digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;   // version 5
  b[8] = (b[8] & 0x3f) | 0x80;   // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-`
       + `${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The reconstructed chat's PK, derived from the render it holds. */
function deterministicChatId(jobId) { return uuidv5(`chat:${jobId}`); }
/** The assistant message's id, likewise derived so a re-run rewrites in place. */
function deterministicMessageId(jobId) { return uuidv5(`msg:${jobId}`); }

function deliverableUrl(job) {
  return (job && (job.rendered_video_url || job.result_url)) || null;
}

/** The delivery fields — and ONLY the delivery fields — a render message carries.
 *  camelCase, matching the shape the client already stores (verified against 19
 *  live messages: id, role, content, jobId, jobStatus, originalVibe,
 *  renderedVideoUrl, hlsManifestUrl). Null-valued keys are omitted rather than
 *  written as null, so a heal never introduces a key the client did not have. */
function deliveryFields(job) {
  const out = { jobStatus: 'completed', renderedVideoUrl: deliverableUrl(job) };
  if (job.hls_manifest_url) out.hlsManifestUrl = job.hls_manifest_url;
  if (job.thumbnail_url) out.thumbnailUrl = job.thumbnail_url;
  return out;
}

/** The full assistant message for a render that has no message anywhere yet. */
function buildRenderMessage(job) {
  return {
    id: deterministicMessageId(job.id),
    role: 'assistant',
    content: '',
    jobId: job.id,
    originalVibe: job.vibe_input || '',
    ...deliveryFields(job),
  };
}

/** Fill this render's delivery fields into an existing message array, in place.
 *  Returns {next, changed}. `changed` false means the chat is already correct
 *  and MUST NOT be written — a no-op write would burn a CAS and bump updated_at
 *  for nothing, which is how a backstop turns into a write amplifier. */
function healMessages(messages, job) {
  const fields = deliveryFields(job);
  let changed = false;
  const next = (Array.isArray(messages) ? messages : []).map((m) => {
    if (!m || typeof m !== 'object' || m.jobId !== job.id) return m;
    const patched = { ...m };
    for (const [k, v] of Object.entries(fields)) {
      if (patched[k] !== v) { patched[k] = v; changed = true; }
    }
    // A bubble the client left mid-render also carries stale progress.
    if (patched.jobProgress !== undefined && patched.jobProgress !== 100) {
      patched.jobProgress = 100; changed = true;
    }
    return patched;
  });
  return { next, changed };
}

/** The chat (if any) already holding this render, scoped to its owner.
 *  Uses jsonb containment — PROVEN against live data before this was built:
 *  a known jobId returned exactly its known chat, both unscoped and
 *  user-scoped, and a fake id returned none. */
async function findChatHoldingJob(supabaseAdmin, userId, jobId) {
  const { data, error } = await supabaseAdmin
    .from('chats')
    .select('id, user_id, messages, updated_at')
    .eq('user_id', userId)
    .contains('messages', [{ jobId }])
    .limit(1);
  if (error) throw new Error(`chat lookup failed: ${error.message}`);
  return (Array.isArray(data) && data[0]) || null;
}

/**
 * Guarantee this render is in a chat. Idempotent, non-clobbering, and safe to
 * call from anywhere (the completion tail, the sweep, a backfill).
 *
 * Returns {attached, reason, chat_id?} — `attached:true` means the render IS in
 * a chat now, whether this call put it there or found it already correct.
 */
async function attachRenderToChat(supabaseAdmin, job, { log = console } = {}) {
  if (!job || !job.id || !job.user_id) {
    return { attached: false, reason: 'incomplete_job_row' };
  }
  // §5: only a completed render with something playable ever attaches.
  if (!deliverableUrl(job)) return { attached: false, reason: 'no_deliverable' };

  let chat = null;
  try {
    chat = await findChatHoldingJob(supabaseAdmin, job.user_id, job.id);
  } catch (e) {
    return { attached: false, reason: `lookup_failed:${e.message}` };
  }

  // ── PATH A: the message exists. Heal it in place, under a CAS. ────────────
  if (chat) {
    for (let attempt = 1; attempt <= CAS_ATTEMPTS; attempt += 1) {
      const { next, changed } = healMessages(chat.messages, job);
      if (!changed) {
        return { attached: true, reason: 'already_current', chat_id: chat.id };
      }
      let q = supabaseAdmin
        .from('chats')
        .update({ messages: next, updated_at: new Date().toISOString() })
        .eq('id', chat.id);
      // THE CAS — house idiom. A null updated_at is matched AS null, never
      // skipped; a silently-dropped guard is how the lost-update class returns.
      q = (chat.updated_at === null || chat.updated_at === undefined)
        ? q.is('updated_at', null)
        : q.eq('updated_at', chat.updated_at);
      // eslint-disable-next-line no-await-in-loop
      const { data: won, error: updErr } = await q.select('id');
      if (updErr) return { attached: false, reason: `heal_failed:${updErr.message}` };
      if (Array.isArray(won) && won.length > 0) {
        return { attached: true, reason: 'healed_in_place', chat_id: chat.id };
      }
      // 0 rows: the client PATCHed under us. Re-read and re-merge — NEVER
      // re-issue the stale array, which is precisely the erasing write.
      log.log(`[chat-attach] job=${String(job.id).slice(0, 8)} CAS miss on attempt `
        + `${attempt} — the chat changed under the read; re-reading`);
      // eslint-disable-next-line no-await-in-loop
      chat = await findChatHoldingJob(supabaseAdmin, job.user_id, job.id);
      if (!chat) break;   // the client removed it; fall through to reconstruct
    }
    if (chat) {
      // Declining is the safe end state: the sweep retries within minutes.
      return { attached: false, reason: 'cas_exhausted', chat_id: chat.id };
    }
  }

  // ── PATH B: the leak case. The client's PATCH never landed. ───────────────
  // Reconstruct, with a PK derived from the job so a concurrent identical
  // insert collides instead of duplicating.
  //
  // The title and the history position come from columns the completion tail
  // does not have in scope, so they are fetched HERE and only here — the heal
  // path above (the common case) pays nothing for them, and the call site never
  // has to reference an identifier that does not exist in its scope.
  let src = job;
  if (job.vibe_input === undefined || job.created_at === undefined) {
    const { data: row } = await supabaseAdmin
      .from('video_jobs')
      .select('vibe_input, created_at')
      .eq('id', job.id)
      .maybeSingle();
    src = { ...job, ...(row || {}) };
  }
  const chatId = deterministicChatId(job.id);
  const title = String(src.vibe_input || '').trim().slice(0, 60) || 'Your video';
  const row = {
    id: chatId,
    user_id: job.user_id,
    title,
    messages: [
      { id: uuidv5(`umsg:${job.id}`), role: 'user', content: src.vibe_input || '' },
      buildRenderMessage(src),
    ],
    // Sort into real history rather than jumping to the top of the list.
    created_at: src.created_at || new Date().toISOString(),
    updated_at: src.created_at || new Date().toISOString(),
  };
  const { error: insErr } = await supabaseAdmin.from('chats').insert(row);
  if (insErr) {
    // 23505 = unique_violation: someone derived the same id first. That is the
    // design working, not a failure.
    if (insErr.code === '23505' || /duplicate key/i.test(insErr.message || '')) {
      return { attached: true, reason: 'raced_already_created', chat_id: chatId };
    }
    return { attached: false, reason: `create_failed:${insErr.message}` };
  }
  return { attached: true, reason: 'chat_reconstructed', chat_id: chatId };
}

/** Completed renders in the recent window — the sweep's candidate set. */
async function findRecentRenders(supabaseAdmin, { lookbackHours = DEFAULT_LOOKBACK_HOURS,
                                                  limit = DEFAULT_SWEEP_LIMIT } = {}) {
  const since = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('video_jobs')
    .select('id, user_id, created_at, vibe_input, rendered_video_url, '
            + 'hls_manifest_url, thumbnail_url')
    .eq('status', 'completed')
    .not('rendered_video_url', 'is', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`recent-renders query failed: ${error.message}`);
  return data || [];
}

/**
 * The backstop (§3). The inline attach runs in the completion tail, and that
 * tail is NOT reliable — lib/completion-reconcile.js exists because an
 * in-process Map does not survive a deploy, and content-studio auto-deploys
 * main. So the inline path gives immediacy and this gives the guarantee.
 *
 * Bounded on purpose: a short lookback and a hard limit, because after the
 * inline path lands the expected number of repairs per pass is ZERO and this
 * should cost almost nothing. Loud when it does find something — a silent
 * self-heal is how the undelivered-completions class stayed invisible for six
 * days.
 */
async function sweepChatAttach(supabaseAdmin, { lookbackHours, limit, log = console } = {}) {
  const jobs = await findRecentRenders(supabaseAdmin, { lookbackHours, limit });
  if (!jobs.length) return { scanned: 0, missing: 0, attached: 0, results: [] };

  const missing = [];
  for (const job of jobs) {
    // eslint-disable-next-line no-await-in-loop
    const chat = await findChatHoldingJob(supabaseAdmin, job.user_id, job.id)
      .catch(() => null);
    if (!chat) missing.push(job);
  }
  if (!missing.length) return { scanned: jobs.length, missing: 0, attached: 0, results: [] };

  log.error(`[ALERT] renders in no chat: ${missing.length} of ${jobs.length} recent `
    + `completion(s) — ${missing.map((j) => String(j.id).slice(0, 8)).join(', ')}`);
  const results = [];
  for (const job of missing) {
    // eslint-disable-next-line no-await-in-loop
    const out = await attachRenderToChat(supabaseAdmin, job, { log });
    results.push({ id: job.id, user_id: job.user_id, ...out });
    log.error(`[ALERT] render-in-no-chat job=${String(job.id).slice(0, 8)} `
      + `user=${String(job.user_id || '').slice(0, 8)} -> ${out.reason}`);
  }
  return {
    scanned: jobs.length,
    missing: missing.length,
    attached: results.filter((r) => r.attached).length,
    results,
  };
}

module.exports = {
  CHAT_ATTACH_NAMESPACE,
  DEFAULT_LOOKBACK_HOURS,
  DEFAULT_SWEEP_LIMIT,
  CAS_ATTEMPTS,
  uuidv5,
  deterministicChatId,
  deterministicMessageId,
  deliverableUrl,
  deliveryFields,
  buildRenderMessage,
  healMessages,
  findChatHoldingJob,
  attachRenderToChat,
  findRecentRenders,
  sweepChatAttach,
};

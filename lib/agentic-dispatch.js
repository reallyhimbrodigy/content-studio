'use strict';

// ── THE AGENTIC WIRE: DISPATCH AND COLLECT ──────────────────────────────────
//
// Dispatch spawns and returns in milliseconds. Collection is a separate sweep
// reading our own storage (see lib/agentic-collect.js for why it is not a poll
// on a call_id). Both are inert while the route is dark, and inert for a
// structural reason rather than a checked one: nothing carries
// pipeline='agentic' until routeForNewJob() says so, and the sweep selects on
// that column. Off, it finds zero rows and does zero work.

const { presignResultUrl, collectAgenticResult } = require('./agentic-collect');
const { validateAgenticPlan } = require('./agentic-plan');
const { sourceKeyFromUrl } = require('./source-presence');
const s3 = require('../services/s3');

const DEFAULT_SWEEP_LIMIT = 40;
const DEFAULT_LOOKBACK_HOURS = 6;
const DISPATCH_TIMEOUT_MS = 20_000;

/**
 * Spawn one agentic edit. ONE SOURCE PER CALL — the batch-pricing design was
 * deleted on both sides, because RC checks and deducts atomically and a
 * price-then-dispatch pass is that race one process further away. Ten sources
 * is ten calls, each gated by its own debit.
 *
 * `mode` is NOT sent. The worker derives it from whether prior_plan is present,
 * in exactly one place, and refuses to read it from the request body — a
 * caller-supplied mode would let the client decide whether it pays, since
 * shouldDebit() is false for every re-edit variant. Sending one from here would
 * hand back the same authority the worker just took away.
 */
async function dispatchAgentic({
  baseUrl, jobId, sourceKey, srcUrl, outUrl, outKey, brief,
  priorPlan = null, instruction = null, log = console, fetchImpl = fetch,
}) {
  if (!baseUrl) throw new Error('dispatchAgentic: baseUrl required');
  if (!jobId) throw new Error('dispatchAgentic: jobId required');

  // PRIOR PLAN IS VALIDATED BEFORE IT LEAVES. The worker refuses a dict on
  // prior_plan and says which shape it expected — but that refusal is the last
  // line, not the design. An invalid plan here means we would be asking for a
  // modification of something that is not a plan; dispatching it as a plain
  // edit instead would be trap 3 (a fresh edit wearing a re-edit's name), so
  // this REFUSES rather than silently downgrading.
  if (priorPlan !== null && priorPlan !== undefined) {
    const v = validateAgenticPlan(priorPlan);
    if (!v.ok) {
      const e = new Error(`prior_plan is not a plan: ${v.reason}`);
      e.code = 'BAD_PRIOR_PLAN';
      throw e;
    }
  }

  const resultUrl = await presignResultUrl(jobId);
  const body = {
    job_id: jobId,
    source_key: sourceKey,
    brief,
    src_url: srcUrl,
    out_url: outUrl,
    out_key: outKey,
    // The presigned PUT the worker writes its result JSON to BEFORE returning.
    // This is what makes collection survive a deploy.
    result_url: resultUrl,
  };
  if (priorPlan) body.prior_plan = priorPlan;
  if (instruction) body.instruction = instruction;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DISPATCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/run_agentic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* reported below */ }
  if (!res.ok || !json || json.spawned !== true) {
    const e = new Error(`run_agentic ${res.status}: ${String(text).slice(0, 300)}`);
    e.code = 'DISPATCH_FAILED';
    e.status = res.status;
    throw e;
  }
  log.log(`[agentic] job=${String(jobId).slice(0, 8)} spawned call=${json.call_id} `
    + `mode=${json.mode}`);
  // call_id is recorded because it is useful, and depended on by nothing.
  return { spawned: true, callId: json.call_id || null, mode: json.mode || null };
}

/** 7 days — the SigV4 maximum, matching what the handler dispatcher grants a
 *  source. A job can sit queued a long time and a grant that expires first is a
 *  render that fails for a reason the user cannot see. */
const SOURCE_GRANT_S = 604_800;
const OUT_GRANT_S = 6 * 3600;

/**
 * Derive this job's URLs and spawn it. Kept here rather than at the call site so
 * server.js gets a branch, not a second copy of the presign logic — two copies
 * of "where renders land" is how a prefix migration half-lands.
 *
 * Mirrors the handler dispatcher deliberately: the same sourceKeyFromUrl, the
 * same renders-private/ prefix, the same 7-day source grant. An agentic render
 * is a render; it should not quietly land somewhere else.
 */
async function prepareAndDispatchAgentic({
  baseUrl, jobId, videoUrl, brief, priorPlan = null, instruction = null,
  log = console, fetchImpl = fetch,
}) {
  const sourceKey = sourceKeyFromUrl(videoUrl);
  if (!sourceKey) {
    const e = new Error(`no S3 key derivable from source url for job ${jobId}`);
    e.code = 'NO_SOURCE_KEY';
    throw e;
  }
  const outKey = `renders-private/${jobId}/${Date.now()}-edited.mp4`;
  const [srcUrl, outUrl] = await Promise.all([
    s3.createPresignedGetUrl(sourceKey, SOURCE_GRANT_S),
    s3.createPresignedPutUrl(outKey, OUT_GRANT_S),
  ]);
  return dispatchAgentic({
    baseUrl, jobId, sourceKey, srcUrl, outUrl, outKey, brief,
    priorPlan, instruction, log, fetchImpl,
  });
}

/**
 * Collect finished agentic edits. Selects on `pipeline`, which is the fact
 * stored at creation — NOT on which plan column is populated, because a job
 * whose plan write failed would then read as the other pipeline.
 */
async function sweepAgentic(supabaseAdmin, {
  limit = DEFAULT_SWEEP_LIMIT, lookbackHours = DEFAULT_LOOKBACK_HOURS, log = console,
} = {}) {
  const since = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('video_jobs')
    .select('id, user_id, status, agentic_plan')
    .eq('pipeline', 'agentic')
    .not('status', 'in', '(completed,failed,canceled,needs_input)')
    .gte('created_at', since)
    .limit(limit);
  if (error) throw new Error(`agentic sweep read failed: ${error.message}`);

  const out = { scanned: (data || []).length, done: 0, failed: 0, running: 0, unreadable: 0 };
  for (const job of data || []) {
    let r;
    try {
      // eslint-disable-next-line no-await-in-loop
      r = await collectAgenticResult(job.id, { log });
    } catch (e) {
      // A storage outage is UNMEASURABLE, not a failed edit. Leave the row
      // alone and let the next pass try — terminalizing here would kill live
      // renders every time S3 hiccups.
      log.error(`[agentic] job=${String(job.id).slice(0, 8)} collect threw: ${e && e.message}`);
      continue;
    }
    if (r.state === 'RUNNING') { out.running += 1; continue; }

    if (r.state === 'UNREADABLE') {
      // LOUD, AND NOT TERMINAL. This is a defect on OUR side — we could not
      // understand what the worker wrote — and swallowing it into `failed`
      // would bury it in a bucket we expect to be non-empty. The reaper owns
      // the eventual timeout; this owns saying so.
      out.unreadable += 1;
      log.error(`[ALERT] agentic result UNREADABLE job=${job.id} user=${job.user_id} `
        + `— ${r.reason}`);
      continue;
    }

    if (r.state === 'FAILED') {
      out.failed += 1;
      // eslint-disable-next-line no-await-in-loop
      await _terminalize(supabaseAdmin, job, {
        status: 'failed',
        error_message: r.message || 'The edit could not be completed.',
        result: {
          error_code: r.code,
          // The bleed meter separates designed refusals from real errors. A
          // refusal bucketed as an error is what once made one user's clip
          // read as an outage.
          designed_refusal: r.designedRefusal,
        },
      }, log);
      continue;
    }

    // DONE. The plan goes to its OWN column — never edit_recipe, which
    // handler's tweak path reads as a dict.
    out.done += 1;
    // eslint-disable-next-line no-await-in-loop
    await _terminalize(supabaseAdmin, job, {
      status: 'completed',
      agentic_plan: r.plan,
      result: r.result,
    }, log);
  }
  if (out.unreadable || out.failed) {
    log.error(`[agentic] sweep: ${JSON.stringify(out)}`);
  }
  return out;
}

/**
 * Write a terminal state, guarded so it can never overwrite one. Same house
 * idiom as terminalizeFailure: an already-terminal row matches zero rows and
 * the write is a NO-OP, because a later, vaguer failure overwriting a real
 * cause is the failure the guard exists for.
 */
async function _terminalize(supabaseAdmin, job, patch, log) {
  const { data, error } = await supabaseAdmin
    .from('video_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', job.id)
    .not('status', 'in', '(completed,failed,canceled,needs_input)')
    .select('id');
  if (error) {
    log.error(`[agentic] job=${String(job.id).slice(0, 8)} terminal write failed: ${error.message}`);
    return false;
  }
  const won = Array.isArray(data) && data.length > 0;
  if (!won) {
    log.log(`[agentic] job=${String(job.id).slice(0, 8)} already terminal — no-op`);
  }
  return won;
}

module.exports = {
  DEFAULT_SWEEP_LIMIT, DEFAULT_LOOKBACK_HOURS, DISPATCH_TIMEOUT_MS,
  SOURCE_GRANT_S, OUT_GRANT_S,
  dispatchAgentic, prepareAndDispatchAgentic, sweepAgentic,
};

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
const { authHeaders: _auth } = require('./chatcut-secret');
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
  priorPlan = null, instruction = null, isFirstParty = false,
  // INJECTED SO A CHECK CAN DRIVE IT. "Anything a check must exercise is a
  // function the check CALLS with real inputs" — reading process.env directly here
  // would mean the only way to test that the secret rides is to mutate the
  // process's environment, and a test that does that leaks into its neighbours.
  env = process.env,
  log = console, fetchImpl = fetch,
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
  // ── first_party: THE WORKER'S PERMISSION GATE, AND IT IS NOT OURS ──────
  //
  // B1 2026-09-25: the worker runs Zac's written-permission gate before
  // spending a byte. measured/CHATCUT_WRITTEN_PERMISSION.json is ABSENT today,
  // so customer_traffic_allowed() reads REFUSED — which is the rule working,
  // not a bug: "nothing carries customer traffic until ChatCut says yes in
  // writing." Zac's own accounts are not customer traffic, and the ONLY thing
  // that can tell the worker so is this request.
  //
  // IT IS THE ALLOWLIST AND NOTHING ELSE. Never derived from percent or
  // enabled_all — those admit CUSTOMERS, and a job that reached ChatCut
  // through the percentage marking itself first-party would be using Zac's
  // exemption to spend on somebody else's video. That is why this reads the
  // allowlist directly rather than reusing the ramp's `allowed`, which is true
  // for all three rungs.
  //
  // ABSENT, NOT false, for everyone else: B1's gate refuses on absence, so a
  // field we forget to send fails CLOSED.
  if (isFirstParty) body.first_party = true;
  if (priorPlan) body.prior_plan = priorPlan;
  if (instruction) body.instruction = instruction;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DISPATCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/run_agentic`, {
      method: 'POST',
      // THE CALLER SECRET RIDES HERE TOO. It did not, and job 5af26805 routed
      // correctly at 07:43:57Z and then died at 07:43:59Z on
      //   run_agentic 401 {"state":"REFUSED","auth":"REQUIRED",
      //     "why":"this container carries a caller secret and the request sent none"}
      // "sent none" — this call went to the same container as /account_status and
      // carried no auth at all, while the guard next door resolved and sent it.
      //
      // IT WAS INVISIBLE BECAUSE THE GUARD RUNS FIRST AND FAILS CLOSED. While the
      // guard was broken every job fell back before reaching this line, so the
      // missing header could not produce a symptom. The first job to pass the
      // guard is the first job that ever tried to dispatch for real.
      headers: { 'Content-Type': 'application/json', ..._auth(env) },
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
  isFirstParty = false,
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
    priorPlan, instruction, isFirstParty, log, fetchImpl,
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
    // `agentic_plan` WAS selected here and never read. Measured 2026-09-21:
    // 825 shared buffer blocks per call, 15,554 calls, entirely for a binding
    // nothing touches — collectAgenticResult takes (jobId, {log}) and the only
    // other mention of agentic_plan in this file is a WRITE in the patch below.
    // A property read into an unused binding, paid for on every pass.
    .select('id, user_id, status')
    .eq('pipeline', 'agentic')
    // ── THE POSITIVE LIST, BECAUSE THE DOMAIN IS CLOSED AND ENFORCED ─────
    //
    // This was `.not('status','in','(completed,failed,canceled,needs_input)')`
    // and I argued for keeping it: a sweep FINISHES work, so a status missing
    // from a positive list is a job that is never collected. That argument was
    // wrong here, and the database says so:
    //
    //   valid_status CHECK (status = ANY (ARRAY['queued','processing',
    //       'completed','failed','canceled','needs_input']))
    //
    // The domain is SIX values, enforced. Four are terminal. So "not the four
    // terminal ones" and "queued or processing" are EXACTLY EQUIVALENT, and
    // the positive form loses no coverage at all. I had worried about
    // `needs_clarification`, which the codebase does write — to a different
    // table. This constraint forbids it here.
    //
    // AND ONLY THE POSITIVE FORM CAN BE INDEXED. Postgres cannot prove
    // `status <> ALL(terminal)` implies `status = ANY(queued,processing)` —
    // correctly, since without the constraint it does not. MEASURED on the
    // live table 2026-09-25, same query, same moment:
    //   NOT IN form  -> Index Scan using idx_video_jobs_status_updated
    //                   Filter: pipeline AND status, Rows Removed 21
    //                   Buffers: shared hit=39
    //   IN form      -> Index Scan using idx_video_jobs_agentic_inflight
    //                   Index Cond: updated_at only, NO Filter line
    //                   Buffers: shared hit=2
    //
    // THE EQUIVALENCE IS LOAD-BEARING AND IT IS AN ASSUMPTION ABOUT A
    // CONSTRAINT. Add a seventh status without adding it here and this sweep
    // silently stops collecting those jobs — they would run forever and never
    // terminalize. __smoke_agentic_sweep_statuses pins the pair.
    .in('status', ['queued', 'processing'])
    // BOUND ON updated_at, not created_at. A long-running agentic job keeps its
    // original created_at, so a created_at window silently drops exactly the
    // rows this sweep exists to finish; updated_at moves with the work.
    .gte('updated_at', since)
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

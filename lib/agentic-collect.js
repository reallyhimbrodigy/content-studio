'use strict';

// ── COLLECTING AN AGENTIC RESULT, WITHOUT DEPENDING ON THIS PROCESS ─────────
//
// The worker offered a `call_id` and a poll. Asked how long a call_id stays
// resolvable across a deploy, it answered "I do not know, and I am not willing
// to find out on your traffic" and removed the dependency instead: it now
// writes the full result JSON to a presigned PUT before returning.
//
// That matters here more than it looks. main auto-deploys, and this repo has
// already paid for the other design — the completion tail sat behind an
// in-process await that no deploy survived, which is why completion-reconcile
// and the durable poller exist at all. A poll keyed on a call_id held in this
// process is that shape again.
//
// So collection is a read of OUR OWN STORAGE at a key DERIVED FROM THE JOB ID.
// Nothing is held in memory, nothing is handed between processes, and a deploy
// mid-edit strands nothing: whatever process is running afterwards can compute
// the key from the row it is already reading.
//
// AN ABSENT OBJECT IS NOT A FAILURE. It means the worker has not written yet —
// state RUNNING. This is the empty-success rule pointed the other way: there,
// a 200 with [] was read as authoritative emptiness; here, a 404 must not be
// read as a failed edit. A render polled forever is bad; a render declared dead
// while it is still rendering is worse, because the credit is refunded and the
// video still lands.

const s3 = require('../services/s3');
const { validateAgenticPlan } = require('./agentic-plan');

// The worker writes JSON. A plan for a long video is large but bounded; this is
// generous enough not to trip on a real one and small enough that a wrong key
// pointing at a 4GB render is refused instead of buffered.
const MAX_RESULT_BYTES = 8 * 1024 * 1024;

// UNSUPPORTED is a DESIGNED REFUSAL, not an error — the distinction the bleed
// meter needs, and the reason the worker gives codes rather than strings. The
// rest are real errors. An unknown code is kept VERBATIM rather than mapped to
// INTERNAL: a code we have not seen is information, and flattening it is how a
// class hides.
// A DESIGNED REFUSAL IS THE PRODUCT SAYING NO ON PURPOSE — the user asked for
// something we do not do. It is NOT the word for our own operational failure.
//
// EDITOR_TAB_OPEN IS DELIBERATELY NOT HERE. Somebody left a tab open; that is our
// fault, not a refusal of the customer's request, and marking it designed would
// tell the refund leg the charge was legitimate. The customer must be refunded for
// this, and leaving it out of this set is what refunds them.
const DESIGNED_REFUSALS = new Set(['UNSUPPORTED']);
const KNOWN_CODES = new Set([
  'BAD_REQUEST', 'UNSUPPORTED', 'SOURCE_UNREADABLE',
  'AGENT_FAILED', 'RENDER_FAILED', 'UPLOAD_FAILED', 'INTERNAL',
  // ── EDITOR_TAB_OPEN (B1, 2026-09-26) ────────────────────────────────────
  //
  // TERMINAL, AND RETRYING IT CANNOT WORK. Proven A-B-A on one project with an
  // editor tab held open on a SECOND MACHINE, different browser, different
  // session: no tab -> cloud renderId; tab open elsewhere -> a browser-handoff
  // card with no renderId; tab closed -> cloud renderId again. An editor page
  // open ANYWHERE on the project changes what ChatCut hands back, and the worker
  // is left with nothing to poll.
  //
  // IT IS HERE ONLY SO IT STOPS READING AS AN UNKNOWN CODE. The unknown-code path
  // already kept it verbatim and logged loudly, which is why no change was needed
  // to surface it; allowlisting it removes the noise and records what it means.
  //
  // B1 NAMED IT FOR THE ACTION, NOT THE SYMPTOM, and that matters to the next
  // reader: the fix is for a human to close a tab. He rejected BROWSER_HANDOFF on
  // the same grounds this file would reject RENDER_FAILED for it — a name that
  // describes what ChatCut did invites the retry that is guaranteed to fail.
  //
  // AND IT NAMES ONLY THE TERMINAL CASE. The same live-project card also appears
  // when the project has simply not settled after the last write, and a settle
  // genuinely fixes that one — measured. So his retry stayed keyed on the settle
  // path rather than on the card, and four of his thirteen legs exist to assert
  // that path still behaves as it did. What that buys us: seeing EDITOR_TAB_OPEN
  // means the settle was ALREADY tried and did not help. It is final.
  'EDITOR_TAB_OPEN',
]);

/** Derived from the job id alone. That is the whole deploy-survivability story. */
function agenticResultKey(jobId) {
  if (!jobId) throw new Error('agenticResultKey: jobId required');
  return `agentic-results/${jobId}.json`;
}

/** The presigned PUT handed to the worker as `result_url`. */
function presignResultUrl(jobId, expiresIn = 6 * 3600) {
  return s3.createPresignedPutUrl(agenticResultKey(jobId), expiresIn);
}

/**
 * Read whatever the worker has written for this job.
 *
 * Returns one of:
 *   { state: 'RUNNING' }                        nothing written yet
 *   { state: 'DONE', plan, planEntries, result }
 *   { state: 'FAILED', code, designedRefusal, message }
 *   { state: 'UNREADABLE', reason }             written, but not usable
 *
 * UNREADABLE is deliberately NOT folded into FAILED. A failed edit is the
 * worker telling us something; an unreadable result is US failing to understand
 * it, and the two want different responses — the first is reported to the user,
 * the second is a defect on this side that must be loud.
 */
async function collectAgenticResult(jobId, { log = console } = {}) {
  const key = agenticResultKey(jobId);
  let raw;
  try {
    raw = await s3.getObjectBuffer(key, MAX_RESULT_BYTES);
  } catch (e) {
    const name = String((e && (e.name || e.Code || e.code)) || '');
    if (/NoSuchKey|NotFound|404/i.test(name) || e?.$metadata?.httpStatusCode === 404) {
      return { state: 'RUNNING' };            // not written YET — never a failure
    }
    if (e && e.statusCode === 413) {
      return { state: 'UNREADABLE', reason: `result too large (${e.detail?.size} bytes)` };
    }
    throw e;                                   // a real storage outage must surface
  }

  let body;
  try {
    body = JSON.parse(raw.buffer.toString('utf8'));
  } catch (e) {
    return { state: 'UNREADABLE', reason: `result is not JSON: ${e.message}` };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { state: 'UNREADABLE', reason: 'result is not a JSON object' };
  }

  const state = String(body.state || '').toUpperCase();

  if (state === 'FAILED') {
    const code = String(body.error_code || body.code || '').toUpperCase() || 'INTERNAL';
    if (!KNOWN_CODES.has(code)) {
      log.error(`[agentic] job=${String(jobId).slice(0, 8)} unknown failure code ${code} `
        + '— kept verbatim rather than mapped to INTERNAL');
    }
    return {
      state: 'FAILED',
      code,
      designedRefusal: DESIGNED_REFUSALS.has(code),
      message: typeof body.error === 'string' ? body.error : null,
    };
  }

  if (state === 'RUNNING') return { state: 'RUNNING' };

  if (state !== 'DONE') {
    return { state: 'UNREADABLE', reason: `unrecognised state ${JSON.stringify(body.state)}` };
  }

  // DONE. The plan is validated HERE, before it can reach a column, because
  // this is the boundary where an untrusted body becomes our data.
  const plan = body.result && body.result.plan;
  const v = validateAgenticPlan(plan);
  if (!v.ok) {
    // A DONE with no usable plan is not a done edit. Saying so is the whole
    // point of plan_entries existing: an empty plan would otherwise be stored,
    // handed back as prior_plan, and read by the worker as "modify nothing".
    return { state: 'UNREADABLE', reason: `DONE but the plan is unusable: ${v.reason}` };
  }
  return { state: 'DONE', plan, planEntries: v.entries, result: body.result };
}

module.exports = {
  MAX_RESULT_BYTES, DESIGNED_REFUSALS, KNOWN_CODES,
  agenticResultKey, presignResultUrl, collectAgenticResult,
};

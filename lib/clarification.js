'use strict';

// THE PARKED CLARIFICATION — a question the worker asked that nothing delivered.
//
// MEASURED 2026-09-21: 19 rows, 8 distinct users, oldest 63 days, every one a
// re-edit, all sitting at progress=100 / current_step='needs_clarification'.
// The worker classifies a change_request it cannot map to fields as
// `needs_clarification` and writes (handler.py, classification branch):
//     status = "needs_input"
//     result = { "clarification_question": <the question> }
// The questions are real: "Done ?", "You didn't edit anything", "Just adjust my
// shirt button", in Hindi, Portuguese, Urdu and English.
//
// THREE SEPARATE WIRES WERE CUT, each sufficient on its own:
//   1. GET /api/video-jobs/:id returned `ask: data.ask || null` — the TOP-LEVEL
//      column, which this path never writes. The question was not in the
//      response at all.
//   2. canAcceptAnswer (lib/ask.js) requires `job.ask.ask_id`; with ask NULL it
//      always returns ask_id_mismatch, so every answer 409'd as a "safe no-op".
//   3. the client branched on `event.status == "needs_clarification"`, but the
//      SSE frame's status is computed `pct >= 100 ? 'completed' : 'processing'`
//      — that value cannot appear in a frame. It read "completed".
//
// DO NOT CONFUSE THIS WITH PHASE D ASK-BACK. They share the `needs_input`
// status and nothing else. Ask-back writes `result.ask` + `partial_state` and is
// flag-gated off: 0 rows in the entire table have ever had either, out of
// 12,697. Its resume rail loads partial_state, so routing a clarification onto
// it would hand the worker an empty state blob.
//
// WHICH IS WHY ANSWERING IS NOT A RESUME. A clarification row is a re-edit whose
// change_request was too vague. The answer to "describe the change in more
// detail" IS a better change_request — so the reply is a NEW re-edit off the
// same parent, through the endpoint that already exists. No synthetic ask_id, no
// new rail, and it works for 19 of 19 rows today (all have a completed parent
// carrying a video; none is parentless — verified, not assumed).

const DAY_MS = 24 * 60 * 60 * 1000;

// Zac's ruling: a parked ask must be answerable or cancellable, and it expires.
// 24 hours unanswered -> canceled, releasing the root lock.
const EXPIRY_MS = DAY_MS;

/** The question text, or null. Reads `result`, never the `ask` column. */
function questionOf(row) {
  const r = row && row.result;
  if (!r || typeof r !== 'object') return null;
  const q = r.clarification_question;
  if (typeof q !== 'string') return null;
  const t = q.trim();
  return t.length ? t : null;
}

/**
 * Is this row a parked CLARIFICATION (as opposed to a Phase D ask-back park)?
 *
 * Both sit at needs_input. The discriminator is which envelope is present, not
 * the status — reading the status alone is what let one mechanism's rows be
 * handled by the other's code path.
 */
function isClarificationPark(row) {
  if (!row || row.status !== 'needs_input') return false;
  return questionOf(row) !== null;
}

/**
 * The job a reply should be posted against: the parked row's PARENT, i.e. the
 * video being re-edited. Null when there is no parent to retry against — such a
 * row cannot be answered this way and must be cancelled instead, not silently
 * retried against itself.
 */
function retryTargetFor(row) {
  if (!row) return null;
  return row.parent_job_id ? String(row.parent_job_id) : null;
}

/**
 * The two fields a client needs to render the card and post the answer.
 * Returns nulls (not an absent key) for a row that is not a clarification park,
 * so the response shape is stable and a client never has to branch on presence.
 */
function deliveryFields(row) {
  if (!isClarificationPark(row)) {
    return { clarification_question: null, clarification_retry_job_id: null };
  }
  return {
    clarification_question: questionOf(row),
    clarification_retry_job_id: retryTargetFor(row),
  };
}

/** Has this park outlived the 24h clock? */
function isExpired(row, now) {
  if (!row || row.status !== 'needs_input') return false;
  const t = Date.parse(row.created_at);
  if (!Number.isFinite(t)) return false;           // unparseable: never expire it
  return (Number(now || Date.now()) - t) >= EXPIRY_MS;
}

/** Milliseconds until expiry, floored at 0. Null when it cannot be computed. */
function msUntilExpiry(row, now) {
  const t = Date.parse(row && row.created_at);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (t + EXPIRY_MS) - Number(now || Date.now()));
}

/** ISO instant the park expires, for the client's countdown. Null if unknown. */
function expiresAt(row) {
  const t = Date.parse(row && row.created_at);
  if (!Number.isFinite(t)) return null;
  return new Date(t + EXPIRY_MS).toISOString();
}

module.exports = {
  EXPIRY_MS,
  questionOf,
  isClarificationPark,
  retryTargetFor,
  deliveryFields,
  isExpired,
  msUntilExpiry,
  expiresAt,
};

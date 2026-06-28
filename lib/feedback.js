/**
 * Pure validation helpers for the in-app feedback endpoint.
 *
 * No I/O, no network, no requires — every function here is deterministic and
 * unit-testable. server.js wires these into the /api/feedback route; the
 * Supabase insert happens in the caller.
 *
 * Mirrors lib/submissions.js: CommonJS, defensive about untrusted input,
 * heavily commented at the trust boundaries.
 */

/** Allowed thumbs ratings. `null`/absent is also allowed (text-only feedback). */
const VALID_RATINGS = ['up', 'down'];

/** Length cap on the free-text body, to bound DB row size + abuse. */
const MAX_FEEDBACK_TEXT_LEN = 4000;

/** Length caps on the optional context strings. */
const MAX_JOB_ID_LEN = 128;
const MAX_APP_VERSION_LEN = 32;

/**
 * Is this rating one of the valid values?
 *
 * null/undefined are allowed (a text-only submission carries no rating).
 * Comparison is case-insensitive and trimmed.
 *
 * @param {string} rating
 * @returns {boolean}
 */
function isValidRating(rating) {
  if (rating === null || rating === undefined) return true;
  return VALID_RATINGS.includes(String(rating).toLowerCase().trim());
}

/**
 * Validate a full feedback payload before insert.
 *
 * On success returns a normalized `value` ready to persist: every optional
 * field collapses to null when absent/empty. At least one signal — a rating or
 * non-empty text — is required, so an empty submission is rejected.
 *
 * @param {Object} obj
 * @param {string} [obj.rating]       Optional; 'up', 'down', or null.
 * @param {string} [obj.text]         Optional; <=MAX_FEEDBACK_TEXT_LEN after trim.
 * @param {string} [obj.job_id]       Optional; <=MAX_JOB_ID_LEN after trim.
 * @param {string} [obj.app_version]  Optional; <=MAX_APP_VERSION_LEN after trim.
 * @returns {{ ok: true, value: { rating: string|null, text: string|null,
 *             job_id: string|null, app_version: string|null } }
 *          | { ok: false, error: string }}
 */
function validateFeedback({ rating, text, job_id, app_version } = {}) {
  // rating: optional. If present, must be 'up' or 'down' (case-insensitive).
  let validatedRating = null;
  if (rating !== null && rating !== undefined && String(rating).trim() !== '') {
    const r = String(rating).toLowerCase().trim();
    if (!VALID_RATINGS.includes(r)) {
      return { ok: false, error: `rating must be one of ${VALID_RATINGS.join(', ')} or null` };
    }
    validatedRating = r;
  }

  // text: optional, length-capped; empty/whitespace collapses to null.
  let validatedText = null;
  if (text) {
    const t = String(text).trim();
    if (t.length > MAX_FEEDBACK_TEXT_LEN) {
      return { ok: false, error: `text must be <= ${MAX_FEEDBACK_TEXT_LEN} characters` };
    }
    if (t) validatedText = t;
  }

  // Require at least one signal so empty submissions are rejected.
  if (validatedRating === null && validatedText === null) {
    return { ok: false, error: 'feedback must include a rating or non-empty text' };
  }

  // job_id: optional, length-capped; empty collapses to null.
  let validatedJobId = null;
  if (job_id) {
    const j = String(job_id).trim();
    if (j.length > MAX_JOB_ID_LEN) {
      return { ok: false, error: `job_id must be <= ${MAX_JOB_ID_LEN} characters` };
    }
    if (j) validatedJobId = j;
  }

  // app_version: optional, length-capped; empty collapses to null.
  let validatedAppVersion = null;
  if (app_version) {
    const v = String(app_version).trim();
    if (v.length > MAX_APP_VERSION_LEN) {
      return { ok: false, error: `app_version must be <= ${MAX_APP_VERSION_LEN} characters` };
    }
    if (v) validatedAppVersion = v;
  }

  return {
    ok: true,
    value: {
      rating: validatedRating,
      text: validatedText,
      job_id: validatedJobId,
      app_version: validatedAppVersion,
    },
  };
}

module.exports = {
  VALID_RATINGS,
  MAX_FEEDBACK_TEXT_LEN,
  MAX_JOB_ID_LEN,
  MAX_APP_VERSION_LEN,
  isValidRating,
  validateFeedback,
};

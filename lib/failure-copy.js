'use strict';

// User-facing failure copy for the dispatch failure writes (Frontend Wave 1,
// item 2 — copy hygiene). Fixed at the WRITE, not the display filter: what
// lands in video_jobs.error_message must already be clean cold-load copy,
// because the iOS display filters (displaySafeError / friendlySSEError)
// suppress anything technical-looking down to a generic retry line — which is
// exactly the class-blind copy that invites retries into deterministic
// failures.

// Path D (dispatch fetch threw / retries exhausted): the raw err.message is
// engineering text ("Modal fetch failed after retries", ECONNREFUSED …) and
// previously passed through verbatim. It stays in the server log; the user
// gets honest transient-failure copy. Retry here is legitimate — the dispatch
// class is transient by nature.
const DISPATCH_UNREACHABLE_COPY =
  'We had trouble reaching the render service. Please try again in a moment.';

/** Path D — the stored + SSE copy for a dispatch-level failure. */
function dispatchErrorMessage() {
  return DISPATCH_UNREACHABLE_COPY;
}

/**
 * Path B — re-edit needs_clarification: store the QUESTION itself, not the
 * old `needs_clarification: <question>` prefixed form (the prefix leaked
 * verbatim into cold-load bubbles; nothing anywhere parses it back).
 */
function clarificationMessage(question) {
  const q = String(question || '').trim();
  return q || 'Can you describe the change in more detail?';
}

module.exports = { dispatchErrorMessage, clarificationMessage, DISPATCH_UNREACHABLE_COPY };

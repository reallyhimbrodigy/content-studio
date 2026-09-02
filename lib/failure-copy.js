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

// Path D2 (2026-08-16): the worker WAS reached and died afterwards. Telling that
// user we could not reach the render service is simply false — it was reached,
// it started, it stamped worker_started_at, and it died mid-edit. ~50 jobs and
// 40 users got the wrong sentence over ten hours, and every investigation that
// sentence triggered began at the dispatcher, the one component that had worked.
//
// The copy stays honest about what the USER experiences (their edit failed, it
// was not their fault, a retry is reasonable) without naming a layer that was
// never at fault.
const WORKER_DIED_COPY =
  'Your edit started but stopped partway through. That is on us — nothing was '
  + 'wrong with your video. Please try again.';

/** Path D — the stored + SSE copy for a dispatch-level failure.
 *  `workerReached` selects the honest sentence: a worker that started and died
 *  is NOT an unreachable render service. */
function dispatchErrorMessage(workerReached = false) {
  return workerReached ? WORKER_DIED_COPY : DISPATCH_UNREACHABLE_COPY;
}

// ── The source never reached S3 (2026-08-02) ─────────────────────────────────
// The old line was "Your upload was interrupted before it finished. Check your
// connection and try again." Every word of that points the user back at the
// SAME upload — and the key is already dead, so retrying it can only fail
// again. Our first paying subscriber ran that loop three times over 6.5 hours.
//
// A fresh PICK mints a fresh key, and that is the only action that can work. So
// the copy names what is true (we never got the video) and the one step that
// recovers (pick it again), and confirms the credit is intact — a render that
// never had a source must not cost one.
const SOURCE_MISSING_COPY =
  "The video didn't reach us — pick it again to start a fresh upload. "
  + "You haven't been charged.";

/** The upload never landed: name it honestly, point at the ONE action that works. */
function sourceMissingMessage() {
  return SOURCE_MISSING_COPY;
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

// ── Per-error-code rejection copy (funnel fix, 2026-07-23) ───────────────────
// Every rejection must tell the user, in plain language, WHAT happened and the
// SPECIFIC next action — never a bare "something went wrong". These are the exact
// words 400+ users read right before they churned, so they carry the whole
// recovery: name the problem, give the one next step, and confirm it cost them
// nothing (every failed row refunds — the refund-leg law). SERVER-CANONICAL: the
// worker sends an error_code (+ its own user_message); the app OVERRIDES that
// string with the copy here so there is ONE source of truth for the words no
// matter the worker build. Unknown codes fall back to the worker's message, then
// to CORE. All are cold-load-filter-safe (no technical vocabulary).
const REJECTION_COPY = {
  // 0 words of speech detected (audible-no-speech or silence).
  NO_SPEECH:
    "We couldn't hear anyone speaking in this clip. Promptly edits talking-to-camera videos — upload one where you're speaking to the lens and we'll cut and caption it. You weren't charged.",
  // 0 words but a face is present, or non-English fell through — mic hint.
  NO_SPEECH_FACE:
    "We could see you but couldn't pick up clear speech — your mic may have been muted or too quiet. Try again with the mic on and speak up a little. You weren't charged.",
  NO_SPEECH_NONENGLISH:
    "We couldn't pick up clear speech to work with in this clip. Upload a video of someone talking to the camera and we'll edit it. You weren't charged.",
  // No audio track at all in the container.
  NO_AUDIO:
    "This video has no sound, so there's nothing for Promptly to caption or cut to. Upload a clip with audio of you talking and try again. You weren't charged.",
  NO_AUDIO_TRACK:
    "This video has no sound, so there's nothing for Promptly to caption or cut to. Upload a clip with audio of you talking and try again. You weren't charged.",
  // Rendered output below the minimum watchable length.
  RENDER_TOO_SHORT:
    "This one came out too short to be worth a render, so we returned it. Try again with a slightly longer take. You weren't charged.",
  // Input clip below the minimum length.
  TOO_SHORT:
    "This clip is a little too short for Promptly to edit. Record a slightly longer take of you talking and upload it again. You weren't charged.",
  // Input clip above the maximum length. (Non-numeric on purpose — the max is
  // moving to 3 min; the app's requires_new_video flag drives the trim flow.)
  CLIP_TOO_LONG:
    "This clip is longer than Promptly can edit in one go. Trim it to a shorter highlight and re-upload — you weren't charged.",
  TOO_LONG:
    "This clip is longer than Promptly can edit in one go. Trim it to a shorter highlight and re-upload — you weren't charged.",
  // A face-tracked video that isn't someone talking to camera.
  NOT_TALKING_HEAD:
    "Promptly is built for talking-to-camera videos, and we couldn't find someone speaking to the lens here. Upload a clip where you're talking to the camera and we'll do the rest. You weren't charged.",
  NO_SPEECH_FACE_ONLY:
    "Promptly is built for talking-to-camera videos, and we couldn't find someone speaking to the lens here. Upload a clip where you're talking to the camera and we'll do the rest. You weren't charged.",
  // The worker emits these three; before 2026-08-30 the sites had NO code, so
  // the app could not override them and they rendered ENGLISH to every reader.
  // Adding the code without adding the sentence here changes nothing — the
  // lookup returns null and the caller falls back to the worker's free text,
  // which is the same English. Both halves or neither.
  TIER_CONCURRENCY_LIMIT:
    "Your plan renders one video at a time. Wait for the one in progress to finish, or upgrade to run several at once. You weren't charged for this one.",
  SAMPLE_MISSING:
    "We couldn't start checking this video. Try uploading it again — you weren't charged.",
  SAMPLE_UNREADABLE:
    "We couldn't read this video file. Try uploading it again, or pick a different clip — you weren't charged.",
  // The integrity gate caught a defect in OUR OUTPUT (freeze/black/dead-moment
  // spans) and refused to deliver it. 38 trips across 29 users since 08-10 —
  // and until now this code had NO entry here, so every one of those readers
  // got the worker's English regardless of their device language. Found by the
  // code-assembled-English sweep, not by anyone reporting it.
  INTEGRITY_TRIP:
    "We spotted a glitch in the video we made and stopped it reaching you rather than sending something broken. Give it another go — you weren't charged.",
  // The request arrived without fields the pipeline needs. Rare and usually a
  // client-side bug, so the copy stays honest without blaming the user.
  MISSING_FIELDS:
    "Something went wrong sending this video for editing, so we couldn't start. Try again in a moment — you weren't charged.",
  // Our fault — a core pipeline error, not the user's video.
  CORE_ERROR:
    "Something went wrong on our end while editing this one — not your video. You weren't charged, so give it another try in a moment.",
};

const RENDER_TOO_SHORT_COPY = REJECTION_COPY.RENDER_TOO_SHORT;
const CORE_ERROR_COPY = REJECTION_COPY.CORE_ERROR;

/**
 * The server-canonical, user-actionable words for a worker error_code. Returns
 * null for an unmapped code so the caller can fall back to the worker's own
 * user_message before the generic CORE line. Case-insensitive.
 */
function rejectionCopy(errCode) {
  const c = String(errCode || '').toUpperCase();
  return REJECTION_COPY[c] || null;
}

/** RENDER_TOO_SHORT — stored + SSE copy for a below-minimum-length render. */
function renderTooShortMessage() {
  return RENDER_TOO_SHORT_COPY;
}

/** Generic our-fault fallback — never a raw error code to the user. */
function coreErrorMessage() {
  return CORE_ERROR_COPY;
}

// WALL (Wall Correctness item 2 edge): a `route:'wall'` 403 body's `message` is
// what a rare straggler actually sees — a NEW account on an OLD (pre-1.2.0)
// binary that has no wall UI to route to (installed before the update, signed up
// after the flip). Wall-capable clients (≥1.2.0) read the `route` field and show
// the wall UI, ignoring this string; the straggler falls back to the cold-load
// display, so the words must pass the SAME iOS filter as the failure copy AND
// read as a soft forced-update — a clean sentence, never a broken screen.
const WALL_UPDATE_COPY =
  'A new version of Promptly is required to continue — update to start your free trial.';

/** WALL — 403 body message for an enforced `.none` request (old-client fallback). */
function wallRequiredMessage() {
  return WALL_UPDATE_COPY;
}

module.exports = {
  WORKER_DIED_COPY,
  sourceMissingMessage,
  SOURCE_MISSING_COPY,
  dispatchErrorMessage,
  clarificationMessage,
  renderTooShortMessage,
  coreErrorMessage,
  rejectionCopy,
  wallRequiredMessage,
  DISPATCH_UNREACHABLE_COPY,
  RENDER_TOO_SHORT_COPY,
  CORE_ERROR_COPY,
  REJECTION_COPY,
  WALL_UPDATE_COPY,
};

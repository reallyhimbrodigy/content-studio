/**
 * Pure validation + policy helpers for the creator submission portal.
 *
 * No I/O, no network, no requires — every function here is deterministic and
 * unit-testable. server.js wires these into the /api/submissions/* routes
 * (presigned-URL minting, submission insert, admin review gating); the S3 and
 * Supabase work all happens in the caller.
 *
 * Mirrors lib/entitlement.js: CommonJS, defensive about untrusted input,
 * heavily commented at the trust boundaries.
 */

/**
 * Prefix every submission video S3 key is required to carry. server.js mints
 * keys as `submissions/<ts>-<uuid>-<safeName>`; isValidVideoKey then rejects any
 * client-supplied key that doesn't start here, so a creator can only attach
 * objects to a submission that the server itself handed them a presigned URL for.
 */
const SUBMISSION_KEY_PREFIX = 'submissions/';

/** Per-file ceiling for a single uploaded video. */
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024; // 1 GB

/** Hard cap on how many videos one submission may bundle. */
const MAX_VIDEOS_PER_SUBMISSION = 25;

/** Length caps on free-text fields, to bound DB row size + abuse. */
const MAX_NAME_LEN = 200;
const MAX_NOTES_LEN = 5000;
/** RFC 5321 max email length — bounds the stored string against abuse. */
const MAX_EMAIL_LEN = 254;

/** Allowed review states. `new` is the insert-time default. */
const VALID_STATUSES = ['new', 'approved', 'needs_changes'];

/**
 * Is this email on the submission-admin allowlist?
 *
 * @param {string} email      Caller's email (e.g. from the Supabase user).
 * @param {string} allowlist  Raw env string (SUBMISSION_ADMIN_EMAILS),
 *                             comma-separated. Comparison is case-insensitive
 *                             and trimmed on both sides.
 * @returns {boolean} false if either input is empty/missing.
 */
function isSubmissionAdmin(email, allowlist) {
  if (!email || !allowlist) return false;
  const normalizedEmail = String(email).toLowerCase().trim();
  if (!normalizedEmail) return false;
  const adminEmails = String(allowlist)
    .split(',')
    .map((e) => e.toLowerCase().trim())
    .filter(Boolean);
  return adminEmails.includes(normalizedEmail);
}

/**
 * Validate that a video S3 key looks server-generated and safe to trust.
 *
 * The client echoes back the keys it was handed at presign time, so this is a
 * trust boundary: enforce the prefix (so it can only reference the submissions
 * namespace), reject path-traversal (`..`), and cap the length.
 *
 * @param {string} key
 * @returns {boolean}
 */
function isValidVideoKey(key) {
  if (!key || typeof key !== 'string') return false;
  if (!key.startsWith(SUBMISSION_KEY_PREFIX)) return false;
  if (key.includes('..')) return false; // no path traversal
  if (key.length > 300) return false; // reasonable length cap
  return true;
}

/**
 * Is `status` one of VALID_STATUSES? Case-insensitive, trimmed.
 *
 * @param {string} status
 * @returns {boolean}
 */
function isValidStatus(status) {
  return VALID_STATUSES.includes(String(status || '').toLowerCase().trim());
}

/**
 * Validate a presigned-URL request from a creator before minting a PUT URL.
 *
 * @param {Object} obj
 * @param {string} obj.fileName     Client-supplied filename (untrusted).
 * @param {string} obj.contentType  Must start with 'video/'.
 * @param {number} obj.size         Byte count; 1..MAX_VIDEO_BYTES.
 * @returns {{ ok: true, safeName: string } | { ok: false, error: string }}
 *          safeName has every char outside [a-zA-Z0-9._-] replaced with '_'
 *          and falls back to 'video.mp4'.
 */
function validateUploadRequest({ fileName, contentType, size } = {}) {
  // Content type must be a video/* MIME type.
  if (!String(contentType || '').toLowerCase().startsWith('video/')) {
    return { ok: false, error: 'Content type must be video/*' };
  }

  // Size: a positive integer-ish number, 1 byte up to the per-file ceiling.
  const sizeNum = Number(size);
  if (!Number.isFinite(sizeNum) || sizeNum < 1 || sizeNum > MAX_VIDEO_BYTES) {
    return { ok: false, error: `File size must be 1 to ${MAX_VIDEO_BYTES} bytes` };
  }

  // Sanitize the filename: collapse anything unsafe to '_', cap length, and
  // fall back to a default if the result is empty.
  let safeName = String(fileName || 'video.mp4')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, MAX_NAME_LEN);
  if (!safeName) safeName = 'video.mp4';

  return { ok: true, safeName };
}

/**
 * Validate a full submission payload before insert.
 *
 * On success returns a normalized `value` ready to persist: optional fields
 * collapse to null when absent/empty, and each video is reduced to the exact
 * shape we store.
 *
 * @param {Object} obj
 * @param {string} obj.creator_name   Required; non-empty after trim, <=MAX_NAME_LEN.
 * @param {string} [obj.creator_email] Optional; if present must look like an email.
 * @param {string} [obj.notes]        Optional; <=MAX_NOTES_LEN after trim.
 * @param {Array}  obj.videos         Required; 1..MAX_VIDEOS_PER_SUBMISSION,
 *                                     each { key, filename, size, content_type }.
 * @returns {{ ok: true, value: { creator_name: string, creator_email: string|null,
 *             notes: string|null, videos: Array<{key:string,filename:string,
 *             size:number,content_type:string}> } } | { ok: false, error: string }}
 */
function validateSubmission({ creator_name, creator_email, notes, videos } = {}) {
  // creator_name: required, non-empty after trim, length-capped.
  const name = String(creator_name || '').trim();
  if (!name) {
    return { ok: false, error: 'creator_name is required and must be non-empty' };
  }
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, error: `creator_name must be <= ${MAX_NAME_LEN} characters` };
  }

  // creator_email: optional. If supplied, run a loose sanity check — not
  // RFC-compliant, just enough to reject obvious garbage.
  let email = null;
  if (creator_email) {
    const trimmed = String(creator_email).trim();
    if (trimmed) {
      if (trimmed.length > MAX_EMAIL_LEN) {
        return { ok: false, error: `creator_email must be <= ${MAX_EMAIL_LEN} characters` };
      }
      if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(trimmed)) {
        return { ok: false, error: 'creator_email must be a valid email address' };
      }
      email = trimmed;
    }
  }

  // notes: optional, length-capped; empty/whitespace collapses to null.
  let notesText = null;
  if (notes) {
    const trimmed = String(notes).trim();
    if (trimmed.length > MAX_NOTES_LEN) {
      return { ok: false, error: `notes must be <= ${MAX_NOTES_LEN} characters` };
    }
    if (trimmed) notesText = trimmed;
  }

  // videos: required array, 1..MAX_VIDEOS_PER_SUBMISSION.
  if (!Array.isArray(videos)) {
    return { ok: false, error: 'videos must be an array' };
  }
  if (videos.length === 0) {
    return { ok: false, error: 'At least 1 video is required' };
  }
  if (videos.length > MAX_VIDEOS_PER_SUBMISSION) {
    return { ok: false, error: `Maximum ${MAX_VIDEOS_PER_SUBMISSION} videos per submission` };
  }

  // Each video: must reference a valid server-generated key and carry a
  // filename. Normalize to the stored shape.
  const validatedVideos = [];
  for (const video of videos) {
    if (!video || typeof video !== 'object') {
      return { ok: false, error: 'Each video must be an object' };
    }
    const { key, filename, size, content_type } = video;

    if (!isValidVideoKey(key)) {
      return { ok: false, error: `Invalid video key: ${key}` };
    }
    if (!filename || typeof filename !== 'string') {
      return { ok: false, error: 'Each video must have a filename' };
    }

    validatedVideos.push({
      key: String(key),
      filename: String(filename),
      size: Number(size) || 0,
      content_type: String(content_type || ''),
    });
  }

  return {
    ok: true,
    value: {
      creator_name: name,
      creator_email: email,
      notes: notesText,
      videos: validatedVideos,
    },
  };
}

module.exports = {
  SUBMISSION_KEY_PREFIX,
  MAX_VIDEO_BYTES,
  MAX_VIDEOS_PER_SUBMISSION,
  MAX_NAME_LEN,
  MAX_NOTES_LEN,
  MAX_EMAIL_LEN,
  VALID_STATUSES,
  isSubmissionAdmin,
  isValidVideoKey,
  isValidStatus,
  validateUploadRequest,
  validateSubmission,
};

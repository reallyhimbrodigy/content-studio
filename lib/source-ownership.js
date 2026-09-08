'use strict';
// A JOB MAY ONLY RENDER A SOURCE THIS USER UPLOADED.
//
// THE GAP. /api/render took video_url from the request body and validated it
// with isSafeRemoteMediaUrl only — a thorough SSRF guard (blocks localhost,
// RFC1918, link-local, 169.254.169.254, IPv6 loopback/ULA) that says nothing
// about PROVENANCE. Any public https URL passed. Two consequences:
//   1. an arbitrary internet URL could be submitted as a source — the worker
//      would download and render whatever it pointed at, on our compute;
//   2. ANOTHER USER'S source key would render, because nothing tied the key to
//      the caller. The keys are unguessable, so this needs a leaked or shared
//      URL — but "unguessable" is secrecy, not authorisation.
//
// OWNERSHIP IS IN THE KEY. /api/upload-url mints
// `sources/${authUser.id}/${Date.now()}-${fileName}`, so the owner is derivable
// from the path and no confirm table is needed. That is the whole check: the
// user segment must equal the caller.
//
// Deliberately NOT a host allowlist alone. A host check would still permit one
// user to render another's upload, which is the half that matters.

// Prefixes the app itself mints. A source must live under one of them.
const OWNED_PREFIXES = ['sources/', 'submissions/'];

/**
 * Extract the S3-style key from a CDN or bucket URL. Returns '' when the URL is
 * unparseable — callers treat '' as "not ours", never as "fine".
 */
function keyFromUrl(urlStr) {
  try {
    const u = new URL(String(urlStr));
    return decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  } catch {
    return '';
  }
}

/**
 * Does this URL name a source the given user uploaded?
 *
 * FAIL CLOSED on every ambiguity: unparseable URL, key outside our prefixes,
 * missing user segment, or a segment that is not this user. A source we cannot
 * prove belongs to the caller is one we do not render.
 */
function isOwnedSource(urlStr, userId) {
  const uid = String(userId || '').trim().toLowerCase();
  if (!uid) return false;
  const key = keyFromUrl(urlStr);
  if (!key) return false;
  const prefix = OWNED_PREFIXES.find((p) => key.startsWith(p));
  if (!prefix) return false;
  const rest = key.slice(prefix.length);
  const seg = rest.split('/')[0];
  if (!seg) return false;
  // Exact match only. A prefix comparison would let `<uid>-evil/` pass for
  // `<uid>`, which is the classic path-prefix confusion.
  return seg.toLowerCase() === uid;
}

module.exports = { isOwnedSource, keyFromUrl, OWNED_PREFIXES };

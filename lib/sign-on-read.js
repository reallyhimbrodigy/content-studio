'use strict';

// SIGN ON READ — the stored column is not a promise, it is a pointer.
//
// MEASURED 2026-09-20: 2,062 of 2,643 signed `renderedVideoUrl` values in
// `chats.messages` are already dead (78%), across 1,391 users, with ~90 more
// crossing the line every day. The rot started 2026-08-23, when completions
// began storing a CloudFront signature with a 7-day TTL. The row still holds a
// URL, the bubble still renders a link, and the link 403s. Nothing is deleted:
// an UNSIGNED url from 2026-06-25 still serves 206 from the same distribution
// and the same `renders-private/` prefix. Only the credential aged out.
//
// A STORED SIGNATURE IS THE BUG. Signing at WRITE time bakes an expiry into
// durable data, so the row's lifetime is the signature's lifetime. Signing at
// READ time inverts that: the column holds something permanent (a key, or a
// url we can derive a key from) and the credential is minted for the request
// that asked. That is the whole fix, and it is why this must ship BEFORE the
// columns are migrated to keys — see the sequencing note below.
//
// THREE STORED FORMS, ONE FUNCTION. Reads must tolerate all of them at once,
// because a migration cannot be atomic across 8,800 rows and two tables:
//   - a bare key            "renders-private/<job>/final.mp4"   (post-migration)
//   - an unsigned CDN url   (6,136 durable rows, pre-2026-08-23)
//   - a signed url, live or DEAD  (2,643 rows; the query is stripped and a
//     fresh grant minted, so a dead signature costs nothing)
// `toDeliverableUrl` already handles all three — `sourceKeyFromUrl` returns a
// bare key unchanged (source-presence.js:44), and parses a pathname for the
// rest, which is what makes re-granting idempotent rather than nested.
//
// SEQUENCING, AND IT IS LOAD-BEARING. ~880 of ~1,000 active users are on build
// 246, which reads these fields directly. If the columns become keys before
// every read path signs, every one of those clients renders a bare key as a
// url. Reads first, data second. This file is the "reads first" half.
//
// FAIL-OPEN, DELIBERATELY. toDeliverableUrl returns its input unchanged on any
// signing failure. A signing blip must never un-deliver a video that actually
// rendered — deliver first, enrich second. The cost is that a failure degrades
// to today's behaviour rather than to a blank player.

const { toDeliverableUrl, DEFAULT_TTL_S } = require('./deliverable-url');

/**
 * Mint a fresh grant for one stored value, whatever form it is in.
 * Returns the input unchanged when it is falsy, foreign, or unsignable.
 */
async function signRead(value, label, opts) {
  if (!value || typeof value !== 'string') return value || null;
  return toDeliverableUrl(value, {
    label: label || 'read',
    expiresIn: (opts && opts.expiresIn) || DEFAULT_TTL_S,
    ...(opts && opts.s3 ? { s3: opts.s3 } : {}),
    ...(opts && opts.log ? { log: opts.log } : {}),
  });
}

/**
 * Sign several fields of a row at once, in parallel.
 *
 * Returns a NEW object of just the requested fields — callers spread it over
 * their response rather than mutating the row, so a signed value can never be
 * written back to the database by a later `.update(row)`. Re-storing a grant is
 * how this bug was created in the first place.
 *
 * @param {object} row
 * @param {string[]} fields
 * @param {string} [label]
 * @returns {Promise<object>} { field: grantedValue }
 */
async function signReadFields(row, fields, label, opts) {
  const out = {};
  if (!row || !Array.isArray(fields)) return out;
  await Promise.all(fields.map(async (f) => {
    out[f] = await signRead(row[f], `${label || 'read'}:${f}`, opts);
  }));
  return out;
}

module.exports = { signRead, signReadFields };

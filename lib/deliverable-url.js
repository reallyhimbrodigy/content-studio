'use strict';

// EVERY COMPLETION WRITES A GRANT, NOT A PERMANENT LINK
//
// MEASURED 2026-08-23: 6,200 of 6,210 stored `rendered_video_url` values were
// BARE, permanent CloudFront links — 88.7% of completions in the last 24h,
// 98.5% over 7 days — held by 5,121 users. That is why `renders/` cannot simply
// be restricted (POSTURE_S3_PREFIXES.md §6), and it is why writes-forward to a
// private render prefix is INERT without this: the prefix would go private while
// completions kept writing URLs that 403.
//
// The bare URLs come from the RECONCILER path, which reads the worker's
// `result.video_url` / `result.public_url` — the public URL we handed the worker
// to upload to — and stores that string verbatim. `completion-repair` already
// presigned; the dispatch paths already presigned; the dominant path never did.
// (That the reconciler is dominant is not a guess: it was separately established
// when `_delivered` tested the wrong shape and the reconciler was found to be
// stamping every completion.)
//
// ONE CHOKEPOINT ON PURPOSE. Six write sites each doing their own signing is six
// places to drift; the smoke asserts they all route through here.

const { sourceKeyFromUrl } = require('./source-presence');

// 7 days is the SigV4 maximum and matches the upload/dispatch grants. Shorter
// re-introduces expiry inside a normal viewing window; the client re-resolves
// via /api/video-jobs/:id/refresh-urls when it does lapse.
const DEFAULT_TTL_S = 60 * 60 * 24 * 7;

/**
 * Is this string an object WE can sign for?
 *
 * Accepts a bare key ("renders/job/x.mp4"), an s3:// url for our bucket, or an
 * http(s) url on our bucket host or CloudFront domain. Everything else — a
 * legacy Supabase Storage url, any third-party host — is someone else's object
 * and must be returned untouched. Minting a grant for a foreign object does not
 * merely fail; it produces a confident, well-formed url pointing at a key that
 * does not exist in our bucket.
 */
function isOurs(s, s3) {
  const v = String(s).trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) return true;           // bare key
  if (/^s3:/i.test(v)) {
    const b = v.replace(/^s3:\/\//i, '').split('/')[0];
    return !!s3.S3_BUCKET && b === s3.S3_BUCKET;
  }
  if (!/^https?:/i.test(v)) return false;
  let host;
  try { host = new URL(v).hostname; } catch { return false; }
  const cdn = (process.env.CLOUDFRONT_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return (!!s3.S3_BUCKET && host.includes(s3.S3_BUCKET)) || (!!cdn && host.endsWith(cdn));
}

/**
 * Convert whatever a completion produced into a time-limited grant.
 *
 * PASSES THROUGH UNCHANGED when it cannot safely sign:
 *   - falsy input                      (nothing to deliver)
 *   - a URL that is not ours           (legacy Supabase Storage, foreign host)
 *   - S3 not configured                (dev/test)
 *   - any signing failure              (fail-open, logged LOUDLY)
 *
 * FAIL-OPEN IS DELIBERATE AND IT IS THE RISKY HALF. While `renders/` is public a
 * pass-through still plays, so a signing blip must never un-deliver a video that
 * actually rendered — that ordering (deliver first, enrich second) is a standing
 * structural rule here. Once the render prefix goes private the SAME line
 * becomes the failure that matters, which is why it logs the key on
 * console.error rather than swallowing.
 *
 * IDEMPOTENT. sourceKeyFromUrl parses with `new URL().pathname`, which strips the
 * query, so re-granting an already-signed URL yields the same key and a FRESH
 * grant rather than nested credentials.
 *
 * @param {string|null|undefined} urlOrKey
 * @param {{s3?: object, expiresIn?: number, label?: string, log?: object}} [opts]
 * @returns {Promise<string|null|undefined>} the grant, or the input unchanged
 */
async function toDeliverableUrl(urlOrKey, opts = {}) {
  if (!urlOrKey || typeof urlOrKey !== 'string') return urlOrKey;
  const log = opts.log || console;
  const label = opts.label || 'completion';
  let s3 = opts.s3;
  if (!s3) { try { s3 = require('../services/s3'); } catch (_) { return urlOrKey; } }
  if (!s3 || typeof s3.isConfigured !== 'function' || !s3.isConfigured()) return urlOrKey;

  // HOST FIRST, KEY SECOND — and this order is load-bearing.
  //
  // sourceKeyFromUrl returns a PATHNAME for ANY http url; it does not look at
  // the host. Deriving the key first and trusting it meant a legacy Supabase
  // Storage url came back as `storage/v1/object/public/v/x.mp4` and got a grant
  // minted for OUR bucket — rewriting a foreign object onto our CDN, where it
  // does not exist. The smoke caught it; my comment had claimed the guard
  // existed while the code never checked. An intention is not a behaviour.
  //
  // Same host test as /api/video-jobs/:id/refresh-urls, deliberately: two places
  // deciding "is this ours?" differently is how they drift.
  if (!isOurs(urlOrKey, s3)) return urlOrKey;

  const key = sourceKeyFromUrl(urlOrKey);
  if (!key) return urlOrKey;

  try {
    const granted = await s3.createPresignedGetUrl(key, opts.expiresIn || DEFAULT_TTL_S);
    return granted || urlOrKey;
  } catch (e) {
    log.error(`[deliverable-url] ${label} grant FAILED key=${key}: ${e && e.message}`
      + ' — storing the unsigned url (works only while the prefix is public)');
    return urlOrKey;
  }
}

module.exports = { toDeliverableUrl, DEFAULT_TTL_S };

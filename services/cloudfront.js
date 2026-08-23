// CloudFront URL helper. Two modes:
//   - SIGNED  — when CLOUDFRONT_KEY_PAIR_ID + CLOUDFRONT_PRIVATE_KEY
//               are set, returns time-limited signed URLs via Trusted
//               Key Groups. Best for private content.
//   - UNSIGNED — when only CLOUDFRONT_DOMAIN is set, returns plain
//                CloudFront URLs (no expiry). Works with public
//                distributions / OAC-backed buckets where the
//                distribution itself is the access boundary.
//
// Either mode, the URL host is the CloudFront domain so iOS detects
// it as CDN-backed and switches to streaming-first playback.

const cloudFrontDomain = (process.env.CLOUDFRONT_DOMAIN || '').trim();
const keyPairId = (process.env.CLOUDFRONT_KEY_PAIR_ID || '').trim();
// Render's web env var editor will sometimes turn a multi-line PEM into
// `\n`-escaped sequences. Normalize either form to real newlines.
const privateKey = (process.env.CLOUDFRONT_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();

const signedMode = Boolean(cloudFrontDomain && keyPairId && privateKey);
const unsignedMode = Boolean(cloudFrontDomain && !signedMode);
const enabled = signedMode || unsignedMode;

let signer = null;
if (signedMode) {
  try {
    signer = require('@aws-sdk/cloudfront-signer');
    console.log(`[cloudfront] signed URLs enabled for ${cloudFrontDomain}`);
  } catch (err) {
    console.warn(`[cloudfront] @aws-sdk/cloudfront-signer not loadable: ${err.message}`);
  }
} else if (unsignedMode) {
  console.log(`[cloudfront] unsigned URLs enabled for ${cloudFrontDomain}`);
}

/**
 * Build a CloudFront URL for the given S3 key. Returns null when the
 * CDN is not configured at all — caller falls back to S3 signed URL.
 *
 * `expiresInSeconds` is honored by the signed mode only; unsigned URLs
 * have no expiry. (CloudFront's distribution-level access controls and
 * the unguessable S3 key path are the access boundary in unsigned mode.)
 */
function createSignedUrl(key, expiresInSeconds) {
  if (!enabled) return null;
  const path = `https://${cloudFrontDomain}/${encodeURIPath(key)}`;
  if (signedMode && signer) {
    try {
      const dateLessThan = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
      return signer.getSignedUrl({
        url: path,
        keyPairId,
        privateKey,
        dateLessThan,
      });
    } catch (err) {
      console.warn(`[cloudfront] sign failed for key=${key}: ${err.message}`);
      return null;
    }
  }
  return path;
}

// Encode path segments individually so slashes are preserved but
// spaces / unicode in filenames become %-encoded.
function encodeURIPath(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

module.exports = {
  enabled,
  // EXPORTED 2026-08-23. Callers must be able to tell a GRANT from a bare
  // permanent link. Without this, s3.createPresignedGetUrl read
  // `cloudfront.signedMode` as undefined and took the unsigned branch silently
  // — the exact undetectable-degrade shape the guard exists to close.
  signedMode,
  unsignedMode,
  cloudFrontDomain,
  createSignedUrl,
};

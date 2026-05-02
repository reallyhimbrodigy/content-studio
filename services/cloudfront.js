// CloudFront signed URL helper. When the CDN is configured via env
// vars, this module signs and returns CloudFront URLs that point at
// the S3 origin via the edge cache. When env vars are missing, it
// returns null and the caller falls back to S3 origin signed URLs.
//
// Required environment variables (all four for CloudFront to activate):
//   CLOUDFRONT_DOMAIN          — the dXXXXXXXX.cloudfront.net hostname
//   CLOUDFRONT_KEY_PAIR_ID     — the public-key id from the trusted key
//                                group attached to the distribution
//   CLOUDFRONT_PRIVATE_KEY     — full PEM contents of the matching
//                                private key (-----BEGIN PRIVATE KEY-----
//                                ... -----END PRIVATE KEY-----), pasted
//                                with literal newlines OR with `\n`
//                                escape sequences — both are normalized.
//
// Once these are set, every signed-GET URL the app produces routes
// through CloudFront. iOS detects the CloudFront host and switches
// to streaming-first playback (no full-file download wait).

const cloudFrontDomain = (process.env.CLOUDFRONT_DOMAIN || '').trim();
const keyPairId = (process.env.CLOUDFRONT_KEY_PAIR_ID || '').trim();
// Render's web env var editor will sometimes turn a multi-line PEM into
// `\n`-escaped sequences. Normalize either form to real newlines.
const privateKey = (process.env.CLOUDFRONT_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();

const enabled = Boolean(cloudFrontDomain && keyPairId && privateKey);

let signer = null;
if (enabled) {
  try {
    // Lazy require so the package isn't loaded when the CDN is not in use.
    signer = require('@aws-sdk/cloudfront-signer');
    console.log(`[cloudfront] signer enabled for ${cloudFrontDomain}`);
  } catch (err) {
    console.warn(`[cloudfront] @aws-sdk/cloudfront-signer not loadable: ${err.message}`);
  }
}

/**
 * Sign a CloudFront URL for the given S3 key. Returns null if the CDN
 * is not configured or signing fails — caller should fall back.
 *
 * `expiresInSeconds` is the lifetime of the URL. CloudFront accepts up
 * to ~1 year, but matching the existing S3 SigV4 7-day cap keeps the
 * fallback path predictable.
 */
function createSignedUrl(key, expiresInSeconds) {
  if (!enabled || !signer) return null;
  try {
    const url = `https://${cloudFrontDomain}/${encodeURIPath(key)}`;
    const dateLessThan = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    return signer.getSignedUrl({
      url,
      keyPairId,
      privateKey,
      dateLessThan,
    });
  } catch (err) {
    console.warn(`[cloudfront] sign failed for key=${key}: ${err.message}`);
    return null;
  }
}

// Encode path segments individually so slashes are preserved but
// spaces / unicode in filenames become %-encoded.
function encodeURIPath(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

module.exports = {
  enabled,
  cloudFrontDomain,
  createSignedUrl,
};

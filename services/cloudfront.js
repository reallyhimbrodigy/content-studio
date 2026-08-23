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

// SHAPE, NOT PRESENCE (2026-08-23, live P0). CLOUDFRONT_KEY_PAIR_ID was set to
// the PUBLIC KEY PEM instead of the key pair id. Every presence check passed —
// signedMode true, the signer loaded, canSign true, a Signature was produced —
// and CloudFront answered every single export with:
//
//     <Error><Code>MissingKey</Code>
//     <Message>Missing Key-Pair-Id query parameter or cookie value</Message>
//
// because the parameter it received was a 450-char PEM, not an id. The failure
// is invisible to every check that asks "is it set?", which is why this one asks
// what it IS. A CloudFront key pair id is a short opaque alphanumeric token
// (e.g. K2JCJMDEHXQW5F); a PEM carries newlines, spaces and dashes, so the
// character class alone separates them decisively.
const KEY_PAIR_ID_RE = /^[A-Za-z0-9]{8,40}$/;
const keyPairIdWellFormed = KEY_PAIR_ID_RE.test(keyPairId);

// A malformed id must DEMOTE us out of signed mode rather than mint URLs that
// are guaranteed to 403. s3.js then declines to hand out a bare CDN url and
// falls through to an S3 presigned GET — time-limited and unguessable, the same
// security property — so exports keep DELIVERING while the config is corrected.
// Failing loudly to us must never mean failing to the user.
const signedMode = Boolean(cloudFrontDomain && keyPairId && privateKey && keyPairIdWellFormed);
const keyPairIdMalformed = Boolean(cloudFrontDomain && privateKey && keyPairId && !keyPairIdWellFormed);
const unsignedMode = Boolean(cloudFrontDomain && !signedMode);
const enabled = signedMode || unsignedMode;

if (keyPairIdMalformed) {
  console.error(
    `[cloudfront] CLOUDFRONT_KEY_PAIR_ID IS NOT A KEY PAIR ID (len=${keyPairId.length}, ` +
    `starts ${JSON.stringify(keyPairId.slice(0, 24))}). Expected a short alphanumeric id ` +
    `like K2JCJMDEHXQW5F. Signed CDN URLs are DISABLED and exports fall back to S3 ` +
    `presigned GETs. Fix the env var value in Render — the private key itself looks fine.`
  );
}

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
  // Distinguishes "no key configured" from "a key is configured and it is the
  // WRONG KIND OF STRING". Both land in unsignedMode; only one is a live
  // misconfiguration that 403s every export, and health must say which.
  keyPairIdMalformed,
  cloudFrontDomain,
  createSignedUrl,
};

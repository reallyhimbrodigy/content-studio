const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadBucketCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const cloudfront = require('./cloudfront');

const AWS_REGION = process.env.AWS_REGION || 'us-west-1';
const S3_BUCKET = process.env.S3_BUCKET_NAME || '';
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN || '';
// Transfer Acceleration routes uploads through the nearest CloudFront edge
// POP and then AWS backbone to the target bucket. Lossless: same bytes,
// shorter path. Enabled on the bucket via put-bucket-accelerate-configuration.
// Flag here toggles whether presigned URLs use the accelerate endpoint.
const S3_USE_ACCELERATE = String(process.env.S3_USE_ACCELERATE || 'true').toLowerCase() === 'true';

let s3Client = null;
// Separate client instance for presigning URLs that target the accelerate
// endpoint. The host format is {bucket}.s3-accelerate.amazonaws.com.
let s3SigningClient = null;

if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && S3_BUCKET) {
  // Opt out of @aws-sdk/client-s3 v3.730+'s default "include CRC32 checksum
  // placeholder in every presigned URL" behavior. When that default is on,
  // every presigned PUT URL contains an `x-amz-checksum-crc32=AAAAAA==`
  // query parameter (the CRC32 of empty bytes — a placeholder). The SDK
  // assumes the uploading client will overwrite this with the real CRC32
  // of the body before sending. Simple HTTP clients (curl, wget, iOS
  // URLSession.background) don't do that. S3 then computes the actual
  // body CRC32, sees it doesn't match the placeholder, and rejects with
  // HTTP 400. Symptom: iOS shows "uploading…" and then "Upload failed"
  // with no apparent server-side error trail because S3 logged a request-
  // level rejection, not a route handler error.
  // WHEN_REQUIRED restores pre-v3.730 behavior: checksum only when the
  // caller explicitly opts in. This is what every existing PUT URL we
  // hand the iOS client needs.
  const checksumOptOut = {
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  };
  s3Client = new S3Client({
    region: AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    ...checksumOptOut,
  });

  s3SigningClient = S3_USE_ACCELERATE
    ? new S3Client({
        region: AWS_REGION,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
        useAccelerateEndpoint: true,
        ...checksumOptOut,
      })
    : s3Client;

  console.log(`[s3] Configured: bucket=${S3_BUCKET} region=${AWS_REGION} accelerate=${S3_USE_ACCELERATE}`);

  // Verify the configured region actually matches the bucket's region.
  // A mismatch doesn't break uploads (S3 307-redirects to the correct region)
  // but it adds a round-trip per presigned URL use and silently cancels
  // transfer-acceleration gains, since clients end up talking to the wrong
  // edge. This is the sort of thing that causes "upload is mysteriously slow"
  // for months — fail loud at boot instead.
  (async () => {
    try {
      const resp = await s3Client.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
      const actualRegion = resp.BucketRegion || resp.$metadata?.headers?.['x-amz-bucket-region'];
      if (actualRegion && actualRegion !== AWS_REGION) {
        console.error(
          `[s3] ⚠️  REGION MISMATCH: AWS_REGION=${AWS_REGION} but bucket ${S3_BUCKET} is in ${actualRegion}. ` +
          `Uploads will be 307-redirected and Transfer Acceleration benefits will be lost. ` +
          `Set AWS_REGION=${actualRegion} in the environment to fix.`
        );
      } else {
        console.log(`[s3] Region verified: bucket is in ${actualRegion || AWS_REGION}`);
      }
    } catch (e) {
      console.warn(`[s3] Region verification failed (non-fatal): ${e.message}`);
    }
  })();
} else {
  console.warn('[s3] AWS credentials or S3_BUCKET_NAME not set — S3 storage disabled');
}

function isConfigured() {
  return Boolean(s3Client && S3_BUCKET);
}

/**
 * Does this object actually exist in the source bucket?
 *
 * One HEAD, ~50ms, no container. This is the check that decides whether a job
 * is worth dispatching at all: today a source that never arrives still spawns a
 * Modal worker that polls for 600s before failing (94 such jobs in the 7 days to
 * 2026-08-02 — 60% of ALL failures — at ~$0.62 of held cpu=16/64GiB container
 * each).
 *
 * Returns true/false for a definite answer, and `null` when we could not tell
 * (S3 unconfigured, creds/network error). Null must never be treated as absent
 * — an unmeasurable check has to fail OPEN and let the job run, or an S3 blip
 * would reject every upload in the product.
 */
async function objectExists(key) {
  if (!s3Client || !S3_BUCKET || !key) return null;
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch (err) {
    const code = err?.$metadata?.httpStatusCode;
    const name = err?.name || err?.Code;
    if (code === 404 || name === 'NotFound' || name === 'NoSuchKey') return false;
    // 403 on a bucket without ListBucket is ALSO "not there" for our purposes
    // only if the bucket denies HEAD on missing keys; we cannot distinguish it
    // from a permissions problem, so report unknown and let the job proceed.
    return null;
  }
}

/**
 * Read an object into memory, with a HARD byte ceiling.
 *
 * Added for chat media (§1): Gemini takes images as inline base64, so the bytes
 * have to come back through us. `maxBytes` is checked against ContentLength
 * BEFORE the body is drained — a presigned PUT cannot be trusted to have
 * honoured whatever the client declared at mint time, and streaming an
 * unbounded object into a Buffer is how one oversized upload takes the process
 * down. Throws `too_large` (413) rather than truncating: a silently clipped
 * image would reach the model as corrupt data and produce a confidently wrong
 * answer about a picture nobody sent.
 *
 * @param {string} key
 * @param {number} maxBytes
 * @returns {Promise<{buffer: Buffer, contentType: string, size: number}>}
 */
async function getObjectBuffer(key, maxBytes) {
  if (!s3Client) throw new Error('S3 client not configured');
  const out = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  const declared = Number(out.ContentLength || 0);
  if (maxBytes && declared > maxBytes) {
    const e = new Error('too_large');
    e.statusCode = 413;
    e.detail = { size: declared, limit: maxBytes };
    throw e;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of out.Body) {
    total += chunk.length;
    // Belt and braces: ContentLength is server-reported, so enforce on the
    // actual stream too and abort the moment it is exceeded.
    if (maxBytes && total > maxBytes) {
      const e = new Error('too_large');
      e.statusCode = 413;
      e.detail = { size: total, limit: maxBytes };
      throw e;
    }
    chunks.push(chunk);
  }
  return {
    buffer: Buffer.concat(chunks),
    contentType: out.ContentType || 'application/octet-stream',
    size: total,
  };
}

/**
 * Upload a Buffer to S3.
 * @param {string} key - Object key (e.g. "sources/userId/timestamp-file.mp4")
 * @param {Buffer} buffer
 * @param {string} contentType
 * @returns {Promise<string>} Public or CloudFront URL for the uploaded object
 */
async function upload(key, buffer, contentType) {
  if (!s3Client) throw new Error('S3 client not configured');
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  return getPublicUrl(key);
}

/**
 * Generate a presigned PUT URL for the worker to upload directly. Uses the
 * accelerate endpoint when enabled — 1.5-2× upload throughput for clients
 * far from the bucket region, routed through CloudFront edge POPs. Bytes
 * are byte-identical; only the transit path is different.
 * @param {string} key
 * @param {number} expiresIn - Seconds (default 1 hour)
 * @returns {Promise<string>}
 */
async function createPresignedPutUrl(key, expiresIn = 3600) {
  if (!s3SigningClient) throw new Error('S3 client not configured');
  return getSignedUrl(s3SigningClient, new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
  }), { expiresIn });
}

/**
 * Initialize a multipart upload and return presigned URLs for each part.
 * The client uploads parts in parallel against these URLs (each hitting the
 * accelerate endpoint when enabled), then calls completeMultipartUpload to
 * finalize. Massively faster than a single-stream PUT on larger files by
 * saturating multiple TCP connections.
 * @param {string} key - S3 object key
 * @param {number} partCount - Number of parts client will upload
 * @param {number} expiresIn - Seconds (default 1 hour)
 * @returns {Promise<{uploadId: string, partUrls: string[]}>}
 */
async function initMultipartUpload(key, partCount, expiresIn = 3600) {
  if (!s3Client || !s3SigningClient) throw new Error('S3 client not configured');

  const initResp = await s3Client.send(new CreateMultipartUploadCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ContentType: 'video/mp4',
  }));
  const uploadId = initResp.UploadId;
  if (!uploadId) throw new Error('S3 CreateMultipartUpload returned no UploadId');

  // Presign each UploadPart URL. Must be done in-order since part numbers
  // are embedded in the signed URL. UploadPart commands are idempotent —
  // the client can retry a specific part without corrupting the overall upload.
  const partUrls = [];
  for (let partNumber = 1; partNumber <= partCount; partNumber++) {
    const url = await getSignedUrl(
      s3SigningClient,
      new UploadPartCommand({
        Bucket: S3_BUCKET,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn }
    );
    partUrls.push(url);
  }
  return { uploadId, partUrls };
}

/**
 * Complete a multipart upload with the ETags returned from each part PUT.
 * @param {string} key
 * @param {string} uploadId
 * @param {Array<{PartNumber: number, ETag: string}>} parts - Sorted ascending
 */
async function completeMultipartUpload(key, uploadId, parts) {
  if (!s3Client) throw new Error('S3 client not configured');
  // S3 requires parts sorted by PartNumber ascending.
  const sortedParts = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);
  await s3Client.send(new CompleteMultipartUploadCommand({
    Bucket: S3_BUCKET,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: sortedParts },
  }));
}

/**
 * Abort a multipart upload to free the in-progress parts. Safe no-op if
 * already completed or never initialized. Called when client retries fail
 * or gives up — prevents orphaned parts from billing forever.
 */
async function abortMultipartUpload(key, uploadId) {
  if (!s3Client) return;
  try {
    await s3Client.send(new AbortMultipartUploadCommand({
      Bucket: S3_BUCKET,
      Key: key,
      UploadId: uploadId,
    }));
  } catch (e) {
    console.warn(`[s3] abort multipart failed for ${key}: ${e.message}`);
  }
}

/**
 * Generate a presigned GET URL for reading a private object.
 *
 * Uses the accelerate-enabled s3SigningClient (when accelerate is on)
 * so the URL targets `BUCKET.s3-accelerate.amazonaws.com` rather than
 * `BUCKET.s3.{region}.amazonaws.com`. The accelerate hostname is
 * region-agnostic — works regardless of whether AWS_REGION env var
 * matches the bucket's actual region. This eliminates a category of
 * silent breakage where Modal's accelerate-PUT works (signed for any
 * region) but iOS's standard-endpoint GET fails (wrong region in the
 * signature → S3 redirects → AVPlayer chokes on redirect mid-stream).
 *
 * AWS SigV4 caps presigned-URL expiration at 7 days (604800s).
 * @param {string} key
 * @param {number} expiresIn - Seconds (default 7 days, AWS hard cap)
 * @returns {Promise<string>}
 */
const SIGV4_MAX_EXPIRES = 60 * 60 * 24 * 7;
async function createPresignedGetUrl(key, expiresIn = SIGV4_MAX_EXPIRES) {
  const safeExpires = Math.min(Math.max(1, expiresIn), SIGV4_MAX_EXPIRES);

  // Prefer CloudFront when the CDN is configured. The signed URL points
  // at the edge cache, so iOS reads bytes from a POP near the user
  // (sub-100ms first byte, sustained 50+ Mbps from the edge) instead
  // of the origin S3 endpoint (~500ms first byte, bursty throughput).
  // iOS detects the CloudFront host on the URL and switches to
  // streaming-first playback for those URLs — no full-file download
  // gate before the play button unlocks.
  // UNSIGNED_MODE_REFUSES (2026-08-23). cloudfront.createSignedUrl returns a
  // BARE, NON-EXPIRING https://<domain>/<key> when only CLOUDFRONT_DOMAIN is set
  // — byte-identical to getPublicUrl. Returning it here silently converted every
  // "short-TTL signed grant" into a permanent public link, and no caller could
  // tell: same shape, same type, no error. MEASURED live on 2026-08-23:
  // exports/<job>/clean.mp4 → HTTP 200, video/mp4, 34,240,387 bytes, real ftyp
  // magic, on two independent keys (S3 direct 403, so the DISTRIBUTION serves
  // it). The export paywall was theatre.
  //
  // Falling through to the S3 SigV4 presign is the SAFE degrade: a genuinely
  // time-limited URL, slower to first byte than the edge but actually private.
  // It is a real behaviour change for callers who assumed CloudFront — accepted
  // deliberately, because "fast and public" is not a valid answer to a request
  // for a private URL.
  if (cloudfront.signedMode) {
    const cfUrl = cloudfront.createSignedUrl(key, safeExpires);
    if (cfUrl) return cfUrl;
  } else if (cloudfront.enabled) {
    console.warn(`[s3] CloudFront is UNSIGNED (no CLOUDFRONT_KEY_PAIR_ID/`
      + `CLOUDFRONT_PRIVATE_KEY) — refusing to mint a bare CDN URL for `
      + `${String(key).slice(0, 80)} and falling back to an S3 presign. `
      + `A bare CDN URL would be permanent and public.`);
  }

  // Fallback: signed S3 URL via the accelerate endpoint. Same behavior
  // as before. iOS keeps its download-first playback path for these.
  const client = s3SigningClient || s3Client;
  if (!client) throw new Error('S3 client not configured');
  return getSignedUrl(client, new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
  }), { expiresIn: safeExpires });
}

/**
 * Get the public URL for an object. Uses CloudFront if configured,
 * otherwise falls back to the S3 public URL.
 * @param {string} key
 * @returns {string}
 */
function getPublicUrl(key) {
  if (CLOUDFRONT_DOMAIN) {
    const domain = CLOUDFRONT_DOMAIN.replace(/\/$/, '');
    return `https://${domain}/${key}`;
  }
  return `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
}

module.exports = {
  s3Client,
  isConfigured,
  objectExists,
  getObjectBuffer,
  upload,
  createPresignedPutUrl,
  createPresignedGetUrl,
  getPublicUrl,
  initMultipartUpload,
  completeMultipartUpload,
  abortMultipartUpload,
  S3_BUCKET,
  AWS_REGION,
};

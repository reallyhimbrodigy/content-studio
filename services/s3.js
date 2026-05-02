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
  s3Client = new S3Client({
    region: AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });

  s3SigningClient = S3_USE_ACCELERATE
    ? new S3Client({
        region: AWS_REGION,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
        useAccelerateEndpoint: true,
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
  const cfUrl = cloudfront.createSignedUrl(key, safeExpires);
  if (cfUrl) return cfUrl;

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

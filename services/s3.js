const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const AWS_REGION = process.env.AWS_REGION || 'us-west-1';
const S3_BUCKET = process.env.S3_BUCKET_NAME || '';
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN || '';

let s3Client = null;

if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && S3_BUCKET) {
  s3Client = new S3Client({
    region: AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  console.log(`[s3] Configured: bucket=${S3_BUCKET} region=${AWS_REGION}`);
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
 * Generate a presigned PUT URL for the worker to upload directly.
 * @param {string} key
 * @param {number} expiresIn - Seconds (default 1 hour)
 * @returns {Promise<string>}
 */
async function createPresignedPutUrl(key, expiresIn = 3600) {
  if (!s3Client) throw new Error('S3 client not configured');
  return getSignedUrl(s3Client, new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
  }), { expiresIn });
}

/**
 * Generate a presigned GET URL for reading a private object.
 * @param {string} key
 * @param {number} expiresIn - Seconds (default 1 year)
 * @returns {Promise<string>}
 */
async function createPresignedGetUrl(key, expiresIn = 60 * 60 * 24 * 365) {
  if (!s3Client) throw new Error('S3 client not configured');
  return getSignedUrl(s3Client, new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
  }), { expiresIn });
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
  S3_BUCKET,
  AWS_REGION,
};

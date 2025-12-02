const crypto = require('crypto');

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_DESIGN_FOLDER || 'promptly/design-assets';
// NOTE: Cloudinary secrets must never be exposed client-side.

function ensureCloudinaryConfigured() {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw Object.assign(new Error('Cloudinary is not configured'), { statusCode: 501 });
  }
}

function buildSignature(params) {
  const sortedKeys = Object.keys(params).sort();
  const toSign = sortedKeys.map((key) => `${key}=${params[key]}`).join('&');
  return crypto.createHash('sha1').update(`${toSign}${CLOUDINARY_API_SECRET}`).digest('hex');
}

async function uploadAssetFromUrl({ url, folder = CLOUDINARY_FOLDER }) {
  ensureCloudinaryConfigured();
  if (!url) throw new Error('Source URL required');
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    file: url,
    folder,
    timestamp,
  };
  const signature = buildSignature(params);
  const form = new URLSearchParams({
    ...params,
    api_key: CLOUDINARY_API_KEY,
    signature,
  });
  const endpoint = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    if (!response.ok) {
      const detail = await safeJson(response);
      console.error('Cloudinary upload failed', {
        folder,
        status: response.status,
        detail,
      });
      const error = new Error(detail?.error?.message || `Cloudinary upload failed (${response.status})`);
      error.statusCode = response.status;
      error.details = detail;
      throw error;
    }
    const json = await response.json();
    return {
      publicId: json.public_id,
      secureUrl: json.secure_url || '',
      width: json.width,
      height: json.height,
      bytes: json.bytes,
    };
  } catch (error) {
    console.error('Cloudinary upload error', {
      folder,
      message: error?.message,
      sourceUrl: url,
    });
    throw error;
  }
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function buildCloudinaryUrl(publicId, { width = 1200, height = 1200, crop = 'fill', quality = 'auto', format = 'auto' } = {}) {
  if (!CLOUDINARY_CLOUD_NAME || !publicId) return '';
  const transformation = [`c_${crop}`, `w_${width}`, `h_${height}`, `q_${quality}`, `f_${format}`]
    .filter(Boolean)
    .join(',');
  const safePublicId = publicId
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/${transformation}/${safePublicId}`;
}

function isCloudinaryConfigured() {
  return Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);
}

module.exports = {
  uploadAssetFromUrl,
  buildCloudinaryUrl,
  isCloudinaryConfigured,
};

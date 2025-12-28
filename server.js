const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const promptPresets = require('./assets/prompt-presets.json');
const JSZip = require('jszip');
const {
  supabaseAdmin,
  getDesignAssetById,
  updateDesignAsset,
  createDesignAsset,
  upsertPhylloAccount,
  upsertPhylloPost,
  insertPhylloPostMetrics,
  updateCachedAnalyticsForUser,
} = require('./services/supabase-admin');
const cron = require('node-cron');
let uploadAssetFromUrl = async () => null;
let buildCloudinaryUrl = () => '';
let generateBrandedBackgroundImage = async () => null;
try {
  ({ uploadAssetFromUrl, buildCloudinaryUrl, generateBrandedBackgroundImage } = require('./services/cloudinary'));
} catch (err) {
  console.log('[Assets] Cloudinary service unavailable; asset helpers disabled.');
}
const { getBrandBrainForUser } = require('./services/brand-brain');
const {
  getPhylloPosts,
  getPhylloPostMetrics,
  getUserPostMetrics,
  getAudienceDemographics,
  buildWeeklyReport,
  syncAudience,
  syncFollowerMetrics,
  syncDemographics,
} = require('./services/phyllo-metrics');
const {
  createPhylloUser,
  createSdkToken,
  fetchAccountContents,
  fetchAccountEngagement,
  getPhylloUserByExternalId,
  getPhylloAccountDetails,
  parsePhylloProducts,
} = require('./services/phyllo');
const { getFeatureUsageCount, incrementFeatureUsage } = require('./services/featureUsage');
const {
  getMonthlyTrendingAudios,
  formatAudioLine,
} = require('./server/lib/trendingAudio');
const { ENABLE_DESIGN_LAB } = require('./config/flags');
// Design Lab has been removed; provide stubs so legacy code paths do not break.
const createPlacidRender = async () => ({ id: null, status: 'disabled' });
const resolvePlacidTemplateId = () => null;
const validatePlacidTemplateConfig = async () => {};
const isPlacidConfigured = () => false;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CANONICAL_HOST = process.env.CANONICAL_HOST || '';
const STABILITY_API_KEY = process.env.STABILITY_API_KEY || '';
const STORY_TEMPLATE_ID = process.env.PLACID_STORY_TEMPLATE_ID || '';
const CAROUSEL_TEMPLATE_ID = process.env.PLACID_CAROUSEL_TEMPLATE_ID || '';
const ALLOWED_DESIGN_ASSET_TYPES = ['story', 'carousel'];
// NOTE: Placid and Cloudinary secrets must never be exposed client-side.
const PHYLLO_ENVIRONMENT = process.env.PHYLLO_ENVIRONMENT || 'production';
const PHYLLO_WEBHOOK_SIGNING_SECRET = process.env.PHYLLO_WEBHOOK_SIGNING_SECRET || '';

if (!OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set.');
}
if (!STABILITY_API_KEY) {
  console.warn('Warning: STABILITY_API_KEY is not set. /api/design/generate will return 501.');
}

// Simple local data directory for brand brains
const DATA_DIR = path.join(__dirname, 'data');
const BRANDS_DIR = path.join(DATA_DIR, 'brands');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const DESIGN_ASSETS_DIR = path.join(DATA_DIR, 'design-assets');
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(BRANDS_DIR)) fs.mkdirSync(BRANDS_DIR);
  if (!fs.existsSync(CUSTOMERS_FILE)) fs.writeFileSync(CUSTOMERS_FILE, '{}', 'utf8');
  if (!fs.existsSync(DESIGN_ASSETS_DIR)) fs.mkdirSync(DESIGN_ASSETS_DIR);
} catch (e) {
  console.error('Failed to initialize data directories:', e);
}

function slugify(s = '') {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

async function generateAlertsForUser(userId, metrics) {
  if (!supabaseAdmin || !userId) return;
  const alerts = [];

  if (metrics?.summary?.retentionDropPct >= 20) {
    alerts.push({
      user_id: userId,
      message: `Retention dropped ${metrics.summary.retentionDropPct}% vs last month.`,
      severity: 'warning',
    });
  }

  if (metrics?.summary?.audienceShiftPct >= 10) {
    alerts.push({
      user_id: userId,
      message: `Audience shift detected: +${metrics.summary.audienceShiftPct}% viewers from new regions.`,
      severity: 'info',
    });
  }

  if (alerts.length > 0) {
    try {
      await supabaseAdmin.from('analytics_alerts').insert(alerts);
    } catch (err) {
      console.error('[Analytics alerts] insert failed', err);
    }
  }
}

function chunkText(input, maxLen = 800) {
  if (!input) return [];
  const normalized = String(input).replaceAll('\r\n', '\n');
  const parts = [];
  let collector = [];
  const flush = () => {
    if (collector.length === 0) return;
    const paragraph = collector.join('\n').trim();
    if (paragraph) parts.push(paragraph);
    collector = [];
  };
  for (const line of normalized.split('\n')) {
    if (line.trim() === '') {
      flush();
    } else {
      collector.push(line);
    }
  }
  flush();
  const chunks = [];
  for (const p of parts) {
    if (p.length <= maxLen) {
      chunks.push(p);
    } else {
      // naive hard split
      for (let i = 0; i < p.length; i += maxLen) {
        chunks.push(p.slice(i, i + maxLen));
      }
    }
    if (chunks.length >= 50) break; // cap
  }
  return chunks;
}

const CAROUSEL_SLIDE_BLUEPRINTS = [
  { key: 'hook', title: 'Slide 1 · Hook', role: 'Hook', instructions: 'Deliver a bold hook or question that stops the scroll.', order: 1 },
  { key: 'value_one', title: 'Slide 2 · Value', role: 'Value 1', instructions: 'Share the strongest proof point, stat, or insight tied to the concept.', order: 2 },
  { key: 'value_two', title: 'Slide 3 · Value', role: 'Value 2', instructions: 'Add a complementary tip or detail that reinforces the hook.', order: 3 },
  { key: 'engagement', title: 'Slide 4 · Engagement', role: 'Engagement', instructions: 'Prompt the viewer to comment, save, or DM. Reference the concept directly.', order: 4 },
  { key: 'cta', title: 'Slide 5 · CTA', role: 'CTA', instructions: 'End with a clear CTA button or sticker that drives action.', order: 5 },
];

const CAROUSEL_OUTPUT_FORMATS = [
  { key: 'instagram', label: 'Instagram', platform: 'Instagram', aspectRatio: '1:1', width: 1080, height: 1080 },
  { key: 'tiktok', label: 'TikTok', platform: 'TikTok', aspectRatio: '9:16', width: 1080, height: 1920 },
];

// Template ID resolution is handled by services/placid.js resolvePlacidTemplateId()

function getDesignAssetTypeLabel(type) {
  switch (String(type || '').toLowerCase()) {
    case 'story':
      return 'Story';
    case 'carousel':
      return 'Carousel';
    default:
      return 'Asset';
  }
}

function stabilityMultipartRequest({ path: apiPath, method = 'POST', fields = [] }) {
  return new Promise((resolve, reject) => {
    const boundary = '----promptly' + Math.random().toString(16).slice(2);
    const body = fields
      .map((field) => {
        let disposition = `Content-Disposition: form-data; name="${field.name}"`;
        if (field.filename) disposition += `; filename="${field.filename}"`;
        const typeLine = `Content-Type: ${field.contentType || 'text/plain; charset=utf-8'}`;
        const value = field.value === undefined || field.value === null ? '' : String(field.value);
        return `--${boundary}\r\n${disposition}\r\n${typeLine}\r\n\r\n${value}\r\n`;
      })
      .join('') + `--${boundary}--\r\n`;
    const bodyBuffer = Buffer.from(body, 'utf8');
    const options = {
      hostname: 'api.stability.ai',
      path: apiPath,
      method,
      headers: {
        'Authorization': `Bearer ${STABILITY_API_KEY}`,
        'Accept': 'application/json',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuffer.length,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data || '{}');
            resolve(parsed);
          } catch (err) {
            reject(err);
          }
        } else {
          const err = new Error(`Stability API error ${res.statusCode}: ${data}`);
          err.statusCode = res.statusCode;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(bodyBuffer);
    req.end();
  });
}

function downloadBinary(urlString) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const getter = parsed.protocol === 'http:' ? http : https;
    getter.get(parsed, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(downloadBinary(res.headers.location));
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Download failed ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const isProduction = process.env.NODE_ENV === 'production';

function generateRequestId(prefix = 'req') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function logServerError(tag, err, info = {}) {
  const payload = {
    tag,
    message: err?.message || 'internal_error',
    stack: err?.stack,
    ...info,
  };
  console.error(`[Server][${tag}]`, payload);
}

function respondWithServerError(res, err, { requestId, statusCode } = {}) {
  if (res.headersSent) return;
  const isOpenAISchema = err?.code === 'OPENAI_SCHEMA_ERROR';
  const status = statusCode || err?.statusCode || (isOpenAISchema ? 502 : 500);
  const payload = {
    error: isOpenAISchema
      ? { message: 'openai_schema_error' }
      : { message: err?.message || 'internal_error', code: err?.code },
  };
  if (requestId) payload.requestId = requestId;
  if (isOpenAISchema && !isProduction && err?.rawContent) {
    payload.error.debug = err.rawContent;
  }
  if (!isOpenAISchema && !isProduction && err?.stack) {
    payload.debugStack = err.stack;
  }
  sendJson(res, status, payload);
}

function isUserPro(req) {
  const plan = req?.user?.plan;
  if (req?.user?.isPro) return true;
  if (plan && (plan === 'pro' || plan === 'teams')) return true;
  return false;
}

function analyticsUpgradeRequired(res) {
  return sendJson(res, 402, {
    ok: false,
    error: 'upgrade_required',
    feature: 'analytics_full',
  });
}

// Analytics window helpers: Free=30 days, Pro=90 days
function getAnalyticsWindowDays(req) {
  return isUserPro(req) ? 90 : 30;
}

function getSinceDate(days) {
  const since = new Date();
  since.setDate(since.getDate() - (Number.isFinite(days) ? days : 30));
  return since;
}

function filterPostsByWindow(posts, days) {
  if (!Array.isArray(posts) || !posts.length) return [];
  const since = getSinceDate(days);
  const cutoff = since.getTime();
  return posts.filter((p) => {
    const ts = p?.published_at || p?.publishedAt || p?.created_at || p?.createdAt;
    if (!ts) return true; // if unknown date, keep it
    const t = new Date(ts).getTime();
    return Number.isFinite(t) ? t >= cutoff : true;
  });
}

function filterSeriesByWindow(series, days) {
  if (!Array.isArray(series) || !series.length) return [];
  const since = getSinceDate(days);
  const cutoff = since.getTime();
  return series.filter((pt) => {
    const ts = pt?.date || pt?.day || pt?.ts || pt?.timestamp;
    const t = new Date(ts).getTime();
    return Number.isFinite(t) ? t >= cutoff : true;
  });
}

const CALENDAR_EXPORT_FEATURE_KEY = 'calendar_exports';

const MAX_JSON_BODY = 1 * 1024 * 1024; // 1MB cap to prevent oversized payloads.

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_JSON_BODY) {
        const err = new Error('Payload too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        const err = new Error('Invalid JSON payload');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > MAX_JSON_BODY) {
        const err = new Error('Payload too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks, length));
    });
    req.on('error', (err) => reject(err));
  });
}

function parsePhylloSignatureHeader(signatureHeader) {
  if (!signatureHeader) return '';
  const parts = String(signatureHeader)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const key = part.slice(0, idx).trim().toLowerCase();
      const value = part.slice(idx + 1).trim();
      if (['sha256', 'signature', 'v1'].includes(key) && value) {
        return value;
      }
    }
  }
  if (parts.length === 1) {
    const single = parts[0];
    const idx = single.indexOf('=');
    if (idx > 0) {
      return single.slice(idx + 1).trim();
    }
    return single;
  }
  return signatureHeader.trim();
}

function verifyPhylloWebhookSignature(rawBody, signatureHeader) {
  if (!PHYLLO_WEBHOOK_SIGNING_SECRET) return true;
  const signature = parsePhylloSignatureHeader(signatureHeader);
  if (!signature) return false;
  try {
    const expected = crypto
      .createHmac('sha256', PHYLLO_WEBHOOK_SIGNING_SECRET)
      .update(rawBody)
      .digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(signature, 'hex');
    if (expectedBuf.length !== providedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  } catch (err) {
    console.error('[Phyllo] webhook signature verification error', err);
    return false;
  }
}

async function requireSupabaseUser(req) {
  if (!supabaseAdmin) {
    const err = new Error('Supabase admin client not configured');
    err.statusCode = 501;
    throw err;
  }
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  return data.user;
}

function parseLinkedDayFromKey(calendarDayId) {
  if (!calendarDayId) return null;
  const match = String(calendarDayId).match(/(\d{1,2})$/);
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function mapDesignAssetRow(row) {
  if (!row) return null;
  const data = row.data || {};
  const linkedDay = data.linked_day || parseLinkedDayFromKey(row.calendar_day_id);
  const cloudinaryUrl = row.cloudinary_public_id ? buildCloudinaryUrl(row.cloudinary_public_id) : '';
  const imageUrl = row.image_url || cloudinaryUrl;
  const previewUrl = data.preview_url || imageUrl || cloudinaryUrl;
  const errorMessage = data.error_message || '';
  const notesForAi = data.notes_for_ai ?? data.notes ?? '';
  return {
    id: row.id,
    type: row.type,
    assetType: row.type,
    typeLabel: getDesignAssetTypeLabel(row.type),
    status: row.status,
    calendarDayId: row.calendar_day_id,
    linkedDay,
    linkedDayLabel: linkedDay ? `Day ${String(linkedDay).padStart(2, '0')}` : '',
    title: data.title || 'Post Graphic',
    subtitle: data.subtitle || '',
    cta: data.cta || '',
    notes: notesForAi,
    notesForAi,
    campaign: data.campaign || 'General',
    tone: data.tone || '',
    previewUrl,
    previewInlineUrl: previewUrl,
    downloadUrl: previewUrl,
    image_url: imageUrl,
    cloudinaryUrl,
    designUrl: `/design.html?asset=${encodeURIComponent(row.id)}`,
    cloudinaryPublicId: row.cloudinary_public_id || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    data,
    error_message: errorMessage,
    origin: 'remote',
  };
}

async function markDesignAssetStatus(id, patch = {}) {
  if (!supabaseAdmin || !id) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('design_assets')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single();
    if (error) {
      console.error('Unable to update design asset status', { id, error });
      return null;
    }
    return data;
  } catch (error) {
    console.error('Design asset status update failed', { id, message: error?.message });
    return null;
  }
}

function buildCalendarDayId(payload = {}) {
  if (payload.calendar_day_id) return String(payload.calendar_day_id);
  if (payload.calendarDayId) return String(payload.calendarDayId);
  if (payload.id) return String(payload.id);
  const day = Number(payload.day || payload.linkedDay);
  if (Number.isFinite(day) && day > 0) {
    return `day-${String(day).padStart(2, '0')}`;
  }
  return `session-${Date.now()}`;
}

function parseRequestedDay(body = {}, calendarDayId) {
  const raw =
    body?.linkedDay ||
    body?.day ||
    (calendarDayId ? parseLinkedDayFromKey(calendarDayId) : null);
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) {
    return n;
  }
  return null;
}

function buildBaseDesignDataFromBody(body = {}, overrides = {}) {
  const calendarDayId = overrides.calendarDayId || buildCalendarDayId(body);
  const linkedDay =
    overrides.linkedDay ??
    parseRequestedDay(body, calendarDayId);
  const normalizedType = String(overrides.type || body.type || 'story').toLowerCase();
  return {
    calendar_day_id: calendarDayId,
    type: normalizedType,
    title: (body.title || '').trim(),
    subtitle: (body.subtitle || body.caption || '').trim(),
    cta: (body.cta || '').trim(),
    brand_color: (body.brand_color || body.brandColor || '').trim(),
    prompt: body.prompt || '',
    tone: body.tone || '',
    campaign: body.campaign || '',
    month: body.month || '',
    linked_day: linkedDay,
    platform: (body.platform || 'instagram').toLowerCase(),
    background_image: (body.backgroundImageUrl || '').trim(),
    logo: (body.logoUrl || '').trim(),
    slides: body.slides || null,
    story_copy: body.story_copy || '',
  };
}

function applyTypeSpecificDefaults(designData = {}, brandProfile, calendarDay) {
  const result = { ...designData };
  const voiceHint = (brandProfile?.voice || '').trim();
  const dayData = calendarDay || {};

  if (result.type === 'story') {
    if (!result.title && dayData.title) result.title = dayData.title;
    if (!result.subtitle && dayData.shortDescription) result.subtitle = dayData.shortDescription;
    if (!result.story_copy) {
      result.story_copy = dayData.story_copy || dayData.storyPrompt || result.subtitle || '';
    }
    if (!result.prompt && voiceHint) {
      result.prompt = `Create Instagram story frames in this brand voice: ${voiceHint}`;
    }
  }

  if (result.type === 'carousel') {
    if (!result.title && dayData.title) result.title = dayData.title;
    if (!result.subtitle && dayData.angle) result.subtitle = dayData.angle;
    const slides = Object.assign(
      {},
      result.slides || {},
      dayData.slides || {
        slide1: dayData.slide1 || '',
        slide2: dayData.slide2 || '',
        slide3: dayData.slide3 || '',
      }
    );
    result.slides = slides;
  }

  return result;
}

function resolveBackgroundAspectForType(type) {
  const key = String(type || '').toLowerCase();
  if (key === 'story') return '9:16';
  if (key === 'carousel') return '1:1';
  return '4:5';
}

async function fetchBrandBrainRow(userId) {
  if (!supabaseAdmin || !userId) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('brand_brains')
      .select('logo_url,heading_font,body_font,primary_color,secondary_color,accent_color')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.warn('[BrandBrain] Supabase fetch error', { userId, message: error.message });
      return null;
    }
    return data || null;
  } catch (err) {
    console.warn('[BrandBrain] Supabase fetch exception', { userId, message: err?.message });
    return null;
  }
}

async function maybeAttachGeneratedBackground(designData, brandProfile) {
  if (!STABILITY_API_KEY || designData.background_image) return designData;
  const promptParts = [
    'High-quality, abstract social media background graphic',
    designData.title || '',
    designData.campaign || '',
    brandProfile?.voice ? `Brand voice: ${brandProfile.voice}` : '',
    brandProfile?.primaryColor ? `Primary color ${brandProfile.primaryColor}` : '',
    brandProfile?.secondaryColor ? `Secondary color ${brandProfile.secondaryColor}` : '',
  ].filter(Boolean);
  const prompt = promptParts.join('. ');
  if (!prompt) return designData;
  try {
    const aspectRatio = resolveBackgroundAspectForType(designData.type);
    const buffer = await generateStabilityImage(prompt, aspectRatio);
    if (buffer && buffer.length) {
      const dataUri = `data:image/png;base64,${buffer.toString('base64')}`;
      const upload = await uploadAssetFromUrl({ url: dataUri });
      if (upload?.secureUrl) {
        return Object.assign({}, designData, { background_image: upload.secureUrl });
      }
    }
  } catch (err) {
    console.warn('Optional background generation failed', { message: err?.message });
  }
  return designData;
}

async function loadCalendarDay(calendarDayId, userId) {
  // TODO: Wire to Supabase calendar data. For now, return null so type-specific
  // defaults rely on request payload.
  return null;
}

function safePlacidText(value, max = 300) {
  if (!value) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function mergeBrandProfileIntoDesignData(designData = {}, brandProfile = null, fallbackBrandColor = '') {
  if (!brandProfile) {
    if (fallbackBrandColor && !designData.primary_color) {
      return { ...designData, primary_color: fallbackBrandColor, brand_color: designData.brand_color || fallbackBrandColor };
    }
    return designData;
  }
  const next = { ...designData };
  const logo = brandProfile.logo_url || brandProfile.logoUrl;
  const heading = brandProfile.heading_font || brandProfile.headingFont;
  const body = brandProfile.body_font || brandProfile.bodyFont;
  const primary = brandProfile.primary_color || brandProfile.primaryColor;
  const secondary = brandProfile.secondary_color || brandProfile.secondaryColor;
  const accent = brandProfile.accent_color || brandProfile.accentColor;
  if (logo && !next.logo) next.logo = logo;
  if (heading && !next.heading_font) next.heading_font = heading;
  if (body && !next.body_font) next.body_font = body;
  if (primary && !next.primary_color) next.primary_color = primary;
  if (secondary && !next.secondary_color) next.secondary_color = secondary;
  if (accent && !next.accent_color) next.accent_color = accent;
  if (!next.brand_color) next.brand_color = next.primary_color || primary || next.brand_primary_color || fallbackBrandColor;
  return next;
}

// NOTE: Placid template currently only binds title, subtitle, cta, logo, background_image, brand_color, and platform.
// Brand metadata still lives in design_assets.data for future template bindings.
function buildPlacidPayload(data = {}) {
  return {
    title: safePlacidText(data.title, 120),
    subtitle: safePlacidText(data.subtitle, 360),
    cta: safePlacidText(data.cta, 80),
    brand_color: data.brand_color || data.brand_primary_color || '#7f5af0',
    platform: data.platform || 'instagram',
    logo: data.logo || data.brand_logo_url || '',
    background_image: data.background_image || '',
  };
}

async function handleCreateDesignAsset(req, res) {
  let requestBody = null;
  let user = null;
  try {
    user = await requireSupabaseUser(req);
    requestBody = await readJsonBody(req);
    console.log('[Promptly] POST /api/design-assets body:', requestBody);
    const type = String(requestBody.type || 'story').toLowerCase();
    if (!ALLOWED_DESIGN_ASSET_TYPES.includes(type)) {
      return sendJson(res, 400, {
        error: 'unsupported_asset_type',
        supported: ALLOWED_DESIGN_ASSET_TYPES,
      });
    }
    const bodyCalendarId = requestBody.calendarDayId || requestBody.calendar_day_id || '';
    if (!bodyCalendarId) {
      console.error('[DesignAssets] missing_calendar_day_id');
      return sendJson(res, 400, { error: 'missing_calendar_day_id', details: 'calendarDayId is required' });
    }
    if (requestBody.userId && requestBody.userId !== user.id) {
      console.warn('Design asset request userId mismatch', {
        bodyUserId: requestBody.userId,
        authUserId: user.id,
      });
    }
    const calendarDayId = buildCalendarDayId(requestBody);
    const linkedDay = parseRequestedDay(requestBody, calendarDayId);
    const title = (requestBody.title || requestBody.idea || '').trim();
    const subtitle = (requestBody.subtitle || requestBody.caption || '').trim();
    const cta = (requestBody.cta || '').trim();
    const backgroundImage = requestBody.background_image || requestBody.backgroundImageUrl || requestBody.heroImage || '';
    requestBody.title = title;
    requestBody.subtitle = subtitle;
    requestBody.cta = cta;
    requestBody.backgroundImageUrl = backgroundImage;

    const templateId = resolvePlacidTemplateId(type);
    if (!templateId) {
      console.error('[DesignAssets] Missing template id for type', type);
      return sendJson(res, 501, {
        error: 'Design pipeline not configured: missing Placid template id for this asset type.',
        status: 'failed',
      });
    }

    const brandProfile = (await fetchBrandBrainRow(user.id)) || (await getBrandBrainForUser(user.id));
    console.log('[BrandBrain] for user', user.id, brandProfile);
    const calendarDay = await loadCalendarDay(calendarDayId, user.id);
    let designData = buildBaseDesignDataFromBody(requestBody, { calendarDayId, linkedDay, type });
    designData.type = type;
    designData = applyTypeSpecificDefaults(designData, brandProfile, calendarDay);
    designData = mergeBrandProfileIntoDesignData(designData, brandProfile, requestBody.brand_color || requestBody.brandColor || '');

    // Ensure logo is a publicly reachable URL
    if (designData.logo && designData.logo.startsWith('data:image/')) {
      try {
        const uploadedLogo = await uploadAssetFromUrl({
          url: designData.logo,
          folder: 'promptly/brand-logos',
        });
        if (uploadedLogo?.secureUrl) {
          designData.logo = uploadedLogo.secureUrl;
        }
      } catch (logoErr) {
        console.warn('Brand logo upload failed, keeping existing logo value', logoErr?.message);
      }
    }
    // Ensure we have a branded background image
    if (!designData.background_image) {
      try {
        designData.background_image = await generateBrandedBackgroundImage({
          title: designData.title,
          subtitle: designData.subtitle,
          cta: designData.cta,
          primaryColor: designData.primary_color || designData.brand_color,
          secondaryColor: designData.secondary_color,
          accentColor: designData.accent_color,
        });
        console.log('[DesignAssets] Generated branded background', { background_image: designData.background_image });
      } catch (err) {
        console.warn('Branded background generation failed, falling back to existing logic', err?.message);
        designData = await maybeAttachGeneratedBackground(designData, brandProfile);
      }
    }

    const inserted = await createDesignAsset({
      type,
      user_id: user.id,
      calendar_day_id: calendarDayId,
      data: designData,
    });
    console.log('[Supabase] createDesignAsset inserted', inserted);

    return sendJson(res, 201, mapDesignAssetRow(inserted));
  } catch (error) {
    const safeBody = requestBody
      ? {
          type: requestBody.type,
          calendarDayId: requestBody.calendarDayId || requestBody.calendar_day_id,
        }
      : null;
    console.error('[ERROR] /api/design-assets', {
      message: error?.message,
      stack: error?.stack,
      body: safeBody,
      userId: user?.id || null,
    });
    if (error?.statusCode === 401) {
      return sendJson(res, 401, { error: 'unauthorized', details: error?.message || 'Unauthorized' });
    }
    if (error?.statusCode === 413) {
      return sendJson(res, 413, { error: 'payload_too_large', details: error?.message || 'Request payload too large' });
    }
    if (error?.statusCode === 501) {
      return sendJson(res, 501, { error: 'design_pipeline_unavailable', details: error?.message || 'Design pipeline not configured' });
    }
    if (error?.statusCode === 400) {
      return sendJson(res, 400, { error: 'invalid_request', details: error.message || 'Invalid request' });
    }
    return sendJson(res, 500, { error: 'unable_to_create_design_asset', details: error?.message || 'Unable to create design asset' });
  }
}

async function handleListDesignAssets(req, res, query) {
  try {
    if (!supabaseAdmin) {
      return sendJson(res, 200, []);
    }
    const user = await requireSupabaseUser(req);
    let builder = supabaseAdmin
      .from('design_assets')
      .select('*')
      .eq('user_id', user.id) // RLS + explicit user_id filter ensure each user only sees their own assets.
      .order('created_at', { ascending: false });
    if (query.calendarDayId) {
      builder = builder.eq('calendar_day_id', query.calendarDayId);
    }
    if (query.type) {
      builder = builder.eq('type', query.type);
    }
    const { data, error } = await builder;
    if (error) {
      console.error('Design asset list error:', error);
      return sendJson(res, 200, []);
    }
    const payload = (data || []).map((row) => mapDesignAssetRow(row));
    return sendJson(res, 200, payload);
  } catch (error) {
    console.error('Design asset list error:', error);
    if (error?.statusCode === 401) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }
    return sendJson(res, 500, { error: 'Unable to list assets' });
  }
}

async function handleGetDesignAsset(req, res, assetId) {
  try {
    if (!supabaseAdmin) {
      return sendJson(res, 404, { error: 'Asset not found' });
    }
    const user = await requireSupabaseUser(req);
    const { data, error } = await supabaseAdmin
      .from('design_assets')
      .select('*')
      .eq('id', assetId)
      .eq('user_id', user.id) // RLS + explicit user_id filter ensure each user only sees their own assets.
      .single();
    if (error || !data) {
      return sendJson(res, 404, { error: 'Asset not found' });
    }
    let assetRow = data;
    return sendJson(res, 200, mapDesignAssetRow(assetRow));
  } catch (error) {
    console.error('Design asset fetch error:', error);
    if (error?.statusCode === 401) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }
    return sendJson(res, 500, { error: 'Unable to load asset' });
  }
}

async function handlePatchDesignAsset(req, res, assetId) {
  if (!supabaseAdmin) {
    return sendJson(res, 501, { error: 'Design pipeline not configured' });
  }
  let user = null;
  try {
    user = await requireSupabaseUser(req);
  } catch (error) {
    const status = error?.statusCode || 401;
    return sendJson(res, status, { error: error?.message || 'Unauthorized' });
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = error?.statusCode || 400;
    return sendJson(res, status, { error: error?.message || 'Invalid request' });
  }
  const dataPatch = body.data && typeof body.data === 'object' ? body.data : {};
  const regenerate = Boolean(body.regenerate);
  let existing;
  try {
    existing = await getDesignAssetById(assetId, user.id);
  } catch (error) {
    const status = error?.statusCode || 404;
    return sendJson(res, status, { error: 'asset_not_found', details: error?.message });
  }
  const mergedData = { ...(existing.data || {}), ...dataPatch };
  mergedData.type = mergedData.type || existing.type;
  if (typeof mergedData.title === 'string') mergedData.title = mergedData.title.trim();
  if (typeof mergedData.subtitle === 'string') mergedData.subtitle = mergedData.subtitle.trim();
  if (typeof mergedData.cta === 'string') mergedData.cta = mergedData.cta.trim();
  if (typeof mergedData.notes_for_ai === 'string') {
    mergedData.notes_for_ai = mergedData.notes_for_ai.trim() || null;
  }
  const baseUpdate = {
    data: mergedData,
  };
  if (regenerate) {
    baseUpdate.status = 'rendering';
    baseUpdate.placid_render_id = null;
    baseUpdate.cloudinary_public_id = null;
    baseUpdate.data = {
      ...mergedData,
      preview_url: null,
      cloudinary_public_id: null,
      error_code: null,
    };
  }
  let updatedRow = null;
  try {
    updatedRow = await updateDesignAsset(assetId, baseUpdate, user.id);
  } catch (error) {
    const statusCode = error?.statusCode || 500;
    const message = error?.message || '';
    console.error('[ERROR] PATCH /api/design-assets/:id update failed', {
      message: error?.message,
      assetId,
      userId: user.id,
    });
    return sendJson(res, statusCode, { error: statusCode === 404 ? 'asset_not_found' : 'unable_to_update_asset', details: message || 'Update failed' });
  }
  // Pipeline will pick up queued/rendering assets; no direct render here.
  const mapped = mapDesignAssetRow(updatedRow);
  return sendJson(res, 200, { asset: mapped });
}

async function handleDeleteCalendar(req, res, calendarId) {
  if (!supabaseAdmin) {
    return sendJson(res, 501, { error: 'Calendar storage not configured' });
  }
  if (!calendarId) {
    return sendJson(res, 400, { error: 'calendarId required' });
  }
  let user;
  try {
    user = await requireSupabaseUser(req);
  } catch (error) {
    const status = error?.statusCode || 401;
    return sendJson(res, status, { error: error?.message || 'Unauthorized' });
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('calendars')
      .delete()
      .eq('id', calendarId)
      .eq('user_id', user.id)
      .select('id')
      .single();
    if (error) {
      const code = String(error.code || '').toLowerCase();
      const message = String(error.message || '').toLowerCase();
      if (code === 'pgrst116' || message.includes('row not found')) {
        return sendJson(res, 404, { error: 'Calendar not found' });
      }
      console.error('Calendar delete error', { calendarId, message: error.message });
      return sendJson(res, 500, { error: 'Unable to delete calendar' });
    }
    if (!data) {
      return sendJson(res, 404, { error: 'Calendar not found' });
    }
    res.writeHead(204);
    res.end();
  } catch (error) {
    console.error('Calendar delete error', { calendarId, message: error?.message });
    return sendJson(res, 500, { error: 'Unable to delete calendar' });
  }
}

async function handleDebugDesignTest(req, res) {
  try {
    await requireSupabaseUser(req);
  } catch (error) {
    const status = error?.statusCode || 401;
    return sendJson(res, status, { error: error?.message || 'Unauthorized' });
  }
  const debugTemplateId = STORY_TEMPLATE_ID || CAROUSEL_TEMPLATE_ID;
  if (!debugTemplateId) {
    return sendJson(res, 501, { error: 'No Placid template id is configured for debug render' });
  }
  try {
    const payload = buildPlacidPayload({
      title: 'Debug Title',
      subtitle: 'Debug Subtitle',
      cta: 'Tap to learn more',
      brand_color: '#7f5af0',
      platform: 'instagram',
    });
    const render = await createPlacidRender({
      templateId: debugTemplateId,
      data: payload,
    });
    console.log('Design debug test result', {
      render,
    });
    return sendJson(res, 200, { render });
  } catch (error) {
    console.error('Design debug test error', {
      message: error?.message,
      details: error?.details || null,
    });
    return sendJson(res, error?.statusCode || 500, {
      error: error?.message || 'Debug design test failed',
      details: error?.details || null,
    });
  }
}

async function handlePlacidTemplateDebug(req, res) {
  const types = ['story', 'carousel'];
  const results = [];
  for (const type of types) {
    const templateId = resolvePlacidTemplateId(type);
    if (!templateId) {
      results.push({ type, templateId: null, ok: false, error: 'No template id configured' });
      continue;
    }
    try {
      const testPayload = {
        title: `Debug ${type} title`,
        subtitle: `Debug ${type} subtitle`,
        cta: 'Learn more',
        background_image: '',
      };
      const render = await createPlacidRender({ templateId, data: testPayload });
      results.push({ type, templateId, ok: true, renderId: render.renderId || render.id, status: render.status });
    } catch (err) {
      results.push({
        type,
        templateId,
        ok: false,
        error: err?.message || 'Error',
        status: err?.response?.status,
        body: err?.response?.data,
      });
    }
  }
  return sendJson(res, 200, { results });
}

async function handleDebugDesignAssets(req, res) {
  try {
    if (!supabaseAdmin) {
      return sendJson(res, 500, { error: 'supabaseAdmin not configured' });
    }
    const { data, error } = await supabaseAdmin
      .from('design_assets')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) {
      console.error('[Debug] design_assets query error', error);
      return sendJson(res, 500, { error: 'Debug design_assets query failed' });
    }
    return sendJson(res, 200, { rows: data });
  } catch (err) {
    console.error('[Debug] design_assets unhandled error', err);
    return sendJson(res, 500, { error: 'Debug design_assets unhandled error' });
  }
}

async function handleDebugPlacidConfig(req, res) {
  return sendJson(res, 200, {
    configured: {
      PLACID_API_KEY: process.env.PLACID_API_KEY ? 'SET' : 'MISSING',
      PLACID_STORY_TEMPLATE_ID: STORY_TEMPLATE_ID || 'NOT SET',
      PLACID_CAROUSEL_TEMPLATE_ID: CAROUSEL_TEMPLATE_ID || 'NOT SET',
    },
    resolvedTemplateIds: {
      story: resolvePlacidTemplateId('story'),
      carousel: resolvePlacidTemplateId('carousel'),
    },
    note: 'Check your Placid dashboard at https://placid.app to get valid template IDs'
  });
}

async function generateStabilityImage(prompt, aspectRatio = '9:16') {
  const json = await stabilityMultipartRequest({
    path: '/v2beta/stable-image/generate/sd3',
    method: 'POST',
    fields: [
      { name: 'prompt', value: prompt },
      { name: 'text_prompts[0][text]', value: prompt },
      { name: 'mode', value: 'text-to-image' },
      { name: 'aspect_ratio', value: aspectRatio },
      { name: 'output_format', value: 'png' },
    ],
  });
  const artifact = json && Array.isArray(json.artifacts) ? json.artifacts[0] : null;
  if (artifact && artifact.base64) {
    return Buffer.from(artifact.base64, 'base64');
  }
  if (typeof json?.image === 'string') {
    return Buffer.from(json.image, 'base64');
  }
  throw new Error(
    `Stability image generation returned unexpected payload: ${JSON.stringify(json).slice(0, 200)}`
  );
}

function buildCarouselSlidePrompt({
  slide,
  format,
  tone,
  concept,
  captionCue,
  cta,
  notes,
  brandPalette = {},
  fonts = {},
  niche = '',
}) {
  const paletteLine = [brandPalette.primary, brandPalette.secondary, brandPalette.accent].filter(Boolean).join(', ');
  const fontLine = [fonts.heading, fonts.body].filter(Boolean).join(' + ');
  const lines = [
    `Design slide ${slide.order} of a ${format.label} carousel (${format.width}x${format.height}).`,
    `Slide role: ${slide.instructions}`,
    concept ? `Concept or theme: ${concept}.` : '',
    captionCue ? `Caption cue or hook: ${captionCue}.` : '',
    niche ? `Audience: ${niche}.` : '',
    cta ? `CTA to reinforce eventually: ${cta}.` : '',
    notes ? `Creative notes: ${notes}.` : '',
    tone ? `Visual tone: ${tone}.` : '',
    paletteLine ? `Use the brand palette (${paletteLine}) for backgrounds and accents.` : '',
    fontLine ? `Typography should use ${fontLine}.` : '',
    'Keep copy on this slide under 15 English words with generous negative space.',
    'Maintain the same gradient/texture system used across the other slides.',
    format.aspectRatio === '9:16'
      ? 'Ensure safe margins for TikTok/Stories with vertical composition.'
      : 'Ensure square composition centered for Instagram carousel.',
    slide.key === 'engagement' ? 'Incorporate a sticker-style prompt asking viewers to comment, DM, or save.' : '',
    slide.key === 'cta' ? 'Include a button-style CTA and a subtle urgency line (e.g., “Spots filling fast”).' : '',
  ];
  return lines.filter(Boolean).join(' ');
}

async function generateCarouselSlides({
  tone,
  notes,
  concept,
  captionCue,
  cta,
  niche,
  brandPalette,
  fonts,
}) {
  const slides = [];
  const timestamp = Date.now();
  const baseSlug = slugify(concept || captionCue || 'carousel');
  for (const slideDef of CAROUSEL_SLIDE_BLUEPRINTS) {
    for (const format of CAROUSEL_OUTPUT_FORMATS) {
      const prompt = buildCarouselSlidePrompt({
        slide: slideDef,
        format,
        tone,
        concept,
        captionCue,
        cta,
        notes,
        brandPalette,
        fonts,
        niche,
      });
      const buffer = await generateStabilityImage(prompt, format.aspectRatio);
      const filename = `${timestamp}-${baseSlug}-${slideDef.key}-${format.key}.png`;
      const target = path.join(DESIGN_ASSETS_DIR, filename);
      fs.writeFileSync(target, buffer);
      const downloadUrl = `/data/design-assets/${filename}`;
      slides.push({
        id: `${timestamp}-${slideDef.key}-${format.key}`,
        label: `${slideDef.title} · ${format.label}`,
        role: slideDef.role,
        slideNumber: slideDef.order,
        platform: format.platform,
        aspectRatio: format.aspectRatio,
        width: format.width,
        height: format.height,
        downloadUrl,
        previewUrl: downloadUrl,
      });
    }
  }
  if (!slides.length) throw new Error('No carousel slides were generated');
  const zipName = `${timestamp}-${baseSlug}-carousel.zip`;
  const zipPath = path.join(DESIGN_ASSETS_DIR, zipName);
  const zip = new JSZip();
  slides.forEach((slide, idx) => {
    const fileName = slide.downloadUrl.split('/').pop();
    if (!fileName) return;
    const absolute = path.join(DESIGN_ASSETS_DIR, fileName);
    if (!fs.existsSync(absolute)) return;
    const zipLabel = `${String(slide.slideNumber || idx + 1).padStart(2, '0')}-${slugify(slide.label || `slide-${idx + 1}`)}.png`;
    zip.file(zipLabel, fs.readFileSync(absolute));
  });
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(zipPath, zipBuffer);
  return {
    slides,
    bundleUrl: `/data/design-assets/${zipName}`,
    previewUrl: slides[0]?.previewUrl || '',
    downloadUrl: slides[0]?.downloadUrl || '',
  };
}

function buildDesignPrompt({ assetType, tone, notes, day, caption, niche, brandKit, concept, cta, brandPalette = {}, fonts = {} }) {
  const isStory = /story/i.test(assetType || '');
  const paletteTokens = [brandPalette.primary, brandPalette.secondary, brandPalette.accent].filter(Boolean);
  const fontTokens = [fonts.heading, fonts.body].filter(Boolean);
  const pieces = [
    `Create a ${assetType || 'social media asset'} for ${niche || 'a modern brand'}.`,
    tone ? `Use a ${tone} aesthetic.` : '',
    day ? `This is for day ${day} of a 30-day campaign.` : '',
    caption ? `Core caption or CTA: ${caption}` : '',
    concept ? `Concept or hook to visualize: ${concept}.` : '',
    cta ? `Final call-to-action to emphasize: ${cta}.` : '',
    notes ? `Incorporate these notes: ${notes}` : '',
    isStory
      ? 'Design a vertical 9:16 Instagram/TikTok story template with exactly three stacked frames: Frame 1 (Hook), Frame 2 (Proof or Tip), Frame 3 (CTA). Each frame may contain at most two short English phrases (<= 6 words) and generous blank space for imagery.'
      : 'Keep the layout hero-image forward with concise overlays that stay under 12 total English words.',
    'All copy must be real English words (no lorem ipsum, no pseudo text).',
    'Avoid dense paragraphs—use large typography, capsule shapes, stickers, and gradient blocks so it is visually appealing, not a page of text.',
    'Ensure the design feels native to Instagram/TikTok algorithms: bold hook, social proof mid-frame, urgent CTA at the end.',
    'Use bold, legible typography and high-contrast layering suitable for mobile.',
    paletteTokens.length ? `Stick to this palette: ${paletteTokens.join(', ')}.` : '',
    fontTokens.length ? `Typography should pair ${fontTokens.join(' + ')}.` : '',
    brandKit ? describeBrandKitForPrompt(brandKit, { includeLogo: true }) : '',
  ].filter(Boolean);
  return pieces.join(' ');
}


function openAIRequest(options, payload, retryCount = 0, maxRetries = 3) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            // Retry on 502, 503, 504 (server errors) up to 3 times
            if ((res.statusCode === 502 || res.statusCode === 503 || res.statusCode === 504) && retryCount < maxRetries) {
              const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
              console.log(`OpenAI ${res.statusCode} error, retrying in ${delay}ms (attempt ${retryCount + 1}/${maxRetries})...`);
              setTimeout(() => {
                openAIRequest(options, payload, retryCount + 1, maxRetries).then(resolve).catch(reject);
              }, delay);
            } else {
              reject(new Error(`OpenAI error ${res.statusCode}: ${data}`));
            }
          }
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', (err) => {
      // Retry on network errors up to 3 times
      if (retryCount < maxRetries) {
        const delay = Math.pow(2, retryCount) * 1000;
        console.log(`OpenAI network error, retrying in ${delay}ms (attempt ${retryCount + 1}/${maxRetries})...`, err.message);
        setTimeout(() => {
          openAIRequest(options, payload, retryCount + 1, maxRetries).then(resolve).catch(reject);
        }, delay);
      } else {
        reject(err);
      }
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function stripJsonFences(raw = '') {
  return String(raw || '')
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();
}

function captureJsonSegment(text, startIndex) {
  const len = text.length;
  let inString = false;
  let escape = false;
  const stack = [];
  for (let i = startIndex; i < len; i += 1) {
    const char = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }
    if (char === '}' || char === ']') {
      if (!stack.length) break;
      const opener = stack.pop();
      if ((opener === '{' && char !== '}') || (opener === '[' && char !== ']')) break;
      if (!stack.length) {
        return text.slice(startIndex, i + 1);
      }
    }
  }
  return null;
}

function extractJsonChunk(raw = '') {
  const text = stripJsonFences(raw);
  if (!text) return null;
  for (let start = 0; start < text.length; start += 1) {
    const char = text[start];
    if (char !== '{' && char !== '[') continue;
    const segment = captureJsonSegment(text, start);
    if (segment) return segment.trim();
  }
  return null;
}

function parseAiJson(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  const chunk = extractJsonChunk(raw);
  if (!chunk) return null;
  try {
    return JSON.parse(chunk);
  } catch (err) {
    return null;
  }
}

function resolvePostsCandidate(parsed) {
  if (!parsed) return null;
  if (Array.isArray(parsed)) return parsed;
  const candidate = parsed.posts || parsed.calendar_posts || parsed.data || parsed.value;
  if (Array.isArray(candidate)) return candidate;
  return null;
}

// Generic sanitizer + parse attempts for LLM JSON array output.
// Returns { data, attempts } where data is parsed array (or object wrapped into array) and attempts is diagnostics.
function parseLLMArray(rawContent, { requireArray = true, itemValidate } = {}, context = {}) {
  const diagnostics = { rawLength: String(rawContent || '').length, attempts: [] };
  const directParsed = parseAiJson(rawContent);
  const directPosts = resolvePostsCandidate(directParsed);
  if (Array.isArray(directPosts)) {
    const validated = typeof itemValidate === 'function'
      ? directPosts.filter((item) => itemValidate(item))
      : directPosts;
    diagnostics.attempts.push('direct');
    return { data: validated, attempts: diagnostics.attempts };
  }
  let raw = String(rawContent || '').trim()
    .replace(/```\s*json\s*/gi, '')
    .replace(/```/g, '')
    .replace(/[​﻿]/g, '');

  // Escape literal newlines inside JSON strings (LLM sometimes emits real line breaks inside quoted values)
  function escapeNewlinesInsideStrings(text) {
    let out = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (!inStr) {
        if (c === '"') {
          inStr = true;
        }
        out += c;
        continue;
      }
      if (esc) {
        out += c;
        esc = false;
        continue;
      }
      if (c === '\\') {
        out += c;
        esc = true;
        continue;
      }
      if (c === '"') {
        inStr = false;
        out += c;
        continue;
      }
      if (c === '\n' || c === '\r') {
        out += '\\n';
        continue;
      }
      out += c;
    }
    return out;
  }
  raw = escapeNewlinesInsideStrings(raw);

  const extractJsonArray = (txt) => {
    const start = txt.indexOf('[');
    const end = txt.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return txt;
    return txt.substring(start, end + 1);
  };

  let candidate = extractJsonArray(raw)
    .replace(/,\s*(\]|\})/g, '$1')
    .replace(/,,+/g, ',')
    .replace(/([,{]\s*)([a-zA-Z0-9_]+)\s*:(?=\s*["0-9tfn\[{])/g, '$1"$2":');
  candidate = escapeNewlinesInsideStrings(candidate);

  const attempts = [];
  attempts.push(candidate);
  if (candidate !== raw) attempts.push(raw);
  if (!/^\s*\[/.test(candidate) && /"day"\s*:/.test(candidate)) {
    // Wrap pseudo-object list lines into array
    const lines = candidate.split(/\n+/).filter((l) => l.trim());
    attempts.push('[\n' + lines.join(',\n') + '\n]');
  }

  let lastErr;
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      let arr = parsed;
      if (requireArray && !Array.isArray(arr)) {
        if (arr && arr.posts && Array.isArray(arr.posts)) arr = arr.posts;
        else arr = [arr];
      }
      if (itemValidate && Array.isArray(arr)) {
        const ok = arr.every(itemValidate);
        if (!ok) throw new Error('Validation failure');
      }
      diagnostics.attempts.push({ ok: true, length: attempt.length });
      return { data: arr, attempts: diagnostics };
    } catch (e) {
      lastErr = e;
      diagnostics.attempts.push({ ok: false, error: e.message, length: attempt.length });
    }
  }
  // Fallback: multiple top-level objects separated by newlines without commas
  try {
    const objCount = (raw.match(/\n\s*\{/g) || []).length;
    if (!raw.trim().startsWith('[') && objCount > 0) {
      const parts = raw.split(/}\s*\n\s*\{/).map((p, i) => {
        if (i === 0 && p.trim().startsWith('{') && p.trim().endsWith('}')) return p.trim();
        if (i === 0) return p.trim() + '}';
        if (i === objCount) return '{' + p.trim();
        return '{' + p.trim();
      });
      const wrapped = '[' + parts.join(',') + ']';
      const parsed = JSON.parse(wrapped);
      if (requireArray && !Array.isArray(parsed)) throw new Error('Fallback not array');
      if (itemValidate && Array.isArray(parsed) && !parsed.every(itemValidate)) throw new Error('Fallback validation');
      diagnostics.attempts.push({ ok: true, fallback: 'object-split', length: wrapped.length });
      return { data: parsed, attempts: diagnostics };
    }
  } catch (e2) {
    diagnostics.attempts.push({ ok: false, fallbackError: e2.message });
  }
  const preview = raw.slice(0, 300);
  const contextLabel = formatParseContext(context);
  const messageParts = [
    `Failed to parse JSON after attempts: ${lastErr && lastErr.message ? lastErr.message : 'unknown error'}`,
  ];
  if (contextLabel) {
    messageParts.push(`context: ${contextLabel}`);
  }
  if (preview) {
    messageParts.push(`preview: ${preview}`);
  }
  throw new Error(messageParts.join(' | '));
}

function formatCalendarLogContext(context = {}) {
  const parts = [];
  if (context.requestId) parts.push(`requestId=${context.requestId}`);
  if (context.batchIndex !== undefined && context.batchIndex !== null) parts.push(`batchIndex=${context.batchIndex}`);
  if (context.startDay !== undefined && context.startDay !== null) parts.push(`startDay=${context.startDay}`);
  return parts.join(' ');
}

function formatParseContext(context = {}) {
  if (!context || typeof context !== 'object') return '';
  const parts = [];
  if (context.endpoint) parts.push(`endpoint=${context.endpoint}`);
  if (context.requestId) parts.push(`requestId=${context.requestId}`);
  if (context.batchIndex !== undefined && context.batchIndex !== null) parts.push(`batchIndex=${context.batchIndex}`);
  if (context.startDay !== undefined && context.startDay !== null) parts.push(`startDay=${context.startDay}`);
  if (context.day !== undefined && context.day !== null) parts.push(`day=${context.day}`);
  return parts.join(' ');
}

async function embedTextList(texts) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const payload = JSON.stringify({
    model: 'text-embedding-3-small',
    input: texts,
  });
  const options = {
    hostname: 'api.openai.com',
    path: '/v1/embeddings',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  };
  const json = await openAIRequest(options, payload);
  return json.data.map((d) => d.embedding);
}

function categorizeNiche(nicheStyle = '') {
  const businessKeywords = ['coach', 'coaching', 'consult', 'agency', 'business', 'strategy', 'startup', 'growth', 'marketing', 'sales', 'brite', 'consultant'];
  const creatorKeywords = ['creator', 'lifestyle', 'vlogger', 'artist', 'podcast', 'style', 'fitness', 'wellness', 'beauty', 'travel'];
  const normalized = String(nicheStyle || '').toLowerCase();
  if (!normalized) return 'creator';
  for (const keyword of businessKeywords) {
    if (normalized.includes(keyword)) return 'business';
  }
  for (const keyword of creatorKeywords) {
    if (normalized.includes(keyword)) return 'creator';
  }
  if (normalized.length <= 4) return 'creator';
  return 'business';
}

function extractStrategyKeyword(text = '') {
  const tokens = (String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter((token) => token.length > 3);
  return tokens.length ? tokens[0] : 'this topic';
}

function buildPrompt(nicheStyle, brandContext, opts = {}) {
  const days = Math.max(1, Math.min(30, Number(opts.days || 30)));
  const startDay = Math.max(1, Math.min(30, Number(opts.startDay || 1)));
  const classification = categorizeNiche(nicheStyle);
  const brandBlock = brandContext
    ? `\n\nBrand Context: ${brandContext}\n\n`
    : '\n';
  const preset = getPresetGuidelines(nicheStyle);
  const presetGuidelines = (() => {
    if (!preset) return '';
    if (Array.isArray(preset.presetGuidelines)) {
      return preset.presetGuidelines.join('\n');
    }
    return preset.presetGuidelines || '';
  })();
  const presetBlock = presetGuidelines
    ? `\n\nPreset Guidelines for this niche:\n${presetGuidelines}\n\n`
    : '\n';
  const nicheRules = Array.isArray(preset?.nicheRules) && preset.nicheRules.length
    ? preset.nicheRules.join('\n')
    : '';
  const promoGuardrail = `\nNiche-specific constraints:\n- Limit promoSlot=true or discount-focused posts to at most 3 per calendar. Only the single strongest weekly offer should get promoSlot=true and a weeklyPromo string. All other days must focus on storytelling, education, or lifestyle (promoSlot=false, weeklyPromo empty).`;
// DETAILS/HASHTAGS CONSTRAINTS (niche-locked, no generic filler)
const qualityRules = `Quality Rules — Make each post plug-and-play & conversion-ready:
1) HOOK RULES (HARD):
- Output a single Hook line only.
- 4–9 words. No emojis. No hashtags. No quotes. No exclamation spam.
- Must be explicitly tied to the niche/topic of THIS card (use the niche keywords already present in the card’s title/category/context).
- Must use a proven short-form retention mechanic: curiosity gap OR contrarian claim OR “common mistake” callout OR specific outcome promise.
- Must include ONE concrete specificity anchor (number, timeframe, or specific outcome) BUT ONLY if it naturally fits the niche and does not introduce randomness.
- Must not mention unrelated industries, treatments, products, or jargon outside the niche.
- Must not contain placeholders like [Client Name], [Your City], [Brand], etc.
- SALES/ALGO REQUIREMENTS:
- Optimize for first-1-second stop: pattern interrupt wording (“Stop doing X”, “You’re doing X wrong”, “Nobody tells you this”, “The real reason X”, “Do this instead”).
- Make the viewer self-identify (call out the exact audience pain/goal implied by the niche).
- If the card is local/service-based, imply urgency/scarcity WITHOUT sounding spammy (“limited slots”, “this week”, “openings”) but keep it subtle.
- FORBIDDEN:
- Any niche-mismatched terms (example: fitness card must not mention “facials”, “peels”, “glow”, skincare, real estate, etc.).
- Generic filler like “Fuel your body right”, “Meet our amazing client”, “Let’s get started”, “Game changer”, “Level up”.
- OUTPUT CHECK (PROMPT-LEVEL):
- If you cannot produce a niche-locked hook under these rules, output this fallback hook format instead, filled with niche-specific terms:
- “Stop making this [NICHE] mistake”
2) Details/Hashtags: output only a plain list of 8–12 hashtags (no prose, bullets, or labels) that stay strictly niche-relevant to the user’s niche, offer type, and platform. Provide 3–5 core niche tags, 3–5 problem/outcome tags, and 1–2 local/brand/community tags (use the brand name if available). Ban cross-niche contamination and filler (#fyp, #viral, #trending, #explorepage, #instagood, #tiktok, #reels, #love). Do not introduce unrelated niches; if the niche is ambiguous, infer the closest interpretation from the category/title and stay consistent.
3) CTA: time-bound urgency (e.g., "book today", "spots fill fast").
4) Design: specify colors, typography, pacing, and end-card CTA.
5) REMIX / SHARE RULES (HARD):
- Output ONE follow-up action only (no lists).
- Follow-up must be low-friction and directly derived from the SAME post; no new concepts.
- Stay within the same niche, pain point, and emotional thread.
- Increase retention or comments (reply-to-comment, remix a comment, quick clarification).
- No new offers, topics, or CTAs.

ALLOWED: “Reply to the top comment with a quick clarification.”, “Remix this answering the most common objection.”, “Share a short follow-up explaining the one part people ask about.”, “Go live briefly to answer the main question this sparked.”

FORBIDDEN:
- “Host a workshop”, “Launch a challenge”, “Promote another post”, “Announce an offer”, and any off-niche activity.

ALGO / SALES REQUIREMENTS:
- Follow-up should feel reactive and reward engagement; invite more comments.

FALLBACK (prompt-level): “Reply to the most common comment with a short follow-up.”
6) Engagement: natural, friendly scripts for comments & DMs.
7) FORMAT RULES (HARD):
- Output EXACTLY one format from {Reel, Carousel, Story, Static}.
- Format must be chosen via retention mechanics + sales intent.

FORMAT SELECTION GUIDANCE:
- Reel: strong hook, spoken delivery, pattern interrupt, emotional tension, or confession.
- Carousel: step-by-step clarification, visual before/after, or misconception debunk.
- Story: polls/sliders/question boxes or low-friction engagement.
- Static: single sharp insight with no motion/spoken delivery needed.

ALGO / SALES REQUIREMENTS:
- Prefer Reel unless another format clearly outperforms it.
- Avoid Static for content meant to drive comments or DMs.
- Format must support the Hook, Story Prompt, and CTA already defined.

FORBIDDEN:
- No random rotations or new format names.
- Do not pick a format that conflicts with the Reel Script or Story Prompt.

FALLBACK (prompt-level): If unsure, choose Reel.
8) Captions: a single, final caption (no variants) and platform-ready blocks for Instagram, TikTok, LinkedIn.
9) PINNED COMMENT RULES (HARD):
      Keyword rules
      - Keyword must be a real, readable word tied to the niche.
      - ALL CAPS, letters only (A–Z), length 3–8 characters.
      - No codes, no abbreviations that don't read naturally.
      Examples by niche:
      - Restaurant / fast food: BURGER, MENU, DEAL, SAUCE, FRIES
      - Sports coaching: TRAIN, HOOPS, DRILLS
      - Fitness: LIFT, SWEAT, MEAL
      - Generic fallback: START
      Sales-mode rules
      - Infer niche type: restaurant/fast food/cafe/bar/venue → NO SALES; coach/course/service/creator → sales allowed.
      If NO SALES:
      - Do NOT say “I'll send you my guide/plan/breakdown”.
      - Do NOT imply funnels, lead magnets, or DMs.
      - Use engagement-only phrasing (reply, share, vote, try).
      If sales allowed:
      - One soft conversion action is allowed (DM, send guide, next step) with no urgency spam.
      Allowed formats:
      - NO SALES: Comment “BURGER” and we’ll reply with our top pick.
      - NO SALES: Comment “MENU” and we’ll reply with today’s favorite.
      - SALES OK: Comment “TRAIN” and I’ll DM the plan.
      - SALES OK: Comment “START” and I’ll send the breakdown.
      Hard bans: No numbers. No fake words. No keywords that make the sentence sound broken.
      Pinned comments should encourage replies and conversation, regardless of sales mode.
10) OFFER / LEAD MAGNET RULES (HARD): describe ONE clear deliverable tied to the card topic. Frame it as a clarifier or simplifier, not a promised result, using low-pressure language aligned with the pinned keyword and CTA.
      ALLOWED FRAMING: “the simple plan that cleared this up”, “the checklist I use”, “the breakdown that made this click”, “the template I wish I had earlier”, “the framework that simplified this”.
      FORBIDDEN FRAMING: “guaranteed results”, “transform your life”, “limited time”, “spots filling fast”, “exclusive access”, “free consultation”, “book now”, “join today”.
      SALES/ALGO REQUIREMENTS: make the deliverable feel like the natural next step after the pain; avoid hype and rely on relevance-driven curiosity.
      FALLBACK (prompt-level): “the simple guide that explains this clearly” (adapt wording for the niche but keep the tone neutral).
 11) STORY PROMPT+ HARD RULES: STAY STRICTLY IN NICHE: {niche}. Use only concepts/products/activities that exist in this niche. NEVER reference skincare/medspa terms (facial, peel, glow, botox, filler, serum, cleanser, moisturizer, acne, skincare, med spa, medspa, aesthetics, cosmetic, dermatology) unless the niche is explicitly skincare/medspa. Story Prompt+ must reference the niche directly and may only use stickers/questions that make sense for that niche. Poll options and slider labels must be niche-specific (e.g., burgers vs fries, coach vs drill, listings vs tours). Output exactly 1–2 sentences: first sentence is a niche-specific question, second sentence lists 1–2 IG Story interactions (poll/quiz/slider/question box) with niche-specific wording. No additional commentary or unrelated examples. Before returning Story Prompt+, re-scan for any word that implies another niche; if found, rewrite it to niche-specific wording.
12) STORY PROMPT RULES (HARD): output exactly one short question (no bullets, no lists). Must be niche-locked and tied to the same topic as the Hook/Caption. The question must trigger self-identification or confession and feel slightly uncomfortable but relatable. Do not introduce new topics, reuse unrelated niches, or include emojis, hashtags, CTAs, or platform mentions.
            ALLOWED PATTERNS (reference the niche/topic): "What part of [NICHE ACTIVITY] feels hardest right now?", "What do you keep trying that still isn’t working?", "What’s the one thing you’re stuck on with [NICHE TOPIC]?"
            FORBIDDEN TYPES: generic goals ("What’s your goal?"), preference questions without tension ("What do you like more?"), advice-seeking prompts ("What tips do you need?"), or off-niche content (no skincare/beauty terms unless the niche is beauty).
            ALGO/SALES REQUIREMENTS: the question should invite comments and longer replies and prime the viewer for the pinned comment or Story Prompt+ without selling.
            FALLBACK (prompt level): if unsure, output "What’s the most frustrating part of [NICHE TOPIC] for you?" (fill in niche-specific wording).
12) Execution Notes: follow these hard rules—Output EXACTLY two lines under Execution Notes: first line must be "Format: <choice>" with Reel/Carousel/Story/Static (match platform: TikTok/Instagram prefer Reel unless concept needs Carousel/Story; LinkedIn prefers Static/Carousel). Second line must be "Posting time tip: <time window> because <niche audience behavior reason>" (time window like 6–8 PM, no dates, tie to habits). Always stay niche-aligned (no off-niche terms) and platform-aligned, no generic “post when your audience is online,” no emojis, each line <= 120 characters. Keep concise and contextual.
13) Keep outputs concise to avoid truncation.
14) CRITICAL: Every post MUST include a single script/reelScript with hook/body/cta.`;

  const audioRules = `AUDIO RULES (HARD):
- Output audio suggestions ONLY for the platforms already listed in the card.
- Sounds must support spoken delivery and retention; never overpower the voice.
- Prefer low-to-mid tempo, neutral or lightly trending choices that feel native.
- Keep tone niche-appropriate (no hype for confessional, no soft ambient for high energy demos).
- Audio should feel optional, not essential; keep it in the background.

CREDIT FORMAT (exact):
- TikTok: <Sound name> — @creator
- Instagram: <Sound name> — @artist

FORBIDDEN:
- “Guaranteed viral” claims
- “Use any trending sound” directives
- Meme/comedy/novelty audio unless the archetype is humor-based
- Platform instructions (“tap sound”, “use this trend”)

ALGO / SALES REQUIREMENTS:
- Choose audio that increases watch time by lowering friction, not spectacle.
- If unsure, recommend a subtle or instrumental option.

FALLBACK (prompt-level):
TikTok: Subtle instrumental — @originalaudio
Instagram: Low-key instrumental — @originalaudio`;
  const classificationRules =
    classification === 'business'
      ? 'Business/coaching hooks must focus on problems, outcomes, and offers using curiosity gap, pain-agitation-relief, proof, objection handling, or direct CTA to comment/DM. Pinned comments must promise a niche-specific deliverable that feels like a mini-audit, checklist, guide, or audit plan.'
      : 'Creator/lifestyle hooks must feel identity or relatability driven (story time, contrarian take, behind-the-scenes, challenge, or trend frames) and avoid aggressive selling. Pinned comments should feel human, promise a helpful resource, and stay conversational.';
  const distributionPlanRules = `Distribution Plan rules:
Generate a Distribution Plan for the SAME NICHE and SAME POST as the content card. Use the niche/brand context provided. Do not introduce any topic that is not in this niche. No unrelated references.
Return EXACTLY three lines:
Instagram: (1–2 sentences) include a save/share reason + one engagement loop (comment keyword or save prompt) that matches the post’s hook and CTA.
TikTok: (1–2 sentences) include a pattern interrupt in the first five words + a watch-time loop (“part 2,” “wait for the last tip,” “most people miss this”) that matches the post’s hook and CTA.
LinkedIn: (1–2 sentences) include a credibility framing (lesson/insight) + a soft CTA that matches the post’s hook and CTA.
Hard rules: stay niche-locked; no off-topic nouns; no random beauty/food/finance terms unless that is the niche; no numbers in any comment keyword; no placeholder junk; no extra lines.`; 
  const postingTimeRules =
    'POSTING TIME TIP RULES (HARD): Output EXACTLY one sentence of ≤12 words in the pattern “Post [time] [preposition] [reason].” Include a specific time (e.g., “7am”, “12pm”, “6–8pm”) and a reason tied to a real-world niche event (practice, workday, meals, commute). Do NOT use generic phrases like “daily routines”, “free time”, “scrolling”, “browsing”, “relaxing”, “downtime”, or “spare time.” Do NOT reference audience descriptors, marketing language, or multiple clauses beyond the time plus reason. Make the reason uniquely tied to the niche activity. Examples: “Post at 7am before practice starts.” “Post around 6pm after workouts finish.” “Post at noon during lunch.” Fallback: “Post at 7am before the day starts.”';
  const strategyRules = `Strategy rules:
1) Include a strategy block in every post with { angle, objective, target_saves_pct, target_comments_pct, pinned_keyword, pinned_deliverable, hook_options } and reference the specific post's title, description, pillar, type/format, or CTA when writing each field.
2) Angle and pinned_keyword must be unique across all ${days} posts and should not reuse the same phrasing.
3) Hook_options must be an array of 3 distinct hooks tied to this post's concept; avoid repeating any hook within or across posts.
4) target_saves_pct and target_comments_pct must be numeric percentages (e.g., 5 or 3.5) and describe goals relative to views.
5) Strategy wording must vary per post - do not recycle the same blocks verbatim across posts.
6) Provide padded keyword/deliverable pairs instead of a full pinned_comment. pinned_keyword should be a single uppercase word (3–16 letters) that feels niche specific and does not duplicate the post title. pinned_deliverable should describe the resource you promise (checklist, template, roadmap, etc.).
7) Hooks for each post must be three concise lead lines: business hooks mention pains/outcomes/offers with CTA to comment/DM, creator hooks feel relatable (story time, challenge, trend) with a prompt; avoid meta strategy language.
8) We will build the final pinned comment string on the server; do not return the completed sentence as a strategy field.`;
  const nicheSpecific = nicheRules ? `\nNiche-specific constraints:\n${nicheRules}` : '';
  const nicheProfileBlock = buildNicheProfileBlock(nicheStyle, brandContext);
  const nicheDecisionBlock = `NICHE STYLE DECISION (MANDATORY)\nDetermine the niche\'s commercial intent category before writing sections.\nCategories: SELLING_DIRECT (restaurant/gym/agency/coach/SaaS/local service), CREATOR_MEDIA, INFO_COMMUNITY (clubs/nonprofits).\nIf SELLING_DIRECT or CREATOR_MEDIA, light sales tactics (soft CTA, subtle urgency, lead magnet) are allowed but must stay niche-appropriate.\nIf INFO_COMMUNITY, NO sales language (no “book now”, “spots fill fast”, “limited time”, “DM to buy”).\nAlways optimize for TikTok/IG retention (clear hook, curiosity gap, fast pacing, niche comment bait, platform-native prompts).\n`;
  const globalHardRules = `GLOBAL HARD RULES (NON-NEGOTIABLE)
  - NICHE LOCK: Every line must reference the user's niche, offer, audience, and location. Do not mix niches.
  - ZERO CROSS-NICHE: Keep fitness content about workouts/nutrition; avoid skincare/real estate/crypto unless that's the niche.
  - RETENTION: Use short, punchy wording, pattern interrupts, open loops, and immediate benefit statements.
  - SALES PSYCH: Include one clear benefit, one proof cue, and a low-friction CTA without hype.
  - CONSISTENCY: Hook, caption, CTA, Story Prompt+, and pinned comment must reinforce the same angle.
  - NO PLACEHOLDERS: Avoid generic tags like [Client Name] unless provided.
  - BAN: No off-niche examples or regulated claims.`;
  const salesModeGate = `SALES-MODE GATE (HARD RULES)
Determine SALES_MODE based on the niche:
- RESTAURANT / FAST FOOD / CAFE / BAR / VENUE / LOCAL SHOP → SALES_MODE = ENGAGEMENT_ONLY
- COACH / CONSULTANT / AGENCY / COURSE / CREATOR / SERVICE → SALES_MODE = ALLOWED
- Otherwise → SALES_MODE = ENGAGEMENT_ONLY

Rules:
- SALES_MODE = ENGAGEMENT_ONLY:
  - No sales or funnel language.
  - No “I’ll send you my guide/plan/breakdown”.
  - No urgency/scarcity (“book now”, “spots fill fast”, “limited time”).
  - CTAs must be engagement-only: comment, vote, try, share, tag.
- SALES_MODE = ALLOWED:
  - One soft sales CTA is allowed.
  - Keep language natural and niche-appropriate.

Algorithm mechanics (hooks, retention, interactions) remain allowed regardless of SALES_MODE.
Apply these rules consistently across: Pinned comment, CTA, Story Prompt+, Engagement Loop.`;
  const localRules = `LOCAL CONTEXT RULES (HARD):
  - Reference location ONLY if the user provided it.
  - Mention location no more than once per card, and keep it incidental and human.
  - Use location to add relatability or specificity, never urgency.
  - Avoid salesy lines like “serving”, “book now in”, or “spots filling fast in” + {LOCATION}.
  - ALLOWED: “Around {LOCATION}, this is a common issue…”, “I see this a lot with people training in {LOCATION}.”, “For anyone in {LOCATION} dealing with this…”.
  - FORBIDDEN: “Best gym in {LOCATION}”, “Serving {LOCATION}”, “Spots filling fast in {LOCATION}”, “Book now in {LOCATION}”.
  - ALGO / SALES REQUIREMENTS: mention location only when it increases credibility without hurting shareability; omit it if it lowers general relevance.
  - FALLBACK (prompt-level): if location is missing/unclear, omit any location references.`;
  const claimsRules = `CLAIMS & GUARANTEES RULES (HARD):
  - Do NOT promise results, timelines, or guarantees.
  - Do NOT use medical, financial, or legal claims unless the niche explicitly allows them.
  - Frame benefits as personal experience, clarity, simplification, or relief—not outcomes.
  - Use phrasing like “this helped me”, “this clarified”, or “this made it simpler” instead of “this will get you X”.
  - Avoid absolutes such as “always”, “never”, “guaranteed”, or “proven”.

ALLOWED EMPHASIS:
  - “This helped clear things up for me.”
  - “This made the next step feel simpler.”
  - “This gave me more clarity on the pain point.”

FORBIDDEN PHRASES:
  - “Guaranteed results”, “Transform your life”, “Change lives”, “Proven to work”, “Get results fast”, “Scientifically proven” (unless the niche explicitly requires and cites a source).

ALGO / TRUST REQUIREMENTS:
  - Conservative, relatable language increases trust, watch time, and comments.
  - Favor curiosity and personal relatability over bold claims.

FALLBACK (prompt-level):
  - “This helped clear things up for me.”`;
  const nicheStrategyBlock = `GLOBAL CALENDAR STRATEGY (MUST FOLLOW)
You are generating a content calendar for a specific niche. Every field must be niche-locked. Unrelated topics are disallowed.

Step 1 — Derive a Niche Profile:

Niche: ${nicheStyle || 'Untitled'}
Audience: who this is for (1 line)
Offer Type: choose exactly one:
PRODUCT (physical/digital product sold)
SERVICE (local service business, appointment-based)
CREATOR (influencer/creator who monetizes attention)
COMMUNITY (club, group, organization)
VENUE (restaurant, cafe, bar, fast food, hospitality)
EDUCATION (coach, tutor, course, training)
Sales Mode: choose exactly one:
DIRECT_RESPONSE (aggressive CTA + conversion tactics allowed)
SOFT_SELL (light CTA, value-first, minimal pressure)
ENGAGEMENT_ONLY (NO sales tactics; only engagement + retention)
Rules for Sales Mode selection:
If Offer Type is VENUE => ENGAGEMENT_ONLY (no “book now”, no “spots fill fast”, no funnels).
If Offer Type is CREATOR/COMMUNITY => SOFT_SELL or ENGAGEMENT_ONLY depending on niche tone.
If Offer Type is SERVICE/EDUCATION => SOFT_SELL or DIRECT_RESPONSE allowed.
If Offer Type is PRODUCT => SOFT_SELL or DIRECT_RESPONSE allowed.
When in doubt: ENGAGEMENT_ONLY.

Step 2 — Apply Niche Lock:
For every section you generate, you MUST use niche-relevant nouns/verbs and avoid unrelated industries (no skincare/medspa terms unless niche is that, etc.). Rewrite until niche-locked.

Step 3 — Algorithm/Retention Rules (ALWAYS ON):
- Strong hook in first line (clear, niche-specific).
- One clear interaction mechanic (poll/quiz/slider/question) matching the niche.
- Keep instructions concise and concrete.

Step 4 — Sales Tactics Rules:
If Sales Mode=ENGAGEMENT_ONLY: no conversion tactics; CTAs must be engagement-based (comment, vote, share, tag, try it, save it).
If Sales Mode=SOFT_SELL: allow one light CTA with no urgency.
If Sales Mode=DIRECT_RESPONSE: urgency/offer framing allowed but still niche-locked.

Output requirement: decide Offer Type + Sales Mode before generating fields and follow these rules across every section.`;
  const titleRules = `TITLE RULES (HARD):
  - Output a short, punchy title (4–9 words).
  - Must create tension or curiosity, NOT describe the content plainly.
  - Must be niche-locked and clearly relevant to the card’s topic.
  - Must hint at a problem, mistake, contradiction, or unexpected insight.
  - Must NOT sound educational, corporate, or motivational.
  - Must NOT include emojis, hashtags, exclamation points, or CTA language.
  - Must NOT include numbers unless they naturally fit the niche and add clarity (no random “Top 5” lists).

ALLOWED TITLE PATTERNS:
  - “Why This Still Isn’t Working”
  - “You’re Probably Doing This Wrong”
  - “The Part Nobody Explains”
  - “This Should’ve Been Simpler”
  - “What Most People Miss About [NICHE TOPIC]”

FORBIDDEN TITLE TYPES:
  - Generic educational titles (“Nutrition Tips for Fitness”)
  - Promotional titles (“Client Transformation Story”)
  - Outcome promises (“Get Fit Fast”, “Guaranteed Results”)
  - Broad motivational phrases (“Fuel Your Body Right”, “Start Your Journey”)

ALGO / SALES REQUIREMENTS:
  - Title should feel like the first line of a Reel/TikTok, not a blog post.
  - It should make the viewer feel personally called out or curious enough to stop scrolling.

FALLBACK (prompt-level):
If unsure, output:
  “The Part Nobody Talks About”
  (Adapt wording slightly using niche-specific terms if possible.)`;
  const categoryRules = `CATEGORY RULES (HARD):
- Output EXACTLY one category from the existing allowed set already used by the app (do NOT invent new categories).
- Category must reflect the primary intent of the card, not the surface topic.
- Category must align with short-form algorithm behavior and sales psychology.

INTENT MAPPING (informative only):
- Relatable pain/mistake/confusion → Lifestyle.
- Explaining a concept after calling out tension → Educational.
- Showing proof/result without hype → Testimonial (or equivalent label).
- Driving action/booking with a soft CTA → Promotional (only when genuinely offer-focused).

FORBIDDEN CATEGORY USE:
- Do NOT default everything to Educational.
- Do NOT use Promotional unless the card centers on an offer.
- Do NOT mismatch (e.g., calling a confessional pain post “Educational”).

ALGO / SALES REQUIREMENTS:
- Category should set expectation without killing curiosity.
- Prefer categories that keep content feeling native and non-ad-like.

FALLBACK (prompt-level):
If unsure, choose Lifestyle over Educational to preserve relatability and engagement.`;
  return `You are a content strategist.${brandBlock}${nicheDecisionBlock}${presetBlock}${nicheProfileBlock}${globalHardRules}${salesModeGate}${titleRules}${categoryRules}${localRules}${claimsRules}${qualityRules}${audioRules}${distributionPlanRules}${strategyRules}${postingTimeRules}${classificationRules}
Hard rule: only include ideas and terminology that are clearly specific to the provided niche; never mention unrelated niches.${nicheSpecific}${promoGuardrail}\n\nCreate a calendar for \"${nicheStyle}\". Return a JSON array of ${days} objects for days ${startDay}..${startDay + days - 1}.\nALL FIELDS BELOW ARE REQUIRED for every object (never omit any):\n- day (number)\n- idea (string)\n- type (educational|promotional|lifestyle|interactive)\n- hook (single punchy hook line)\n- caption (final ready-to-post caption; no variants)\n- hashtags (array of 6–8 strings; one canonical set)\n- format (must be exactly \"Reel\")\n- cta (urgent, time-bound)\n- pillar (Education|Social Proof|Promotion|Lifestyle)\n- storyPrompt (<= 120 chars)\n- designNotes (<= 120 chars; specific)\n- repurpose (array of 2–3 short strings)\n- analytics (array of 2–3 short metric names, e.g., [\"Reach\",\"Saves\"])\n- engagementScripts { commentReply, dmReply } (each <= 140 chars; friendly, natural)\n- promoSlot (boolean)\n- weeklyPromo (string; include only if promoSlot is true; otherwise set to \"\")\n- script { hook, body, cta } (REQUIRED for ALL posts; hook 5–8 words; body 2–3 short beats; cta urgent)\n- instagram_caption (final, trimmed block)
- tiktok_caption (final, trimmed block)
- linkedin_caption (final, trimmed block)
- postingTimeTip (single sentence describing an audience + scroll window)
- audio (string: EXACTLY one line in this format — "TikTok: <Sound Title> — <Creator>; Instagram: <Sound Title> — <Creator>")\n  - Must reference LAST-7-DAYS trending sounds; TikTok and Instagram must differ unless trending on both.
- strategy { angle, objective, target_saves_pct, target_comments_pct, pinned_keyword, pinned_deliverable, hook_options }

Rules:
- If unsure, invent concise, plausible content rather than omitting fields.
- Always include every field above (use empty string only if absolutely necessary).
- Strategy values must reference the post's unique title/description/pillar/type/CTA and vary across posts.
- Return ONLY a valid JSON array of ${days} objects. No markdown, no comments, no trailing commas.`;
}
function sanitizePostForPrompt(post = {}) {
  const fields = ['idea','title','type','hook','caption','format','pillar','storyPrompt','designNotes','repurpose','hashtags','cta','script','instagram_caption','tiktok_caption','linkedin_caption','audio'];
  const sanitized = {};
  const clone = { ...post };
  if (!clone.script && clone.videoScript) clone.script = clone.videoScript;
  fields.forEach((field) => {
    if (clone[field] != null) sanitized[field] = clone[field];
  });
  sanitized.day = post.day;
  return sanitized;
}

function buildSingleDayPrompt(nicheStyle, day, post, brandContext) {
  const preset = getPresetGuidelines(nicheStyle);
  const presetGuidelines = (() => {
    if (!preset) return '';
    if (Array.isArray(preset.presetGuidelines)) return preset.presetGuidelines.join('\n');
    return preset.presetGuidelines || '';
  })();
  const presetBlock = presetGuidelines
    ? `\n\nPreset Guidelines for this niche:\n${presetGuidelines}\n\n`
    : '\n';
  const nicheRules = Array.isArray(preset?.nicheRules) && preset.nicheRules.length
    ? preset.nicheRules.join('\n')
    : '';
  const brandBlock = brandContext
    ? `\n\nBrand Context: ${brandContext}\n\n`
    : '\n';
  const qualityRules = `Quality Rules — Make each post plug-and-play and conversion-ready:
1) Hook: output ONE sentence (6–12 words, sentence case) that delivers a niche-specific cold open. Start with a pattern interrupt (curiosity, contrarian, “stop doing X”, “most people get X wrong”, “here’s why your X isn’t working”) plus an immediate payoff tied to the provided niche/topic. No hashtags, emojis, platform names, or vague phrases (“Meet our amazing client”, “Incredible transformation alert”, “Game changer”, “Level up”, “You won’t believe”). Never mention unrelated niches—if you aren’t 100% sure a term belongs to the niche/category/brand, omit it. Use vocabulary rooted in equipment, goals, routines, pain points, or inside jokes from <NICHE>. Think of it as the TikTok/Reels cold open line. Examples (niche-conditional):
   - “Stop doing cardio like this—do this instead” (Fitness)
   - “Your squat form is stealing your progress” (Fitness)
   - “Your offer isn’t bad—your hook is” (Business)
   - “The ad mistake killing your ROAS” (Business/Marketing)
   - “This campaign won’t convert until you fix your hook” (Marketing)
   - “Creators copying trends sound the same—here’s why that kills your voice” (Creator)
2) Hashtags: mix broad + niche/local; 6–8 total to balance reach and targeting.
3) CTA: turn the ending into a reluctant aside—exactly one sentence that stays niche-relevant, avoids urgency/hype, and never uses “Buy”, “Join now”, “Sign up”, “Limited time”, “Don’t miss”, or “Click the link”. Frame it as a quiet suggestion or “I didn’t expect this to work” story, imply benefit without promising outcomes, and feel like a personal aside, not a marketing line. Example patterns:
   - “If this feels familiar, this might help.”
   - “I didn’t expect this to work, but it did.”
   - “This helped more than I thought it would.”
   - “If you’re stuck here too, you’ll want this.”
   Forbidden: “Join our community today!”, “Start your journey now!”, “Get results fast!”, “Buy now”.
4) Design notes: output 1–3 concise bullet points that reinforce the same archetype and emotional tone as the Hook/Caption/Reel Script, focusing on niche-specific elements (equipment, settings, attire, environments). Choose from allowed focuses such as a confessional close-up, over-specific pain captions, pattern-interrupt frames, or quiet-win restraint. Avoid introducing new topics, hiring language about platforms or growth, or generic advice (“Eye-catching”, “High-quality”, “Professional”, “On-brand”, “Aesthetic” unless the niche is beauty/design). Design should make the emotion readable in the first second.
5) Repurpose: 2–3 concrete transformations (Reel remix ideas).
6) Engagement Loop: provide exactly two conversational replies (comment + DM) that stay aligned with the niche/emotional thread. The comment reply should feel like a genuine reaction, ask one open-ended follow-up question (e.g., “That’s real. What part was hardest for you?”), and avoid links, urgency, selling, or unrelated niches. The DM reply should acknowledge the person, invite them to share more about their situation (e.g., “Glad this resonated. What are you working through right now?”), stay curious/empathic, and avoid new topics or offers. Forbidden phrases: “Buy”, “Join”, “Check out”, “Link in bio”, “Limited”, “Offer”. The goal is to keep the conversation going, not to convert.
7) Reel Script: output exactly three labeled lines (Hook:, Body:, CTA:) totaling 15–30 spoken seconds. Stick to tension → relatability → quiet relief, remaining niche-specific and emotionally tied to the Hook/Caption. Hook must sound like an internal thought with a pattern interrupt and no hype or announcements. Body must admit what didn’t work, then mention what helped as a side effect (no hero narratives). CTA must be a reluctant admission or shared secret (no “join”, “buy”, “start”, “don’t miss”, “act now”), and avoid offers or unrelated niches. Forbidden phrases: “You can do it”, “Incredible results”, “Best program”, “Game changer”, “Join our community”. Write this as if talking to one person who feels called out, not an audience.
8) Format: ALWAYS set format to "Reel" (video-first); never Story/Carousel/Static.
        9) CAPTION BODY RULES (HARD): output 2-4 short lines (line breaks allowed). Must continue the same emotional thread as the Hook. Line 1: call out a relatable pain or mistake. Line 2: mention what most people try that doesn’t work. Line 3 (optional): offer quiet relief or realization. Stay niche-locked with vocabulary tied to the niche. No hashtags, emojis, platform mentions, or salesy slogans. No guarantees, authority claims, or phrases like "level up." Write conversationally, like a note someone saves. Optimize for read-through with short, curiosity-driven lines. Forbidden phrases: "Incredible transformation", "Game changer", "Level up", "You can do it", "Best results", "Experts say", "Join us". If unsure, output a safe niche-aligned confessional: "I tried fixing this the obvious way. It didn’t work. Turns out I was focused on the wrong part."
10) Keep outputs concise to avoid truncation.
11) CRITICAL: every post MUST include script { hook, body, cta }.`;
  const nicheSpecific = nicheRules ? `\nNiche-specific constraints:\n${nicheRules}` : '';
  const schema = `Return ONLY a JSON array containing exactly 1 object for day ${day}. It must include ALL fields in the master schema (day, idea, type, hook, caption, hashtags, format MUST be "Reel", cta, pillar, storyPrompt, designNotes, repurpose, analytics, engagementScripts, promoSlot, weeklyPromo, script, instagram_caption, tiktok_caption, linkedin_caption, audio).`;
  const snapshot = JSON.stringify(sanitizePostForPrompt(post), null, 2);
  return `You are a content strategist.${brandBlock}${presetBlock}${qualityRules}${nicheSpecific}

Niche/Style: ${nicheStyle}
Day to regenerate: ${day}

Current post (reference only — do NOT reuse text):
${snapshot}

Rewrite this day from scratch with a fresh angle while respecting every schema field. ${schema}`;
}


function parseStrategyPercent(value) {
  if (value === null || value === undefined) return NaN;
  if (Number.isFinite(value)) return value;
  const numeric = parseFloat(String(value).replace(/[^\d.-]+/g, ''));
  return Number.isFinite(numeric) ? numeric : NaN;
}

function clampStrategyPercent(value) {
  if (!Number.isFinite(value)) return null;
  const bounded = Math.max(1, Math.min(25, value));
  return Math.round(bounded * 10) / 10;
}

function normalizeStrategyForPost(post = {}) {
  const raw = post.strategy && typeof post.strategy === 'object' ? post.strategy : {};
  const angleText = String(raw.angle || '').trim();
  const objectiveText = String(raw.objective || '').trim();
  const hooks = Array.isArray(raw.hook_options) ? raw.hook_options : [];
  const dedupedHooks = [];
  hooks.forEach((item) => {
    const sanitized = String(item || '').trim();
    if (sanitized && !dedupedHooks.includes(sanitized)) {
      dedupedHooks.push(sanitized);
    }
  });
  const savesPct = clampStrategyPercent(parseStrategyPercent(raw.target_saves_pct ?? raw.target_saves ?? raw.targetSaves));
  const commentsPct = clampStrategyPercent(parseStrategyPercent(raw.target_comments_pct ?? raw.target_comments ?? raw.targetComments));
  const pinnedKeywordRaw = String(raw.pinned_keyword || raw.pinnedKeyword || raw.keyword || '').trim();
  const pinnedDeliverableRaw = String(raw.pinned_deliverable || raw.pinnedDeliverable || '').trim();
  const pinnedCommentRaw = String(raw.pinned_comment || raw.pinnedComment || '').trim();
  const parsedFromComment = pinnedCommentRaw ? parsePinnedCommentString(pinnedCommentRaw) : null;
  const keyword = pinnedKeywordRaw || (parsedFromComment?.keyword || '');
  const deliverable = pinnedDeliverableRaw || (parsedFromComment?.deliverable || '');
  const builtComment = buildPinnedCommentLine(keyword, deliverable);
  const commentLine = sanitizePinnedCommentText(builtComment || pinnedCommentRaw, post.nicheStyle || post.niche);
  return {
    angle: angleText,
    objective: objectiveText,
    pinned_keyword: keyword,
    pinned_deliverable: deliverable,
    pinned_comment: commentLine,
    target_saves_pct: Number.isFinite(savesPct) ? savesPct : null,
    target_comments_pct: Number.isFinite(commentsPct) ? commentsPct : null,
    hook_options: dedupedHooks,
  };
}

const BANNED_TERMS = ['angle', 'objective', 'major objection', 'insight'];
const PINNED_COMMENT_REGEX = /^Comment\s+([A-Za-z0-9]+)\s+and I(?:'|’|`)?ll send you\s+(.+)\.$/i;
const KEYWORD_STOPWORDS = new Set(['THE','A','AN','AND','OR','TO','OF','IN','ON','FOR','WITH','MY','YOUR','THIS','THAT']);
const POSTING_TIME_BANNED_AUDIENCE_TERMS = [
  'exec', 'executive', 'executives', 'founder', 'founders', 'ceo', 'ceos', 'enterprise', 'board', 'investor', 'investors'
];
const POSTING_TIME_WINDOW_OPTIONS = [
  'weekday mornings around 7am before practice or meetings begin',
  'midweek lunch breaks around noon when phones pop up',
  'weekday evenings around 7pm when people unwind and scroll',
  'Saturday afternoons around 3pm during relaxed scrolling',
  'Sunday evenings around 8pm when folks plan their week'
];
const POSTING_TIME_AUDIENCE_PATTERNS = [
  { match: /basketball|athlete|sport|coach/, creator: 'local athletes and their parents', business: 'club directors and athletic directors' },
  { match: /fitness|nutrition|wellness|gym|meal|trainer/, creator: 'wellness seekers and gym goers', business: 'studio owners and operations leads' },
  { match: /beauty|skincare|esthetic|spa|salon/, creator: 'skincare fans and self-care seekers', business: 'boutique owners and studio managers' },
  { match: /business|coach|consult|agency|strategy|growth|marketing|sales/, creator: 'ambitious creators and community builders', business: 'founders and growth leaders' },
  { match: /creator|influencer|lifestyle|content|story/, creator: 'your creative audience and community', business: 'marketing leaders and brand storytellers' },
];
const POSTING_TIME_TIME_PATTERN = /\b((1[0-2]|[1-9])(:[0-5][0-9])?\s?(AM|PM))\b/i;
const POSTING_TIME_24H_PATTERN = /\b([01]?\d|2[0-3]):[0-5]\d\b/;
const POSTING_TIME_DAY_PATTERN = /\b(mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?)\b/i;
const NICHE_KEYWORD_FALLBACKS = [
  { match: /fitness|gym|workout|trainer|training/, keyword: 'TRAIN' },
  { match: /nutrition|diet|meal|recipe|food/, keyword: 'MEAL' },
  { match: /beauty|skincare|spa|esthetic|derm/, keyword: 'GLOW' },
  { match: /real\s*estate|realtor|homes|property/, keyword: 'HOME' },
  { match: /marketing|ads|agency|growth/, keyword: 'LEADS' },
  { match: /finance|invest|crypto|money/, keyword: 'WEALTH' },
];

function sanitizeKeywordForComment(keyword = '', nicheStyle = '') {
  const lettersOnly = String(keyword || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10);
  if (lettersOnly.length >= 4) {
    return lettersOnly;
  }
  return deriveNicheFallbackKeyword(nicheStyle) || 'ACCESS';
}

function buildPinnedCommentLine(keyword = '', deliverable = '', nicheStyle = '', salesMode = 'DIRECT_RESPONSE') {
  const safeKeyword = sanitizeKeywordForComment(keyword, nicheStyle);
  if (!safeKeyword || !deliverable) return '';
  const action = salesMode === 'NON_DIRECT_RESPONSE' ? 'reply with' : 'send you';
  return `Comment "${safeKeyword}" and I'll ${action} ${deliverable}.`;
}

function parsePinnedCommentString(text = '') {
  const match = String(text || '').match(PINNED_COMMENT_REGEX);
  if (!match) return null;
  return {
    keyword: match[1].toUpperCase(),
    deliverable: match[2].trim(),
  };
}

function normalizeKeywordToken(value = '') {
  return String(value || '').trim().toUpperCase();
}

function deriveNicheFallbackKeyword(nicheStyle = '') {
  const normalized = String(nicheStyle || '').toLowerCase();
  for (const entry of NICHE_KEYWORD_FALLBACKS) {
    if (entry.match.test(normalized)) {
      return entry.keyword;
    }
  }
  return '';
}

function getPostTitleWordSet(post = {}) {
  const raw = String(post.title || post.idea || '').trim().toUpperCase();
  if (!raw) return new Set();
  return new Set(raw.split(/[^A-Z0-9]+/).filter(Boolean));
}

function isKeywordValid(keyword = '', post = {}) {
  const normalized = normalizeKeywordToken(keyword);
  if (!/^[A-Z]{3,16}$/.test(normalized)) return false;
  if (KEYWORD_STOPWORDS.has(normalized)) return false;
  const title = String(post.title || '').trim().toUpperCase();
  if (title && normalized === title) return false;
  const titleWords = getPostTitleWordSet(post);
  if (titleWords.has(normalized)) return false;
  return true;
}

function isDeliverableValid(deliverable = '', post = {}) {
  const text = String(deliverable || '').trim();
  if (!text) return false;
  const title = String(post.title || '').trim().toLowerCase();
  if (title && text.toLowerCase().includes(title)) return false;
  return true;
}

function getPostTitleText(post = {}) {
  const raw = String(post.title || post.idea || '').trim();
  return raw.toLowerCase();
}

function isHookLineValid(hook = '', post = {}) {
  const cleaned = String(hook || '').trim();
  if (!cleaned) return false;
  if (!isSingleSentence(cleaned)) return false;
  if (containsBannedTerms(cleaned)) return false;
  if (cleaned.toLowerCase().includes(getPostTitleText(post))) return false;
  return true;
}

function containsBannedTerms(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return BANNED_TERMS.some((term) => lower.includes(term));
}

function isSingleSentence(text) {
  if (!text) return true;
  const sentences = text.split(/[.?!]+/).filter(Boolean);
  return sentences.length <= 1;
}

function isStrategyCopyBad(strategy = {}, post = {}) {
  if (!strategy) return true;
  if (!isKeywordValid(strategy.pinned_keyword, post)) return true;
  if (!isDeliverableValid(strategy.pinned_deliverable, post)) return true;
  const hooks = Array.isArray(strategy.hook_options) ? strategy.hook_options : [];
  if (hooks.length < 3) return true;
  const seenHooks = new Set();
  for (const hook of hooks.slice(0, 3)) {
    if (!isHookLineValid(hook, post)) return true;
    seenHooks.add(String(hook || '').trim().toLowerCase());
  }
  if (seenHooks.size < 3) return true;
  return false;
}

function containsBannedPostingAudience(text = '') {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  return POSTING_TIME_BANNED_AUDIENCE_TERMS.some((term) => lower.includes(term));
}

function isPostingTimeTipValid(tip = '', classification = 'creator') {
  const cleaned = String(tip || '').trim();
  if (!cleaned) return false;
  if (classification !== 'business' && containsBannedPostingAudience(cleaned)) return false;
  if (POSTING_TIME_DAY_PATTERN.test(cleaned)) return false;
  if (!POSTING_TIME_TIME_PATTERN.test(cleaned) && !POSTING_TIME_24H_PATTERN.test(cleaned)) return false;
  return true;
}

function derivePostingAudience(post = {}, classification = 'creator', nicheStyle = '') {
  const text = [nicheStyle, post.idea, post.title, post.pillar, post.caption].filter(Boolean).join(' ').toLowerCase();
  for (const entry of POSTING_TIME_AUDIENCE_PATTERNS) {
    if (entry.match.test(text)) return entry[classification] || entry.creator;
  }
  return classification === 'business'
    ? 'founders and growth leaders'
    : 'your niche community of curious fans';
}

function derivePostingTimeWindow(post = {}) {
  if (!POSTING_TIME_WINDOW_OPTIONS.length) return 'during peak scrolling hours';
  const idx = Number(post.day || 0) % POSTING_TIME_WINDOW_OPTIONS.length;
  return POSTING_TIME_WINDOW_OPTIONS[idx] || POSTING_TIME_WINDOW_OPTIONS[0];
}

function derivePostingTimeTipFallback(post = {}, classification = 'creator', nicheStyle = '') {
  const audience = derivePostingAudience(post, classification, nicheStyle);
  const window = derivePostingTimeWindow(post);
  const nicheHint = nicheStyle ? ` around your ${nicheStyle} content` : '';
  return `Post ${window} when ${audience} are scrolling${nicheHint}.`.replace(/\s+/g, ' ').trim();
}

async function regeneratePostingTimeTip(post, classification, nicheStyle, brandContext, bannedTerms = []) {
  const summary = [post.idea, post.caption, post.pillar, post.cta].filter(Boolean).join(' | ') || 'Fresh concept';
  const brandLine = brandContext ? `Brand context: ${brandContext}` : '';
  const bannedLine = bannedTerms.length
    ? `Avoid these audience keywords: ${bannedTerms.join(', ')}.`
    : '';
  const prompt = `You are a content strategist for ${classification} content. ${brandLine}
Niche/Style: ${nicheStyle || 'General'}
Post summary: ${summary}
${bannedLine}
Return ONLY one sentence for posting_time_tip. Mention the niche audience, include a specific clock time (e.g., 3:15 PM), explain why that window works, and do NOT mention days of the week or generic phrases like "morning" without a clock time.`;
  try {
    const raw = await callChatCompletion(prompt, { temperature: 0.5, maxTokens: 250 });
    const lines = (raw || '').split(/\\n+/).map((line) => line.trim()).filter(Boolean);
    return lines[0] || '';
  } catch (err) {
    return '';
  }
}

async function ensurePostingTimeTips(posts = [], classification, nicheStyle, brandContext) {
  if (!Array.isArray(posts)) return posts;
  const bannedTerms = classification === 'business' ? [] : POSTING_TIME_BANNED_AUDIENCE_TERMS;
  for (const post of posts) {
    let tip = String(post.postingTimeTip || '').trim();
    tip = truncatePostingTimeTip(tip);
    if (!isPostingTimeTipValid(tip, classification)) {
      const regenerated = await regeneratePostingTimeTip(post, classification, nicheStyle, brandContext, bannedTerms);
      const cleaned = truncatePostingTimeTip(regenerated);
      if (isPostingTimeTipValid(cleaned, classification)) {
        tip = cleaned;
      }
    }
    if (!tip) {
      tip = derivePostingTimeTipFallback(post, classification, nicheStyle);
    }
  if (!isPostingTimeTipValid(tip, classification)) {
    tip = derivePostingTimeTipFallback(post, classification, nicheStyle);
  }
    tip = ensureNichePostingTimeReason(tip, nicheStyle);
    post.postingTimeTip = tip;
  }
  return posts;
}

function truncatePostingTimeTip(tip = '') {
  const text = String(tip || '').trim();
  if (!text) return text;
  const lower = text.toLowerCase();
  let end = text.length;
  for (const marker of [' during ', ' when ', ' while ']) {
    const idx = lower.indexOf(marker);
    if (idx !== -1 && idx < end) {
      end = idx;
    }
  }
  return text.slice(0, end).trim();
}

function sanitizePostingTimeTipText(tip = '') {
  const text = String(tip || '').trim();
  if (!text) return text;
  const lower = text.toLowerCase();
  let end = text.length;
  for (const marker of [' during ', ' when ']) {
    const idx = lower.indexOf(marker);
    if (idx !== -1 && idx < end) {
      end = idx;
    }
  }
  const snippet = text.slice(0, end).trim();
  return snippet.replace(/[.,;:]+$/g, '').trim();
}

const POSTING_TIME_REASON_WARNED = new Set();

function ensureNichePostingTimeReason(tip = '', nicheStyle = '') {
  const text = String(tip || '').trim();
  if (!text) return text;
  const match = text.match(/^(Post\s+at\s+\S+)\s+(.+)$/i);
  if (!match) return text;
  const timePart = match[1];
  const reason = match[2].toLowerCase();
  const genericTerms = /daily routine|daily routines|free time|scrolling|browsing|relaxing|downtime|spare time/;
  const tokens = (String(nicheStyle || '').toLowerCase().match(/[a-z]+/g) || []);
  const hasAnchor = tokens.some((token) => token.length > 3 && reason.includes(token));
  if (!genericTerms.test(reason) && hasAnchor) return text;
  const fallback = derivePostingTimeReasonFallback(nicheStyle);
  if (!POSTING_TIME_REASON_WARNED.has(text)) {
    console.warn('[Calendar] posting time tip reason sanitized', { original: text, fallback, nicheStyle });
    POSTING_TIME_REASON_WARNED.add(text);
  }
  return `${timePart} ${fallback}`;
}

function derivePostingTimeReasonFallback(nicheStyle = '') {
  const normalized = (nicheStyle || '').toLowerCase();
  if (/basketball|soccer|coaching|youth/.test(normalized)) return 'after school ends';
  if (/gym|fitness|training/.test(normalized)) return 'before or after workouts';
  if (/nutrition|diet|meal/.test(normalized)) return 'before dinner decisions';
  if (/real\s*estate|realtor/.test(normalized)) return 'after work hours';
  if (/marketing|business|agency/.test(normalized)) return 'before the workday fills up';
  return 'during a natural break in their day';
}

function ensureUniqueStrategyValues(posts = []) {
  if (!Array.isArray(posts)) return posts;
  const pinnedCounts = new Map();
  const angleCounts = new Map();
  posts.forEach((post) => {
    const strategy = post.strategy || {};
    const pinned = (strategy.pinned_comment || '').trim();
    if (pinned) {
      const seen = pinnedCounts.get(pinned) || 0;
      if (seen > 0) {
        strategy.pinned_comment = `${pinned} (Day ${post.day || '??'})`;
      }
      pinnedCounts.set(strategy.pinned_comment || pinned, (pinnedCounts.get(strategy.pinned_comment || pinned) || 0) + 1);
    }
    const angle = (strategy.angle || '').trim();
    if (angle) {
      const seenAngle = angleCounts.get(angle) || 0;
      if (seenAngle > 0) {
        const uniqueAngle = `${angle} (Day ${post.day || '??'})`;
        strategy.angle = uniqueAngle;
        angleCounts.set(uniqueAngle, (angleCounts.get(uniqueAngle) || 0) + 1);
      } else {
        angleCounts.set(angle, 1);
      }
    }
    post.strategy = strategy;
  });
  return posts;
}

function logDuplicateStrategyValues(posts = []) {
  if (process.env.NODE_ENV === 'production') return;
  const angleCounts = new Map();
  const pinnedCounts = new Map();
  for (const post of posts) {
    const strategy = post.strategy || {};
    const angle = (strategy.angle || '').trim();
    if (angle) angleCounts.set(angle, (angleCounts.get(angle) || 0) + 1);
    const pinned = (strategy.pinned_comment || '').trim();
    if (pinned) pinnedCounts.set(pinned, (pinnedCounts.get(pinned) || 0) + 1);
  }
  const angleDuplicates = [...angleCounts.values()].filter((count) => count > 1).length;
  const pinnedDuplicates = [...pinnedCounts.values()].filter((count) => count > 1).length;
  if (angleDuplicates > 0 || pinnedDuplicates > 0) {
    console.warn('[Calendar DEV] Duplicate strategy values', { angleDuplicates, pinnedDuplicates });
  }
}


function deriveFallbackDeliverable(post = {}, classification = 'creator') {
  const text = [post.type, post.pillar, post.idea, post.caption, post.storyPrompt]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const patterns = [
    { match: /drill|practice|routine|skill/, deliverable: 'my drill list' },
    { match: /nutrition|meal|diet|food|recipe/, deliverable: 'my meal plan' },
    { match: /story|social proof|testimonial|case study|proof/, deliverable: 'my case study breakdown' },
    { match: /promo|launch|offer|discount|deal|sale|special/, deliverable: 'my offer details' },
    { match: /audit|review|assessment|checklist|scorecard/, deliverable: 'my audit checklist' },
    { match: /template|framework|system|swipe|script|copy/, deliverable: 'my template pack' },
    { match: /roadmap|plan|strategy|blueprint/, deliverable: 'my roadmap' },
    { match: /calculator|estimate|roi|score/, deliverable: 'my calculator' },
  ];
  for (const entry of patterns) {
    if (entry.match.test(text)) return entry.deliverable;
  }
  return classification === 'business' ? 'my blueprint' : 'my creative guide';
}

const NICHE_KEYWORD_BANK = {
  fitness: ['TRAIN','GRIND','LIFT','FIGHT','STRONG'],
  basketball: ['HOOPS','DRILLS','SHOOT','DEFENSE','HANDLES'],
  'real estate': ['LISTING','HOME','DEAL'],
  beauty: ['GLOW','SKIN','LOOK'],
  cooking: ['RECIPE','EAT','COOK'],
  restaurant: ['BURGER','FRIES','MENU','SAUCE','DEAL','ORDER'],
  business: ['GROW','SCALE','LEAD'],
  marketing: ['LEADS','SALES','LAUNCH'],
  creator: ['CREATE','IMPACT','INSPIRE'],
};
const DIRECT_RESPONSE_KEYWORDS = ['coach','consult','agency','course','training','consultant','creator','fitness','real estate','broker'];
const NON_DIRECT_RESPONSE_KEYWORDS = ['restaurant','fast-food','cafe','local','diner','bar','retail','bakery','food'];
const NON_DIRECT_DELIVERABLES = {
  restaurant: 'reply with the best item to try first',
  cafe: 'reply with my top pick',
  food: 'reply with my favorite tasting note',
  default: 'reply with my top pick',
};
const SANITIZED_KEYWORD_WARNED = new Set();
const FALLBACK_KEYWORD_MAP = [
  { match: /basketball|athlete|sport|drills/, keywords: ['DRILLS', 'ATHLETE'] },
  { match: /fitness|nutrition|wellness|meal|recipe|gym/, keywords: ['MEAL'] },
  { match: /business|coach|consult|consulting|agency|strategy/, keywords: ['CLIENTS', 'SYSTEM'] },
  { match: /creator|influencer|lifestyle|content|story/, keywords: ['ROUTINE', 'VIBES'] },
];

function sanitizeLettersOnly(value = '', minLen = 4, maxLen = 10) {
  const letters = (String(value || '').toUpperCase().match(/[A-Z]+/g) || []).join('');
  if (!letters) return '';
  const truncated = letters.slice(0, maxLen);
  if (truncated.length < minLen) return '';
  return truncated;
}

function buildNicheProfileBlock(nicheStyle = '', brandContext = '') {
  const niche = String(nicheStyle || 'General').trim() || 'General';
  const audience = brandContext ? `Audience: ${brandContext.split('\n')[0]}` : 'Audience: General';
  const offer = 'Offer: N/A';
  return `\n=== NICHE PROFILE (SOURCE OF TRUTH) ===\nNiche: ${niche}\n${audience}\n${offer}\nHard rules:\n- Every line MUST be directly relevant to the niche above.\n- NEVER include concepts from unrelated niches.\n- If uncertain, stay generic within the niche.\n- Avoid beauty/med-spa language unless the niche is beauty/med-spa.\n- Avoid discount-code vibes unless the niche explicitly uses it.\n=== END NICHE PROFILE ===\n`;
}

function deriveNicheKeyword(nicheStyle = '') {
  const normalized = String(nicheStyle || '').toLowerCase();
  for (const [key, keywords] of Object.entries(NICHE_KEYWORD_BANK)) {
    if (normalized.includes(key)) {
      return keywords[0];
    }
  }
  const sanitized = sanitizeLettersOnly(nicheStyle, 4, 10);
  return sanitized || 'TIPS';
}

function deriveSalesMode(post = {}, classification = 'creator', nicheStyle = '') {
  const text = [post.businessType, post.industry, post.nicheCategory, classification, nicheStyle]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (DIRECT_RESPONSE_KEYWORDS.some((keyword) => text.includes(keyword))) return 'DIRECT_RESPONSE';
  if (NON_DIRECT_RESPONSE_KEYWORDS.some((keyword) => text.includes(keyword))) return 'NON_DIRECT_RESPONSE';
  return 'DIRECT_RESPONSE';
}

function deriveNonDirectDeliverable(nicheStyle = '') {
  const normalized = (nicheStyle || '').toLowerCase();
  for (const key of Object.keys(NON_DIRECT_DELIVERABLES)) {
    if (key !== 'default' && normalized.includes(key)) {
      return NON_DIRECT_DELIVERABLES[key];
    }
  }
  return NON_DIRECT_DELIVERABLES.default;
}

const STORY_PROMPT_BANNED_TERMS = {
  fitness: ['facial','peel','skincare','glow level','dermaplane','serum','moisturizer'],
  beauty: ['deadlift','bench press','macros','basketball','dribbling'],
  basketball: ['facial','peel','macros','protein shake'],
  cooking: ['facial','peel','dribbling','bench press'],
};
const STORY_PROMPT_TEMPLATES = {
  fitness: 'Share your biggest workout challenge this week. Add a poll: “Morning or evening workouts?” plus a slider: “Motivation level”.',
  generic: 'Share a quick story about your {niche} experience. Add a poll with two {niche} options and a 1–10 confidence slider.',
};
const STORY_PROMPT_KEYWORD_OVERRIDES = {
  beauty: ['beauty', 'skin', 'skincare', 'glow', 'aesthetic'],
};
const STORY_PROMPT_PLUS_FORBIDDEN = ['facial','peel','glow','botox','filler','serum','cleanser','moisturizer','acne','skincare','med spa','medspa','aesthetics','cosmetic','dermatology'];
const STORY_PROMPT_PLUS_LOGGED = new Set();
const STORY_PROMPT_DENYLIST = ['facial', 'peel', 'glow', 'skincare', 'botox', 'filler', 'med spa', 'lash', 'brow', 'aesthetic', 'dermal'];
const STORY_PROMPT_ANCHOR_STOPWORDS = new Set(['a','an','the','and','for','with','of','to','in','on','at','by','your','our','my','this','that','these','those']);

function deriveStoryPromptNicheKey(nicheStyle = '') {
  const normalized = String(nicheStyle || '').toLowerCase();
  for (const key of Object.keys(STORY_PROMPT_BANNED_TERMS)) {
    if (normalized.includes(key)) return key;
  }
  return 'generic';
}

function sanitizeNicheLabel(nicheStyle = '') {
  const plain = String(nicheStyle || '').trim();
  return plain || 'your niche';
}

function extractNicheTokens(nicheStyle = '', hashtags = []) {
  const tokens = new Set();
  const source = String(nicheStyle || '').toLowerCase();
  (source.match(/[a-z]{3,}/g) || []).forEach((token) => tokens.add(token));
  (Array.isArray(hashtags) ? hashtags : []).forEach((tag) => {
    const clean = String(tag || '').toLowerCase().replace(/^#/, '');
    (clean.match(/[a-z]{3,}/g) || []).forEach((token) => tokens.add(token));
  });
  return tokens;
}

function deriveStoryPromptAnchor(nicheStyle = '') {
  const label = String(nicheStyle || '').toLowerCase().trim();
  if (!label) return 'niche';
  const words = label.split(/[^a-z]+/).filter((word) => word && !STORY_PROMPT_ANCHOR_STOPWORDS.has(word));
  if (!words.length) return 'niche';
  return words.slice(0, 2).join(' ');
}

function deriveStoryPromptOptionPair(nicheStyle = '') {
  const lower = String(nicheStyle || '').toLowerCase();
  if (/(restaurant|food|burger|pizza|cafe|diner)/.test(lower)) return ['Classic', 'Spicy'];
  if (/(fitness|gym|training|coach)/.test(lower)) return ['Strength', 'Cardio'];
  return ['Option A', 'Option B'];
}

function buildStoryPromptPlusFallback(nicheStyle = '') {
  const anchor = deriveStoryPromptAnchor(nicheStyle);
  const optionPair = deriveStoryPromptOptionPair(nicheStyle);
  return `Share your biggest ${anchor} question today. Add a poll: "${optionPair[0]}" vs "${optionPair[1]}" plus a slider labeled "${anchor} level". Add a question box: “Ask me anything about today’s ${anchor}.”`;
}

function sanitizeStoryPromptPlus(nicheStyle = '', text = '', post = {}) {
  const trimmed = String(text || '').trim();
  const anchor = deriveStoryPromptAnchor(nicheStyle);
  const lower = trimmed.toLowerCase();
  const tokens = extractNicheTokens(nicheStyle);
  const anchorMatch = anchor ? lower.includes(anchor.toLowerCase()) : false;
  const isSkincareNiche = /(skincare|skin care|medspa|med spa|aesthetic|cosmetic|dermatology)/i.test(nicheStyle);
  const hasForbidden = STORY_PROMPT_PLUS_FORBIDDEN.concat(STORY_PROMPT_DENYLIST).some((term) => lower.includes(term));
  const needsFallback = !trimmed || (!anchorMatch && anchor !== 'niche') || (hasForbidden && !isSkincareNiche);
  if (!needsFallback) return trimmed;
  const fallback = buildStoryPromptPlusFallback(nicheStyle);
  const key = `${post.userId || 'anon'}|${nicheStyle}`;
  if (!STORY_PROMPT_PLUS_LOGGED.has(key)) {
    console.warn('[Calendar] StoryPromptPlusFallbackRegen', { userId: post.userId || null, niche: nicheStyle, original: trimmed || '[empty]' });
    STORY_PROMPT_PLUS_LOGGED.add(key);
  }
  return fallback;
}

function buildStoryPromptPlusNicheFallback(nicheStyle = '') {
  const label = deriveStoryPromptAnchor(nicheStyle);
  return `What’s your favorite ${label} choice? Add a poll with "Option A" vs "Option B" and a slider for ${label} interest level.`;
}

function validateNicheLock(card = {}, nicheStyle = '') {
  if (!card || typeof card !== 'object') return true;
  const lowerNiche = String(nicheStyle || '').toLowerCase();
  const allow = /(skin|skincare|spa|med spa|cosmetic|aesthetic|derm)/.test(lowerNiche);
  if (allow) return true;
  const fieldsToCheck = [
    card.storyPrompt,
    card.storyPromptExpanded,
    card.caption,
    card.body,
    card.pinnedComment,
    card.engagementScripts?.commentReply,
    card.engagementScripts?.dmReply,
  ];
  const combined = fieldsToCheck.filter(Boolean).join(' ').toLowerCase();
  return !STORY_PROMPT_DENYLIST.some((term) => combined.includes(term));
}

if (process.env.NODE_ENV !== 'production') {
  const dev_niche = 'fast food burger joint';
  const dev_story = sanitizeStoryPromptPlus(dev_niche, 'Facial or peel? Add a poll, glow level slider.');
  if (/facial|peel|glow/.test(dev_story.toLowerCase())) {
    console.warn('[Calendar][Dev] StoryPromptPlus sanitize failed to strip banned terms');
  }
  if (!/fast|food/.test(dev_story.toLowerCase())) {
    console.warn('[Calendar][Dev] StoryPromptPlus missing niche anchor', dev_story);
  }
}

function buildStoryPromptTemplate(nicheStyle = '') {
  const key = deriveStoryPromptNicheKey(nicheStyle);
  const template = STORY_PROMPT_TEMPLATES[key] || STORY_PROMPT_TEMPLATES.generic;
  const label = sanitizeNicheLabel(nicheStyle);
  return template.replace(/{niche}/g, label);
}

function ensureStoryPromptMatchesNiche(nicheStyle = '', storyPrompt = '', hashtags = []) {
  const trimmed = String(storyPrompt || '').trim();
  if (!trimmed) return buildStoryPromptTemplate(nicheStyle);
  const lower = trimmed.toLowerCase();
  const tokens = extractNicheTokens(nicheStyle, hashtags);
  const hasNicheToken = tokens.size && [...tokens].some((token) => lower.includes(token));
  const nicheKey = deriveStoryPromptNicheKey(nicheStyle);
  const bannedTerms = STORY_PROMPT_BANNED_TERMS[nicheKey] || [];
  const hasBanned = bannedTerms.some((term) => lower.includes(term));
  const overrideTokens = STORY_PROMPT_KEYWORD_OVERRIDES[nicheKey] || [];
  if (hasBanned && !overrideTokens.some((term) => tokens.has(term))) {
    return buildStoryPromptTemplate(nicheStyle);
  }
  if (tokens.size && !hasNicheToken) {
    return buildStoryPromptTemplate(nicheStyle);
  }
  return trimmed;
}

function deterministicKeywordFallback(post = {}, classification = 'creator', nicheStyle = '', used = new Set()) {
  const nicheKeyword = deriveNicheKeyword(nicheStyle);
  if (nicheKeyword && isKeywordValid(nicheKeyword, post) && !used.has(nicheKeyword)) {
    return nicheKeyword;
  }
  const text = [nicheStyle, post.idea, post.title, post.pillar, post.type].filter(Boolean).join(' ').toLowerCase();
  for (const entry of FALLBACK_KEYWORD_MAP) {
    if (entry.match.test(text)) {
      for (const candidate of entry.keywords) {
        if (isKeywordValid(candidate, post) && !used.has(candidate)) return candidate;
      }
      for (const candidate of entry.keywords) {
        if (isKeywordValid(candidate, post)) return candidate;
      }
    }
  }
  const fallbackPool = classification === 'business'
    ? ['CLIENTS', 'SYSTEM', 'PROOF', 'GROWTH', 'PLAN']
    : ['ROUTINE', 'VIBES', 'STORY', 'CREW', 'FLOW'];
  for (const candidate of fallbackPool) {
    if (isKeywordValid(candidate, post) && !used.has(candidate)) return candidate;
  }
  for (const candidate of fallbackPool) {
    if (isKeywordValid(candidate, post)) return candidate;
  }
  return classification === 'business' ? 'CLIENTS' : 'ROUTINE';
}

function deriveFallbackKeyword(post = {}, classification = 'creator', nicheStyle = '', deliverable = '', used = new Set()) {
  const source = [post.idea, post.title, post.caption, post.pillar, nicheStyle].filter(Boolean).join(' ');
  const tokens = (String(source || '').toUpperCase().match(/[A-Z0-9]+/g) || []).filter(Boolean);
  const filtered = tokens.filter((token) => !(token === 'MEAL' && deliverable !== 'my meal plan'));
  const candidate = filtered.find((token) => token.length >= 3 && token.length <= 10 && isKeywordValid(token, post) && !used.has(token));
  if (candidate) return candidate;
  return deterministicKeywordFallback(post, classification, nicheStyle, used);
}

function buildFallbackHooks(post, classification, keyword) {
  const base = (String(post.idea || post.title || keyword) || '').replace(/\.$/, '');
  if (classification === 'business') {
    return [
      `${keyword} is quietly costing you clients—comment "need it" to grab the fix.`,
      `Naming ${keyword} frees up the outcome we promised; DM me if you want the proof.`,
      `Fixing ${keyword} this week unlocks more bookings—comment "ready" and I'll send the play.`,
    ];
  }
  return [
    `Story time: how ${keyword} reshaped my week—does this feel like you?`,
    `Contrarian take: ${keyword} gets better when it’s messy—what’s your version of it?`,
    `Trend check: everyone is doing ${keyword}, but this twist keeps it real—what surprised you most?`,
  ];
}

function buildFallbackStrategyPieces(post, classification, nicheStyle) {
  const deliverable = deriveFallbackDeliverable(post, classification);
  const keyword = deriveFallbackKeyword(post, classification, nicheStyle, deliverable);
  const hooks = buildFallbackHooks(post, classification, keyword);
  return { keyword, deliverable, hooks };
}


function templateStrategyFromTitle(post, classification, nicheStyle) {
  const fallback = buildFallbackStrategyPieces(post, classification, nicheStyle);
  return {
    angle: post.strategy?.angle || '',
    objective: post.strategy?.objective || '',
    pinned_keyword: fallback.keyword,
    pinned_deliverable: fallback.deliverable,
    pinned_comment: buildPinnedCommentLine(fallback.keyword, fallback.deliverable),
    target_saves_pct: 5,
    target_comments_pct: 2,
    hook_options: fallback.hooks,
  };
}

async function sanitizeStrategyCopy(posts, nicheStyle, classification) {
  const results = [];
  for (const post of posts) {
    let strategy = normalizeStrategyForPost(post);
    if (isStrategyCopyBad(strategy, post)) {
      strategy = templateStrategyFromTitle(post, classification, nicheStyle);
    }
    try {
      strategy = ensurePinnedFieldsValid(strategy, post, classification, nicheStyle);
    } catch (err) {
      console.warn('[Calendar] ensurePinnedFieldsValid failure', {
        type: typeof ensurePinnedFieldsValid,
        keys: Object.keys(strategy || {}),
      });
      throw err;
    }
    post.strategy = strategy;
    results.push(post);
  }
  return results;
}


function toPlainString(value) {
  return String(value || '').trim();
}

function ensurePinnedFieldsValid(strategy = {}, post = {}, classification = 'creator', nicheStyle = '') {
  const normalizedStrategy = { ...strategy };
  const candidateKeyword = normalizeKeywordToken(normalizedStrategy.pinned_keyword || '');
  const candidateDeliverable = String(normalizedStrategy.pinned_deliverable || '').trim();
  const finalKeyword = isKeywordValid(candidateKeyword, post)
    ? candidateKeyword
    : deterministicKeywordFallback(post, classification, nicheStyle);
  const finalDeliverable = isDeliverableValid(candidateDeliverable, post)
    ? candidateDeliverable
    : deriveFallbackDeliverable(post, classification);
  const sanitizedKeyword = sanitizeKeywordForComment(finalKeyword, nicheStyle);
  if (finalKeyword !== sanitizedKeyword && !SANITIZED_KEYWORD_WARNED.has(finalKeyword)) {
    console.warn('[Calendar] sanitized pinned keyword', { original: finalKeyword, sanitized: sanitizedKeyword });
    SANITIZED_KEYWORD_WARNED.add(finalKeyword);
  }
  const salesMode = deriveSalesMode(post, classification, nicheStyle);
  const deliverableForMode = salesMode === 'NON_DIRECT_RESPONSE'
    ? deriveNonDirectDeliverable(nicheStyle)
    : finalDeliverable;
  return {
    ...normalizedStrategy,
    pinned_keyword: sanitizedKeyword,
    pinned_deliverable: deliverableForMode,
    pinned_comment: buildPinnedCommentLine(sanitizedKeyword, deliverableForMode, nicheStyle, salesMode),
  };
}

async function dedupePinnedComments(posts = [], classification = 'creator', nicheStyle = '') {
  return Array.isArray(posts) ? posts : [];
}

function ensureStringArray(value, fallback = [], minLength = 0) {
  const list = [];
  const pushValue = (input) => {
    const normalized = toPlainString(input);
    if (normalized) list.push(normalized);
  };
  if (Array.isArray(value)) {
    value.forEach(pushValue);
  } else if (typeof value === 'string') {
    value.split(/[,\n]+/).forEach(pushValue);
  }
  const fallbackList = (Array.isArray(fallback) ? fallback : [])
    .map((item) => toPlainString(item))
    .filter(Boolean);
  while (list.length < minLength && fallbackList.length) {
    list.push(fallbackList[list.length % fallbackList.length]);
  }
  if (!list.length && fallbackList.length) {
    return fallbackList.slice(0, Math.max(minLength, fallbackList.length));
  }
  return list;
}

function ensureHashtagPrefix(value = '') {
  const trimmed = toPlainString(value)
    .replace(/^[#]+/, '')
    .replace(/\s+/g, '');
  return trimmed ? `#${trimmed}` : '';
}

function ensureHashtagArray(value, fallback = [], minLength = 0) {
  const rawList = ensureStringArray(value, fallback, minLength);
  const hashtags = rawList
    .map(ensureHashtagPrefix)
    .filter(Boolean);
  const fallbackTags = (Array.isArray(fallback) ? fallback : [])
    .map(ensureHashtagPrefix)
    .filter(Boolean);
  let idx = 0;
  while (hashtags.length < minLength && fallbackTags.length) {
    hashtags.push(fallbackTags[idx % fallbackTags.length]);
    idx += 1;
  }
  return hashtags;
}

function normalizeScriptObject(source = {}) {
  const hook = toPlainString(source.hook) || 'Stop scrolling—quick tip';
  const body = toPlainString(source.body) || 'Show result • Explain 1 step • Tease benefit';
  const cta = toPlainString(source.cta) || 'DM us to grab your spot';
  return { hook, body, cta };
}

function normalizePost(post, idx = 0, startDay = 1, forcedDay, nicheStyle = '') {
  if (!post || typeof post !== 'object') {
    const err = new Error('Invalid post payload');
    err.code = 'BAD_REQUEST';
    err.statusCode = 400;
    throw err;
  }
  const fallbackDay = typeof forcedDay === 'number'
    ? Number(forcedDay)
    : (startDay ? Number(startDay) + idx : idx + 1);
  const defaultHashtags = ['marketing', 'content', 'tips', 'learn', 'growth', 'brand'];
  const hashtags = ensureHashtagArray(post.hashtags || [], defaultHashtags, 6);
  const repurpose = ensureStringArray(post.repurpose || [], ['Reel -> Remix with new hook', 'Reel -> Clip as teaser'], 2);
  const analytics = ensureStringArray(post.analytics || [], ['Reach', 'Saves'], 2);
  const script = normalizeScriptObject(post.script || post.videoScript || {});
  const videoScript = { ...script };
  const engagementComment = toPlainString(post.engagementScripts?.commentReply || post.engagementScript || '') || 'Thanks! Want our quick guide?';
  const engagementDm = toPlainString(post.engagementScripts?.dmReply || '') || 'Starts at $99. Want me to book you this week?';
  const rawStoryPrompt = toPlainString(post.storyPrompt || "Share behind-the-scenes of today's work.");
  const storyPrompt = ensureStoryPromptMatchesNiche(nicheStyle, rawStoryPrompt, hashtags);
  const normalized = {
    day: typeof post.day === 'number' ? post.day : fallbackDay,
    idea: toPlainString(post.idea || post.title || 'Engaging post idea'),
    title: toPlainString(post.title || post.idea || ''),
    type: toPlainString(post.type || 'educational'),
    hook: toPlainString(post.hook || script.hook || 'Stop scrolling quick tip'),
    caption: toPlainString(post.caption || 'Quick tip that helps you today. Save this for later.'),
    hashtags,
    format: 'Reel',
    formatIntent: toPlainString(post.formatIntent || ''),
    cta: toPlainString(post.cta || 'DM us to book today'),
    pillar: toPlainString(post.pillar || 'Education'),
    storyPrompt,
    designNotes: toPlainString(post.designNotes || 'Clean layout, bold headline, brand colors.'),
    repurpose,
    analytics,
    engagementScripts: { commentReply: engagementComment, dmReply: engagementDm },
    promoSlot: typeof post.promoSlot === 'boolean' ? post.promoSlot : !!post.weeklyPromo,
    weeklyPromo: typeof post.weeklyPromo === 'string' ? post.weeklyPromo : '',
    postingTimeTip: sanitizePostingTimeTipText(toPlainString(post.postingTimeTip || '')),
    script,
    videoScript,
    instagram_caption: toPlainString(post.instagram_caption || post.caption || ''),
    tiktok_caption: toPlainString(post.tiktok_caption || post.caption || ''),
    linkedin_caption: toPlainString(post.linkedin_caption || post.caption || ''),
    audio: toPlainString(post.audio || ''),
    strategy: post.strategy || {},
  };
  if (!normalized.promoSlot) normalized.weeklyPromo = '';
  return normalized;
}

const PRO_INTERACTIVE_PROMPTS = [
  'Add a poll asking “Facial or peel?” plus a slider for “Glow level”.',
  'Use a quiz sticker to vote on favourite result + emoji slider for confidence level.',
  'Turn the story into a “This or That” sequence with a DM me button.',
  'Collect audience input with a “Ask me anything about today’s tip” box.',
  'Use a countdown sticker leading into tomorrow’s teaser.'
];

const DISTRIBUTION_PLAN_FALLBACK = 'Share this concept across Instagram, TikTok, and LinkedIn with the updated hook and CTA.';

const pickCycledItem = (items = [], index = 0) => {
  if (!items.length) return '';
  const idx = Math.abs(Math.floor(index)) % items.length;
  return items[idx];
};

const buildDistributionPlanText = (post = {}) => {
  const parts = [];
  const repurpose = Array.isArray(post.repurpose) ? post.repurpose.map((item) => toPlainString(item)).filter(Boolean) : [];
  if (repurpose.length) {
    parts.push(repurpose.join(' • '));
  }
  const variants = post.variants || {};
  const variantLines = [];
  const instagram = toPlainString(variants.instagram_caption || variants.igCaption || variants.igCaptionText);
  if (instagram) variantLines.push(`Instagram: ${instagram}`);
  const tiktok = toPlainString(variants.tiktok_caption || variants.tiktokCaption);
  if (tiktok) variantLines.push(`TikTok: ${tiktok}`);
  const linkedin = toPlainString(variants.linkedin_caption || variants.linkedinCaption);
  if (linkedin) variantLines.push(`LinkedIn: ${linkedin}`);
  if (variantLines.length) {
    parts.push(variantLines.join(' | '));
  }
  return parts.filter(Boolean).join('\n');
};

const buildStoryPromptExpanded = (post = {}, dayIndex = 0) => {
  const base = toPlainString(post.storyPrompt);
  const suffix = pickCycledItem(PRO_INTERACTIVE_PROMPTS, dayIndex);
  const combined = [base, suffix].filter(Boolean).join(' ').trim();
  return sanitizeStoryPromptPlus(post.niche || post.nicheStyle || '', combined, post);
};

const enrichRegenPost = (post = {}, dayIndex = 0) => {
  const enriched = { ...post };
  enriched.distributionPlan = buildDistributionPlanText(post) || DISTRIBUTION_PLAN_FALLBACK;
  enriched.storyPromptExpanded = buildStoryPromptExpanded(post, dayIndex) || enriched.storyPrompt || '';
  return enriched;
};


function getPresetGuidelines(nicheStyle = '') {
  const s = String(nicheStyle || '').toLowerCase();
  if (!s) return null;
  for (const preset of promptPresets) {
    const patterns = Array.isArray(preset.patterns) ? preset.patterns : [];
    const matches = patterns.some((pattern) => {
      try {
        return new RegExp(pattern, 'i').test(s);
      } catch (err) {
        return s.includes(String(pattern || '').toLowerCase());
      }
    });
    if (matches) return preset;
  }
  return null;
}

async function callOpenAI(nicheStyle, brandContext, opts = {}) {
  const { loggingContext = {} } = opts;
  const prompt = buildPrompt(nicheStyle, brandContext, opts);
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,
    max_tokens: 4000,
  });
  const requestOptions = {
    hostname: 'api.openai.com',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  };
  const debugEnabled = process.env.DEBUG_AI_PARSE === '1';
  const fetchAndParse = async (attempt = 0) => {
    const json = await openAIRequest(requestOptions, payload);
    const content = json?.choices?.[0]?.message?.content || '';
    try {
      const { data, attempts } = parseLLMArray(content, {
        requireArray: true,
        itemValidate: (p) => p && typeof p.day === 'number',
      }, {
        endpoint: 'calendar',
        ...loggingContext,
      });
      if (debugEnabled) console.log('[CALENDAR PARSE] attempts:', attempts);
      return data;
    } catch (err) {
      if (attempt < 1) {
        if (debugEnabled) console.warn('[CALENDAR PARSE] retry after failure:', err.message);
        return fetchAndParse(attempt + 1);
      }
      const contextLabel = formatCalendarLogContext(loggingContext);
      const label = contextLabel ? ` (${contextLabel})` : '';
      console.warn(`[Calendar] parse failure${label}:`, err.message);
      throw err;
    }
  };
  return fetchAndParse(0);
}
function hasValidStrategy(post) {
  if (!post || typeof post !== 'object') return false;
  const strategy = post.strategy;
  if (!strategy || typeof strategy !== 'object') return false;
  const hooks = Array.isArray(strategy.hook_options)
    ? strategy.hook_options.map((option) => String(option || '').trim()).filter(Boolean)
    : [];
  const targetSaves = Number(strategy.target_saves_pct ?? strategy.target_saves ?? strategy.targetSaves);
  const targetComments = Number(strategy.target_comments_pct ?? strategy.target_comments ?? strategy.targetComments);
  const hookSet = new Set(hooks);
  const keyword = String(strategy.pinned_keyword || '').trim();
  const deliverable = String(strategy.pinned_deliverable || '').trim();
  return (
    typeof strategy.angle === 'string' && strategy.angle.trim() &&
    typeof strategy.objective === 'string' && strategy.objective.trim() &&
    keyword && isKeywordValid(keyword, post) &&
    deliverable && isDeliverableValid(deliverable, post) &&
    typeof strategy.pinned_comment === 'string' && strategy.pinned_comment.trim() &&
    hooks.length >= 3 &&
    hookSet.size >= 3 &&
    Number.isFinite(targetSaves) &&
    Number.isFinite(targetComments)
  );
}



function loadBrand(userId) {
  try {
    const file = path.join(BRANDS_DIR, slugify(userId) + '.json');
    if (!fs.existsSync(file)) return null;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return json;
  } catch (e) {
    console.error('Failed to load brand profile:', e);
    return null;
  }
}

function extractBrandVoiceText(brand) {
  if (!brand?.chunks || !Array.isArray(brand.chunks)) return '';
  return brand.chunks
    .map((chunk) => (typeof chunk?.text === 'string' ? chunk.text.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

// Brand Brain persistence helpers (Supabase-backed, tolerate missing table)
async function fetchBrandBrainPreference(userId) {
  if (!userId || !supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('brand_brain_preferences')
      .select('preferences, updated_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;
    return { text: data.preferences || '', updatedAt: data.updated_at || null };
  } catch (err) {
    const msg = String(err?.message || err);
    // If the table doesn't exist in this environment, fall back silently
    if (msg.includes('brand_brain_preferences') || msg.includes('42P01') || msg.includes('schema cache')) {
      console.warn('[BrandBrain] preferences table missing; skipping load');
      return null;
    }
    console.error('[BrandBrain] fetch preference failed', msg);
    return null;
  }
}

async function upsertBrandBrainPreference(userId, text) {
  if (!userId || !supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('brand_brain_preferences')
      .upsert(
        {
          user_id: userId,
          preferences: text,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      )
      .select('preferences, updated_at')
      .maybeSingle();

    if (error) throw error;
    return data || null;
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes('brand_brain_preferences') || msg.includes('42P01') || msg.includes('schema cache')) {
      console.warn('[BrandBrain] preferences table missing; skipping persist');
      return null;
    }
    console.error('[BrandBrain] upsert preference failed', msg);
    return null;
  }
}

// Loads a normalized snapshot of the user's Brand Brain + Brand Design settings.
async function loadUserBrandProfile(userId) {
  if (!userId) return null;
  try {
    const brand = loadBrand(userId);
    if (!brand) return null;
    const kit = brand.kit || {};
    return {
      voice: extractBrandVoiceText(brand) || '',
      primaryColor: kit.primaryColor || '',
      secondaryColor: kit.secondaryColor || '',
      accentColor: kit.accentColor || '',
      headingFont: kit.headingFont || '',
      bodyFont: kit.bodyFont || '',
      logoUrl: kit.logoUrl || kit.logoDataUrl || '',
    };
  } catch (err) {
    console.error('loadUserBrandProfile error', { userId, message: err?.message });
    return null;
  }
}

const BRAND_FIELD_ALIASES = {
  brand_voice: ['brand_voice', 'brandVoice'],
  brand_primary_color: ['brand_primary_color', 'brandPrimaryColor'],
  brand_secondary_color: ['brand_secondary_color', 'brandSecondaryColor'],
  brand_accent_color: ['brand_accent_color', 'brandAccentColor'],
  brand_heading_font: ['brand_heading_font', 'brandHeadingFont'],
  brand_body_font: ['brand_body_font', 'brandBodyFont'],
  brand_logo_url: ['brand_logo_url', 'brandLogoUrl'],
};

function normalizeIncomingBrandFields(payload = {}) {
  const result = {};
  if (!payload || typeof payload !== 'object') return result;
  Object.entries(BRAND_FIELD_ALIASES).forEach(([target, aliases]) => {
    for (const alias of aliases) {
      const raw = payload[alias];
      if (typeof raw === 'string' && raw.trim()) {
        result[target] = raw.trim();
        break;
      }
    }
  });
  return result;
}

function saveBrand(userId, chunksWithEmb) {
  const file = path.join(BRANDS_DIR, slugify(userId) + '.json');
  let existingKit = null;
  try {
    if (fs.existsSync(file)) {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current && current.kit) existingKit = current.kit;
    }
  } catch (_) {}
  const payload = {
    userId,
    updatedAt: new Date().toISOString(),
    chunks: chunksWithEmb,
    kit: existingKit || null,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

const HEX_COLOR_REGEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

function normalizeHexColor(value) {
  if (typeof value !== 'string') return null;
  let hex = value.trim();
  if (!hex) return '';
  if (!hex.startsWith('#')) hex = `#${hex}`;
  if (!HEX_COLOR_REGEX.test(hex)) return null;
  if (hex.length === 4) {
    hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  }
  return hex.toLowerCase();
}

function sanitizeFont(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 80);
}

function sanitizeLogoData(url) {
  if (url === '') return '';
  if (typeof url !== 'string' || !url.startsWith('data:image/')) {
    throw new Error('Invalid logo file. Upload a PNG, JPG, or SVG.');
  }
  if (Buffer.byteLength(url, 'utf8') > MAX_LOGO_BYTES) {
    throw new Error('Logo is too large. Please upload a smaller file (<=2MB).');
  }
  return url;
}

function sanitizeBrandKitInput(input = {}) {
  if (!input || typeof input !== 'object') return null;
  const kit = {};
  if ('primaryColor' in input) {
    if (!input.primaryColor) {
      kit.primaryColor = '';
    } else {
      const normalized = normalizeHexColor(input.primaryColor);
      if (!normalized) throw new Error('Primary color must be a hex code (e.g., #7f5af0).');
      kit.primaryColor = normalized;
    }
  }
  if ('secondaryColor' in input) {
    if (!input.secondaryColor) {
      kit.secondaryColor = '';
    } else {
      const normalized = normalizeHexColor(input.secondaryColor);
      if (!normalized) throw new Error('Secondary color must be a hex code.');
      kit.secondaryColor = normalized;
    }
  }
  if ('accentColor' in input) {
    if (!input.accentColor) {
      kit.accentColor = '';
    } else {
      const normalized = normalizeHexColor(input.accentColor);
      if (!normalized) throw new Error('Accent color must be a hex code.');
      kit.accentColor = normalized;
    }
  }
  if ('headingFont' in input) {
    kit.headingFont = sanitizeFont(input.headingFont);
  }
  if ('bodyFont' in input) {
    kit.bodyFont = sanitizeFont(input.bodyFont);
  }
  if ('logoDataUrl' in input) {
    kit.logoDataUrl = sanitizeLogoData(input.logoDataUrl);
  }
  if (!Object.keys(kit).length) return null;
  kit.updatedAt = new Date().toISOString();
  return kit;
}

function saveBrandKit(userId, kitInput) {
  const sanitized = sanitizeBrandKitInput(kitInput);
  if (!sanitized) {
    throw new Error('Provide at least one Brand Design field to save.');
  }
  const file = path.join(BRANDS_DIR, slugify(userId) + '.json');
  let payload = {
    userId,
    updatedAt: new Date().toISOString(),
    chunks: [],
    kit: sanitized,
  };
  try {
    if (fs.existsSync(file)) {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      payload = Object.assign({}, current, { userId, updatedAt: current?.updatedAt || new Date().toISOString() });
      payload.chunks = Array.isArray(current?.chunks) ? current.chunks : [];
    }
  } catch (_) {}
  payload.kit = Object.assign({}, payload.kit || {}, sanitized);
  payload.kit.updatedAt = sanitized.updatedAt;
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function loadCustomersMap() {
  try {
    const raw = fs.readFileSync(CUSTOMERS_FILE, 'utf8');
    const json = JSON.parse(raw || '{}');
    return json && typeof json === 'object' ? json : {};
  } catch (e) {
    return {};
  }
}

function saveCustomersMap(map) {
  try {
    fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify(map, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Failed to save customers map:', e);
    return false;
  }
}

function describeBrandKitForPrompt(kit, { includeLogo } = {}) {
  if (!kit) return '';
  const lines = [];
  const palette = [kit.primaryColor, kit.secondaryColor, kit.accentColor].filter(Boolean);
  if (palette.length) {
    lines.push(`Palette: ${palette.join(', ')}`);
  }
  const fonts = [kit.headingFont, kit.bodyFont].filter(Boolean);
  if (fonts.length) {
    lines.push(`Typography: ${fonts.join(' / ')}`);
  }
  if (includeLogo && kit.logoDataUrl) {
    lines.push('Logo: Include safe area for brand mark.');
  }
  return lines.length ? lines.join('\n') : '';
}

function summarizeBrandForPrompt(brand) {
  if (!brand) return '';
  let out = '';
  if (brand.chunks && brand.chunks.length > 0) {
    for (const c of brand.chunks) {
      if ((out + '\n' + c.text).length > 2400) break;
      out += (out ? '\n' : '') + c.text;
    }
  }
  const kitSummary = describeBrandKitForPrompt(brand.kit, { includeLogo: false });
  if (kitSummary) {
    out += (out ? '\n\n' : '') + `Brand design:\n${kitSummary}`;
  }
  return out.trim();
}

function isBrandKitPath(pathname) {
  if (!pathname) return false;
  const normalized = String(pathname)
    .toLowerCase()
    .replace(/\/+$/, '');
  return (
    normalized === '/api/brand/kit' ||
    normalized === '/api/brand-kit' ||
    normalized === '/api/brandkit'
  );
}

const server = http.createServer((req, res) => {
  try {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Security & professionalism headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('X-Frame-Options', 'DENY');
  // Basic CSP (allow self + needed CDNs). Removed unsafe-inline for scripts; add nonce for inline JSON-LD if present.
  // Note: We still allow 'unsafe-inline' for styles until all inline styles are refactored.
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://unpkg.com https://cdn.jsdelivr.net/npm/@supabase https://cdn.getphyllo.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https://usepromptly.app https://res.cloudinary.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://api.openai.com https://*.supabase.co https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://fonts.gstatic.com https://api.sandbox.getphyllo.com; frame-src 'self' https://connect.sandbox.getphyllo.com; frame-ancestors 'none';");
  // Cloudinary is allowed in img-src so asset previews work.
  // HSTS only if behind HTTPS (skip for localhost dev)
  if ((req.headers.host || '').includes('usepromptly.app')) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // Short-circuit legacy Design Lab page when disabled
  const parsed = url.parse(req.url, true);
  if (!ENABLE_DESIGN_LAB && parsed.pathname === '/design.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  if (parsed.pathname === '/api/user/subscription' && req.method === 'GET') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        if (!user || !user.id) {
          return sendJson(res, 200, { ok: true, plan: 'free' });
        }

        const { data, error } = await supabaseAdmin
          .from('profiles')
          .select('subscription_plan')
          .eq('id', user.id)
          .single();

        if (error) {
          console.error('[Subscription] fetch error', error);
          return sendJson(res, 200, { ok: true, plan: 'free' });
        }

        return sendJson(res, 200, { ok: true, plan: data?.subscription_plan || 'free' });
      } catch (err) {
        console.error('[Subscription] server error', err);
        return sendJson(res, 200, { ok: true, plan: 'free' });
      }
    })();
    return;
  }

  // Serve favicon from SVG asset to avoid 404s
  if (parsed.pathname === '/favicon.ico') {
    const fav = path.join(__dirname, 'assets', 'promptly-icon.svg');
    try {
      if (fs.existsSync(fav)) {
        return serveFile(fav, res);
      }
    } catch {}
    // If not found, return 204 No Content instead of 404
    res.writeHead(204);
    return res.end();
  }

  // Serve apple touch icon path if requested by iOS (fallback to SVG)
  if (parsed.pathname === '/apple-touch-icon.png') {
    const apple = path.join(__dirname, 'assets', 'promptly-icon.svg');
    try {
      if (fs.existsSync(apple)) {
        return serveFile(apple, res);
      }
    } catch {}
    res.writeHead(204);
    return res.end();
  }

  // Optional canonical host redirect to enforce a single domain (e.g., promptlyapp.com)
  // IMPORTANT: Do NOT redirect Stripe webhooks; Stripe will not follow 301s for webhooks.
  const pathLower = typeof parsed.pathname === 'string' ? parsed.pathname.toLowerCase() : '';
  const isApiRequest = pathLower.startsWith('/api/') || req.method !== 'GET';
  if (CANONICAL_HOST && parsed.pathname !== '/stripe/webhook' && !isApiRequest) {
    const reqHost = (req.headers && req.headers.host) ? String(req.headers.host) : '';
    // Strip port if present for comparison
    const normalize = (h) => String(h || '').replace(/:\d+$/, '');
    if (reqHost && normalize(reqHost).toLowerCase() !== normalize(CANONICAL_HOST).toLowerCase()) {
      const location = `https://${CANONICAL_HOST}${parsed.path || parsed.pathname || '/'}`;
      res.writeHead(301, { Location: location });
      return res.end();
    }
  }
  if (req.method === 'GET') {
    if (parsed.pathname === '/js/landing.js') {
      const landingScript = path.join(__dirname, 'js', 'landing.js');
      if (fs.existsSync(landingScript)) {
        return serveFile(landingScript, res);
      }
    }
    if (parsed.pathname === '/calendar' || parsed.pathname === '/calendar.html') {
      const calendarPage = path.join(__dirname, 'calendar.html');
      if (fs.existsSync(calendarPage)) {
        return serveFile(calendarPage, res);
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'calendar_not_found' }));
    }
  }

  // Helper: serve static file with optional gzip if client supports
  function serveFile(filePath, res) {
    try {
      const ext = path.extname(filePath).toLowerCase();
      const typeMap = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon'
      };
      const raw = fs.readFileSync(filePath);
      const accept = req.headers['accept-encoding'] || '';
      // Only compress text-like content
      const isText = /\.(html|css|js|json|txt)$/i.test(filePath);
      // Override content-type for JSON-LD schema files to satisfy validators
      try {
        const base = path.basename(filePath);
        const isSchemaJson = filePath.includes(path.join('assets', path.sep)) && /^schema-.*\.json$/i.test(base);
        if (isSchemaJson) {
          res.setHeader('Content-Type', 'application/ld+json; charset=utf-8');
        }
      } catch {}
      if (isText && accept.includes('gzip')) {
        try {
          const zlib = require('zlib');
          const gz = zlib.gzipSync(raw);
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Vary', 'Accept-Encoding');
          if (!res.getHeader('Content-Type')) {
            res.setHeader('Content-Type', typeMap[ext] || 'application/octet-stream');
          }
          res.writeHead(200);
          return res.end(gz);
        } catch (e) {
          // Fallback to raw
        }
      }
      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', typeMap[ext] || 'application/octet-stream');
      }
      res.writeHead(200);
      return res.end(raw);
    } catch (e) {
      res.writeHead(404);
      return res.end('Not found');
    }
  }

  // ---------------------------------------------------------------------------
  // Calendar API endpoints
  // ---------------------------------------------------------------------------

  // helper to generate calendar posts (reuse logic from /api/generate-calendar)
  async function generateCalendarPosts(payload = {}) {
    const { nicheStyle, userId, days, startDay, postsPerDay, context } = payload;
    const loggingContext = context || {};
    const tStart = Date.now();
    console.log('[Calendar][Server][Perf] generateCalendarPosts start', {
      nicheStyle,
      userId: !!userId,
      days,
      startDay,
      postsPerDay,
      context: loggingContext,
    });
    if (!nicheStyle) {
      const err = new Error('nicheStyle required');
      err.statusCode = 400;
      throw err;
    }
    if (!OPENAI_API_KEY) {
      const err = new Error('OPENAI_API_KEY not set');
      err.statusCode = 500;
      throw err;
    }
    const classification = categorizeNiche(nicheStyle);
    const brand = userId ? loadBrand(userId) : null;
    const brandContext = summarizeBrandForPrompt(brand);
    const callStart = Date.now();
    console.log('[Calendar][Server][Perf] callOpenAI start', {
      nicheStyle,
      days,
      startDay,
      postsPerDay,
      context: loggingContext,
    });
    const rawPosts = await callOpenAI(nicheStyle, brandContext, { days, startDay, postsPerDay, loggingContext });
    const openDuration = Date.now() - callStart;
    const validationStart = Date.now();
    const audioCache = await getMonthlyTrendingAudios({ requestId: loggingContext?.requestId });
    const tiktokLen = audioCache.tiktok.length;
    const instagramLen = audioCache.instagram.length;
    for (let idx = 0; idx < rawPosts.length; idx += 1) {
      const tiktokEntry = tiktokLen ? audioCache.tiktok[idx % tiktokLen] : null;
      const instagramEntry = instagramLen ? audioCache.instagram[idx % instagramLen] : null;
      rawPosts[idx].audio = formatAudioLine(idx, tiktokEntry, instagramEntry);
    }
    let posts = rawPosts.map((p, idx) => normalizePost(p, idx, startDay, undefined, nicheStyle));
    let promoCount = 0;
    const promoKeywords = /\b(discount|special|deal|promo|offer|sale|glow special|student)\b/i;
    posts = posts.map((normalized) => {
      const isPromo =
        !!normalized.promoSlot ||
        (typeof normalized.weeklyPromo === 'string' && promoKeywords.test(normalized.weeklyPromo)) ||
        (typeof normalized.cta === 'string' && promoKeywords.test(normalized.cta)) ||
        (typeof normalized.idea === 'string' && promoKeywords.test(normalized.idea));
      if (isPromo) {
        promoCount += 1;
        if (promoCount > 3) {
          normalized.promoSlot = false;
          normalized.weeklyPromo = '';
          if (promoKeywords.test(normalized.idea || '')) {
            normalized.idea = normalized.idea.replace(promoKeywords, '').trim() || 'Fresh content idea';
          }
        }
      }
      return normalized;
    });
    posts = ensureUniqueStrategyValues(posts);
    posts = ensureUniqueStrategyValues(posts);
    posts = await sanitizeStrategyCopy(posts, nicheStyle, classification);
    const helperType = typeof dedupePinnedComments;
    if (helperType !== 'function') {
      console.warn('[Calendar] dedupePinnedComments missing', {
        requestId: loggingContext?.requestId || 'unknown',
        helperType,
      });
    } else {
      posts = await dedupePinnedComments(posts, classification, nicheStyle);
    }
    posts = await ensurePostingTimeTips(posts, classification, nicheStyle, brandContext);
    posts = posts.map((post) => {
      if (!validateNicheLock(post, nicheStyle)) {
        const fallback = buildStoryPromptPlusNicheFallback(nicheStyle);
        post.storyPrompt = fallback;
        post.storyPromptExpanded = fallback;
        console.warn('[NicheLock] Story Prompt+ fallback applied', { niche: nicheStyle, day: post.day });
      }
      return post;
    });
    logDuplicateStrategyValues(posts);
    const postProcessingMs = Date.now() - validationStart;
    console.log('[Calendar][Server][Perf] callOpenAI timings', {
      openMs: openDuration,
      parseMs: postProcessingMs,
      postCount: posts.length,
      context: loggingContext,
    });
    console.log('[Calendar][Server][Perf] generateCalendarPosts end', {
      elapsedMs: Date.now() - tStart,
      count: posts.length,
      context: loggingContext,
    });
    return posts;
  }

  if (parsed.pathname === '/api/calendar/export-usage' && req.method === 'GET') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        req.user = user;
        const isPro = isUserPro(req);
        if (isPro) {
          return sendJson(res, 200, {
            ok: true,
            isPro: true,
            exportsUsed: 0,
            remainingFreeExports: null,
          });
        }

        const usage = await getFeatureUsageCount(supabaseAdmin, user.id, CALENDAR_EXPORT_FEATURE_KEY);
        return sendJson(res, 200, {
          ok: true,
          isPro: false,
          exportsUsed: usage,
          remainingFreeExports: Math.max(0, 3 - usage),
        });
      } catch (err) {
        console.error('[export-usage] failed', err);
        return sendJson(res, 500, { ok: false, error: 'export_usage_fetch_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/calendar/save' && req.method === 'POST') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        req.user = user;
        const isPro = isUserPro(req);
        if (!isPro) {
          const usage = await getFeatureUsageCount(supabaseAdmin, user.id, CALENDAR_EXPORT_FEATURE_KEY);
          if (usage >= 3) {
            return sendJson(res, 402, {
              ok: false,
              error: 'upgrade_required',
              feature: CALENDAR_EXPORT_FEATURE_KEY,
            });
          }
        }
        const body = await readJsonBody(req);
        const calendar = body || {};
        const posts = calendar.posts || calendar.calendar || calendar.calendar?.posts || [];
        const nicheStyle = calendar.nicheStyle || calendar.niche || 'Untitled';
        const payload = {
          user_id: user.id,
          niche_style: nicheStyle,
          posts,
          saved_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        const { data, error } = await supabaseAdmin
          .from('calendars')
          .insert(payload)
          .select()
          .single();
        if (error) {
          console.error('[Calendar] save failed', error);
          return sendJson(res, 500, { ok: false, error: 'save_failed' });
        }
        if (!isPro) {
          await incrementFeatureUsage(supabaseAdmin, user.id, CALENDAR_EXPORT_FEATURE_KEY);
        }
        return sendJson(res, 200, { ok: true, calendar: data });
      } catch (err) {
        const status = err.statusCode || 500;
        console.error('[Calendar] save error', err);
        return sendJson(res, status, { ok: false, error: 'save_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/calendar/download' && req.method === 'POST') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        req.user = user;
        const isPro = isUserPro(req);
        if (!isPro) {
          const usage = await getFeatureUsageCount(supabaseAdmin, user.id, CALENDAR_EXPORT_FEATURE_KEY);
          if (usage >= 3) {
            return sendJson(res, 402, {
              ok: false,
              error: 'upgrade_required',
              feature: CALENDAR_EXPORT_FEATURE_KEY,
            });
          }
        }
        const body = await readJsonBody(req);
        const calendarId = body?.calendarId || body?.id;
        if (calendarId) {
          const { data, error } = await supabaseAdmin
            .from('calendars')
            .select('*')
            .eq('id', calendarId)
            .eq('user_id', user.id)
            .single();
          if (error) {
            console.error('[Calendar] download fetch error', error);
            return sendJson(res, 404, { ok: false, error: 'not_found' });
          }
          if (!isPro) {
            await incrementFeatureUsage(supabaseAdmin, user.id, CALENDAR_EXPORT_FEATURE_KEY);
          }
          return sendJson(res, 200, { ok: true, calendar: data });
        }
        const calendar = body?.calendar || body;
        if (!isPro) {
          await incrementFeatureUsage(supabaseAdmin, user.id, CALENDAR_EXPORT_FEATURE_KEY);
        }
        return sendJson(res, 200, { ok: true, calendar });
      } catch (err) {
        const status = err.statusCode || 500;
        console.error('[Calendar] download error', err);
        return sendJson(res, status, { ok: false, error: 'download_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/calendar/regenerate' && req.method === 'POST') {
    (async () => {
      let body = null;
      const requestId = generateRequestId('regen');
      try {
        // Require auth for regen, but still allow body userId to pass brand
        const user = await requireSupabaseUser(req);
        req.user = user;
        const isPro = isUserPro(req);
        const tStart = Date.now();
        console.log('[Calendar][Server][Perf] regen request received', { requestId, userId: user.id, isPro });
        if (!isPro) {
          const usage = await getFeatureUsageCount(supabaseAdmin, user.id, CALENDAR_EXPORT_FEATURE_KEY);
          if (usage >= 3) {
            return sendJson(res, 402, {
              ok: false,
              error: 'upgrade_required',
              feature: CALENDAR_EXPORT_FEATURE_KEY,
            });
          }
        }
        body = await readJsonBody(req);
        console.log('[Calendar][Server][Perf] regen generation start', {
          requestId,
          days: body?.days,
          startDay: body?.startDay,
          postsPerDay: body?.postsPerDay,
        });
        const posts = await generateCalendarPosts({
          ...(body || {}),
          context: {
            requestId,
            batchIndex: body?.batchIndex,
            startDay: body?.startDay,
          },
        });
        if (!isPro) {
          await incrementFeatureUsage(supabaseAdmin, user.id, CALENDAR_EXPORT_FEATURE_KEY);
        }
        console.log('[Calendar][Server][Perf] regen response ready', {
          requestId,
          elapsedMs: Date.now() - tStart,
          postCount: Array.isArray(posts) ? posts.length : 0,
        });
        return sendJson(res, 200, { posts });
      } catch (err) {
        const context = {
          postsPerDay: body?.postsPerDay,
          days: body?.days,
          startDay: body?.startDay,
          nicheStyle: body?.nicheStyle,
        };
        logServerError('calendar_regenerate_error', err, { requestId, context });
        if (res.headersSent) return;
        const isSchemaError = err?.code === 'OPENAI_SCHEMA_ERROR';
        const status = isSchemaError ? 502 : (err?.statusCode || 500);
        const payload = {
          error: isSchemaError
            ? { message: 'openai_schema_error', code: 'OPENAI_SCHEMA_ERROR' }
            : { message: err?.message || 'Internal Server Error', code: err?.code || 'CALENDAR_REGENERATE_FAILED' },
          requestId,
        };
        if (isSchemaError && !isProduction && err?.rawContent) {
          payload.error.debug = err.rawContent;
        }
        if (!isSchemaError && !isProduction && err?.stack) {
          payload.debugStack = err.stack;
        }
        return sendJson(res, status, payload);
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/generate-calendar' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      const requestId = generateRequestId('generate');
      try {
        const payload = JSON.parse(body || '{}');
        const posts = await generateCalendarPosts({
          ...payload,
          context: {
            requestId,
            batchIndex: payload?.batchIndex,
            startDay: payload?.startDay,
          },
        });
        return sendJson(res, 200, { posts });
      } catch (err) {
        logServerError('calendar_generate_error', err, { requestId, bodyPreview: body.slice(0, 400) });
        respondWithServerError(res, err, { requestId });
      }
    });
    return;
  }

  if (parsed.pathname === '/api/design-assets' && req.method === 'POST') {
    if (!ENABLE_DESIGN_LAB) return sendJson(res, 410, { error: 'Design Lab has been removed.' });
    handleCreateDesignAsset(req, res);
    return;
  }

  if (parsed.pathname === '/api/design-assets' && req.method === 'GET') {
    if (!ENABLE_DESIGN_LAB) return sendJson(res, 410, { error: 'Design Lab has been removed.' });
    handleListDesignAssets(req, res, parsed.query || {});
    return;
  }

  const designAssetMatch = parsed.pathname && parsed.pathname.match(/^\/api\/design-assets\/([a-f0-9-]+)$/i);
  if (designAssetMatch && req.method === 'GET') {
    if (!ENABLE_DESIGN_LAB) return sendJson(res, 410, { error: 'Design Lab has been removed.' });
    handleGetDesignAsset(req, res, designAssetMatch[1]);
    return;
  }
  if (designAssetMatch && req.method === 'PATCH') {
    if (!ENABLE_DESIGN_LAB) return sendJson(res, 410, { error: 'Design Lab has been removed.' });
    handlePatchDesignAsset(req, res, designAssetMatch[1]);
    return;
  }

  if (parsed.pathname === '/api/debug/design-test' && req.method === 'POST') {
    if (!ENABLE_DESIGN_LAB) return sendJson(res, 410, { error: 'Design Lab has been removed.' });
    handleDebugDesignTest(req, res);
    return;
  }

  if (parsed.pathname === '/api/debug/design-assets' && req.method === 'GET') {
    if (!ENABLE_DESIGN_LAB) return sendJson(res, 410, { error: 'Design Lab has been removed.' });
    handleDebugDesignAssets(req, res);
    return;
  }

  if (parsed.pathname === '/api/debug/placid-templates' && req.method === 'GET') {
    if (!ENABLE_DESIGN_LAB) return sendJson(res, 410, { error: 'Design Lab has been removed.' });
    handlePlacidTemplateDebug(req, res);
    return;
  }

  if (parsed.pathname === '/api/debug/placid-config' && req.method === 'GET') {
    if (!ENABLE_DESIGN_LAB) return sendJson(res, 410, { error: 'Design Lab has been removed.' });
    handleDebugPlacidConfig(req, res);
    return;
  }

  const calendarDeleteMatch =
    parsed.pathname && parsed.pathname.match(/^\/api\/calendars\/([^/]+)$/i);
  if (calendarDeleteMatch && req.method === 'DELETE') {
    handleDeleteCalendar(req, res, calendarDeleteMatch[1]);
    return;
  }

  if (parsed.pathname === '/api/design/generate' && req.method === 'POST') {
    if (!ENABLE_DESIGN_LAB) {
      return sendJson(res, 410, { error: 'Design Lab has been removed.' });
    }
    if (!STABILITY_API_KEY) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Design generation not configured', hint: 'Set STABILITY_API_KEY on the server.' }));
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const {
          assetType = 'story template',
          tone = 'bold',
          notes = '',
          day = '',
          caption = '',
          captionCue = '',
          concept = '',
          niche = '',
          aspectRatio = '9:16',
          userId = '',
          cta: payloadCta = '',
          brandPalette: palettePayload = {},
          fonts: fontsPayload = {},
          primaryColor: payloadPrimary = '',
          secondaryColor: payloadSecondary = '',
          accentColor: payloadAccent = '',
          headingFont: payloadHeading = '',
          bodyFont: payloadBody = '',
        } = payload;
        const brandProfile = userId ? loadBrand(userId) : null;
        const brandKit = brandProfile?.kit || null;
        const palette = {
          primary: palettePayload.primaryColor || payloadPrimary || brandKit?.primaryColor || '#7f5af0',
          secondary: palettePayload.secondaryColor || payloadSecondary || brandKit?.secondaryColor || '#2cb1bc',
          accent: palettePayload.accentColor || payloadAccent || brandKit?.accentColor || '#ff7ac3',
        };
        const fonts = {
          heading: fontsPayload.heading || payloadHeading || brandKit?.headingFont || 'Inter Bold',
          body: fontsPayload.body || payloadBody || brandKit?.bodyFont || 'Source Sans Pro',
        };
        const wantsCarousel = /carousel/i.test(String(assetType || ''));
        if (wantsCarousel) {
          try {
            const carouselResult = await generateCarouselSlides({
              tone,
              notes,
              concept: concept || captionCue || caption || '',
              captionCue: captionCue || caption || '',
              cta: payloadCta || '',
              niche,
              brandPalette: palette,
              fonts,
            });
            const response = {
              id: `${Date.now()}-${slugify(assetType)}`,
              day,
              title: `${assetType || 'Carousel'}${day ? ` · Day ${day}` : ''}`,
              type: assetType,
              typeLabel: assetType,
              status: 'Ready',
              downloadUrl: carouselResult.downloadUrl,
              bundleUrl: carouselResult.bundleUrl,
              previewUrl: carouselResult.previewUrl,
              slides: carouselResult.slides,
              previewText: notes || caption || '',
              accentColor: palette.accent,
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
            return;
          } catch (err) {
            console.error('Stability generation failed:', err);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Stability generation failed', detail: err.message || String(err) }));
            return;
          }
        }
        const captionText = captionCue || caption || '';
        const prompt = buildDesignPrompt({
          assetType,
          tone,
          notes,
          day,
          caption: captionText,
          niche,
          brandKit,
          concept: concept || captionText,
          cta: payloadCta,
          brandPalette: palette,
          fonts,
        });
        let buffer;
        let extension;
        try {
          buffer = await generateStabilityImage(prompt, aspectRatio);
          extension = '.png';
        } catch (err) {
          console.error('Stability generation failed:', err);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Stability generation failed', detail: err.message || String(err) }));
        }
        const safeName = `${Date.now()}-${slugify(assetType || 'asset')}${extension}`;
        const target = path.join(DESIGN_ASSETS_DIR, safeName);
        fs.writeFileSync(target, buffer);
        const response = {
          id: safeName,
          day,
          title: `${assetType || 'AI Asset'}${day ? ` · Day ${day}` : ''}`,
          type: assetType,
          typeLabel: assetType,
          status: 'Ready',
          downloadUrl: `/data/design-assets/${safeName}`,
          previewUrl: `/data/design-assets/${safeName}`,
          previewText: notes || caption || '',
          bundleUrl: '',
          slides: [],
          accentColor: palette.accent,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', detail: err.message || String(err) }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/billing/portal' && req.method === 'POST') {
    // Customer portal creation using Stripe API
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { returnUrl, email } = JSON.parse(body || '{}');
        if (!STRIPE_SECRET_KEY) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Billing portal not configured', hint: 'Set STRIPE_SECRET_KEY in env.' }));
        }
        if (!email) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'email required' }));
        }
        const customers = loadCustomersMap();
        let cid = customers[String(email).toLowerCase()];
        if (!cid) {
          // Fallback: search Stripe customers by email to find existing customer id (useful if local map was lost)
          try {
            const q = new URLSearchParams({ email: String(email) });
            const findOpts = {
              hostname: 'api.stripe.com',
              path: `/v1/customers?${q.toString()}`,
              method: 'GET',
              headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` },
            };
            const list = await new Promise((resolve, reject) => {
              const r = https.request(findOpts, (sres) => {
                let data = '';
                sres.on('data', (c) => (data += c));
                sres.on('end', () => {
                  try {
                    const obj = JSON.parse(data);
                    if (sres.statusCode && sres.statusCode >= 200 && sres.statusCode < 300) return resolve(obj);
                    reject(new Error(`Stripe customers error ${sres.statusCode}: ${data}`));
                  } catch (e) { reject(e); }
                });
              });
              r.on('error', reject);
              r.end();
            });
            if (list && Array.isArray(list.data) && list.data.length > 0) {
              cid = list.data[0].id;
              const map = loadCustomersMap();
              map[String(email).toLowerCase()] = cid;
              saveCustomersMap(map);
            }
          } catch (e) {
            // ignore; will fall through to helpful message
          }
          if (!cid) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'No Stripe customer found for this user yet', hint: 'Complete checkout first so we can map your account.' }));
          }
        }
        // Create portal session via Stripe REST API (form-encoded)
        const form = new URLSearchParams({ customer: cid, return_url: String(returnUrl || '/') });
        const options = {
          hostname: 'api.stripe.com',
          path: '/v1/billing_portal/sessions',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(form.toString()),
          },
        };
        try {
          const json = await new Promise((resolve, reject) => {
            const sreq = https.request(options, (sres) => {
              let data = '';
              sres.on('data', (c) => (data += c));
              sres.on('end', () => {
                try {
                  const parsed = JSON.parse(data);
                  if (sres.statusCode && sres.statusCode >= 200 && sres.statusCode < 300) return resolve(parsed);
                  reject(new Error(`Stripe error ${sres.statusCode}: ${data}`));
                } catch (e) { reject(e); }
              });
            });
            sreq.on('error', reject);
            sreq.write(form.toString());
            sreq.end();
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ url: json.url }));
        } catch (e) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: String(e.message || e) }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/billing/checkout' && req.method === 'POST') {
    // Create a Stripe Checkout Session for subscriptions
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        if (!STRIPE_SECRET_KEY) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Checkout not configured', hint: 'Set STRIPE_SECRET_KEY to enable checkout.' }));
        }
  const { email, priceLookupKey, priceId } = JSON.parse(body || '{}');

  // Build success/cancel URLs with precedence: PUBLIC_BASE_URL ENV > X-Forwarded-* > Host header
  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
  const xfHost = req.headers['x-forwarded-host'];
  const xfProto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const host = String(PUBLIC_BASE_URL || (xfHost ? `${xfProto}://${xfHost}` : `http${req.socket.encrypted ? 's' : ''}://${req.headers.host || 'localhost:8000'}`));
  const base = host.replace(/\/$/, '');
        const success_url = `${base}/success.html?session_id={CHECKOUT_SESSION_ID}`;
        const cancel_url = `${base}/?upgrade=canceled`;

        // Form-encode payload
        const form = new URLSearchParams();
        form.set('mode', 'subscription');
        form.set('success_url', success_url);
        form.set('cancel_url', cancel_url);
        form.set('allow_promotion_codes', 'true');
        form.set('automatic_tax[enabled]', 'true');
        if (email) form.set('customer_email', String(email));
        let effectivePriceId = priceId || process.env.STRIPE_PRICE_ID || '';
        const effectiveLookupKey = priceLookupKey || process.env.STRIPE_PRICE_LOOKUP_KEY || '';
        if (!effectivePriceId && effectiveLookupKey) {
          // Resolve lookup key to price id via Stripe API
          const q = new URLSearchParams();
          q.append('lookup_keys[]', String(effectiveLookupKey));
          const priceListOptions = {
            hostname: 'api.stripe.com',
            path: `/v1/prices?${q.toString()}`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` },
          };
          try {
            const list = await new Promise((resolve, reject) => {
              const r = https.request(priceListOptions, (sres) => {
                let data = '';
                sres.on('data', (c) => (data += c));
                sres.on('end', () => {
                  try {
                    const obj = JSON.parse(data);
                    if (sres.statusCode && sres.statusCode >= 200 && sres.statusCode < 300) return resolve(obj);
                    reject(new Error(`Stripe prices error ${sres.statusCode}: ${data}`));
                  } catch (e) { reject(e); }
                });
              });
              r.on('error', reject);
              r.end();
            });
            effectivePriceId = list && Array.isArray(list.data) && list.data[0] && list.data[0].id;
          } catch (e) {
            // ignore and continue to error below if not resolved
          }
        }

        if (effectivePriceId) {
          form.set('line_items[0][price]', String(effectivePriceId));
          form.set('line_items[0][quantity]', '1');
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Valid priceId or resolvable priceLookupKey required' }));
        }

        const options = {
          hostname: 'api.stripe.com',
          path: '/v1/checkout/sessions',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(form.toString()),
          },
        };
        const session = await new Promise((resolve, reject) => {
          const sreq = https.request(options, (sres) => {
            let data = '';
            sres.on('data', (c) => (data += c));
            sres.on('end', () => {
              try {
                const obj = JSON.parse(data);
                if (sres.statusCode && sres.statusCode >= 200 && sres.statusCode < 300) return resolve(obj);
                reject(new Error(`Stripe error ${sres.statusCode}: ${data}`));
              } catch (e) { reject(e); }
            });
          });
          sreq.on('error', reject);
          sreq.write(form.toString());
          sreq.end();
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ url: session.url }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err.message || err) }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/billing/session' && req.method === 'GET') {
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
    const sessionId = parsed.query.session_id;
    if (!STRIPE_SECRET_KEY) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Not configured' }));
    }
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'session_id required' }));
    }
    const options = {
      hostname: 'api.stripe.com',
      path: `/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` },
    };
    const start = Date.now();
    const timer = setTimeout(() => {}, 0); // keep event loop tick
    const done = (code, payload) => {
      clearTimeout(timer);
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const reqStripe = https.request(options, (sres) => {
      let data = '';
      sres.on('data', (c) => (data += c));
      sres.on('end', () => {
        try {
          const obj = JSON.parse(data);
          if (sres.statusCode && sres.statusCode >= 200 && sres.statusCode < 300) {
            const payload = {
              id: obj.id,
              status: obj.status,
              payment_status: obj.payment_status,
              customer: obj.customer,
              customer_email: obj.customer_details && obj.customer_details.email || obj.customer_email || null,
              subscription_status: obj.subscription && obj.subscription.status || null,
            };
            return done(200, payload);
          }
          return done(502, { error: `Stripe error ${sres.statusCode}`, body: data });
        } catch (e) {
          return done(500, { error: String(e.message || e) });
        }
      });
    });
    reqStripe.on('error', (e) => done(502, { error: String(e.message || e) }));
    reqStripe.end();
    return;
  }

  if (parsed.pathname === '/stripe/webhook' && req.method === 'POST') {
    // Map Stripe customers to user emails after successful checkout
    const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        if (!STRIPE_WEBHOOK_SECRET) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Webhook not configured' }));
        }
        // Verify Stripe signature
        const sig = req.headers['stripe-signature'] || req.headers['Stripe-Signature'] || '';
        const parts = String(sig).split(',').reduce((acc, p) => { const [k,v] = p.split('='); if (k && v) acc[k.trim()] = v.trim(); return acc; }, {});
        const t = parts.t; const v1 = parts.v1;
        if (!t || !v1) throw new Error('Invalid signature header');
        const crypto = require('crypto');
        const signedPayload = `${t}.${raw}`;
        const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(signedPayload).digest('hex');
        const safeEqual = (a, b) => {
          try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
        };
        if (!safeEqual(expected, v1)) throw new Error('Signature verification failed');

        const event = JSON.parse(raw);
        const type = event && event.type;
        const obj = event && event.data && event.data.object;
        if (!type || !obj) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid event' }));
        }
        // Capture mapping on checkout completion or subscription creation
        let email = '';
        let customer = '';
        if (type === 'checkout.session.completed') {
          email = obj.customer_details && obj.customer_details.email || '';
          customer = obj.customer || '';
        } else if (type === 'customer.subscription.created' || type === 'customer.subscription.updated') {
          customer = obj.customer || '';
          email = obj.customer_email || '';
        }
        if (email && customer) {
          const map = loadCustomersMap();
          map[String(email).toLowerCase()] = customer;
          saveCustomersMap(map);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ received: true }));
      } catch (e) {
        console.error('Stripe webhook error:', e);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/generate-variants' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { posts, nicheStyle, userId } = JSON.parse(body || '{}');
        if (!Array.isArray(posts) || posts.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'posts array required' }));
        }
        if (!OPENAI_API_KEY) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'OPENAI_API_KEY not set' }));
        }
        const brand = userId ? loadBrand(userId) : null;
        const brandContext = summarizeBrandForPrompt(brand);

        // Keep batch small to avoid timeouts
        const MAX = 15;
        if (posts.length > MAX) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `too many posts; max ${MAX} per request` }));
        }

        const compactPosts = posts.map(p => ({
          day: p.day,
          caption: p.caption,
          hashtags: Array.isArray(p.hashtags) ? p.hashtags.slice(0, 8) : p.hashtags,
          cta: p.cta,
          format: p.format,
          pillar: p.pillar,
        }));

        const sys = `You transform captions into platform-specific variants. Be concise and keep JSON valid.`;
        const rules = `Rules:
- Respect brand tone if given.
- Keep hashtags balanced (6â8) except LinkedIn (0â3).
- IG: 2 short lines max; keep or improve hook; keep hashtags.
- TikTok: punchy, 80â150 chars, 4â8 hashtags; fun tone.
- LinkedIn: 2â3 sentences, professional, minimal hashtags (0â3), soft CTA.
Return ONLY JSON array of objects: { day, variants: { igCaption, tiktokCaption, linkedinCaption } } in same order as input.`;
        const prompt = `${brandContext ? `Brand Context:
${brandContext}

` : ''}${rules}

Input posts (JSON):
${JSON.stringify(compactPosts)}`;

        const payload = JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: prompt },
          ],
          temperature: 0.4,
          max_tokens: 3500,
        });
        const options = {
          hostname: 'api.openai.com',
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
        };

        const debugEnabled = process.env.DEBUG_AI_PARSE === '1';
        const fetchAndParse = async (attempt=0) => {
          const json = await openAIRequest(options, payload);
          const content = json.choices?.[0]?.message?.content || '';
          try {
            const { data, attempts } = parseLLMArray(content, {
              requireArray: true,
              itemValidate: (v) => v && typeof v.day === 'number' && v.variants && typeof v.variants === 'object'
            }, { endpoint: 'generate-variants' });
            if (debugEnabled) console.log('[VARIANTS PARSE] attempts:', attempts);
            return data;
          } catch (e) {
            if (attempt < 1) {
              if (debugEnabled) console.warn('[VARIANTS PARSE] retry after failure:', e.message);
              return fetchAndParse(attempt+1);
            }
            throw e;
          }
        };
        const parsed = await fetchAndParse(0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ variants: parsed }));
      } catch (err) {
        console.error('Variants error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/regen-day' && req.method === 'POST') {
    (async () => {
      const requestId = generateRequestId('regen-day');
      try {
        const body = await readJsonBody(req);
        const { nicheStyle, day, post, userId } = body || {};
        if (!nicheStyle || typeof day === 'undefined' || day === null) {
          return sendJson(res, 400, { error: 'nicheStyle and day are required' });
        }
        if (!post || typeof post !== 'object') {
          return sendJson(res, 400, { error: 'post payload required' });
        }
        const dayNumber = Number(day);
        const logContext = { requestId, userId: userId || null, nicheStyle, day: dayNumber };
        console.log('[Calendar][Server] regen-day request', logContext);
        const posts = await generateCalendarPosts({
          nicheStyle,
          userId,
          days: 1,
          startDay: dayNumber,
          context: { requestId, batchIndex: 0, startDay: dayNumber },
        });
        const candidate = Array.isArray(posts) && posts.length ? posts[0] : null;
        if (!candidate) throw new Error('Calendar generator returned no posts');
        const enriched = enrichRegenPost(candidate, dayNumber - 1);
        if (!enriched.distributionPlan || !enriched.storyPromptExpanded) {
          console.error('[Calendar] regen-day missing required sections', logContext);
          return sendJson(res, 500, { error: 'Regeneration failed to populate required sections' });
        }
        return sendJson(res, 200, { post: enriched });
      } catch (err) {
        console.error('regen-day error:', err);
        return sendJson(res, 500, { error: err.message || 'Failed to regenerate day' });
      }
    })();
    return;
  }

  const normalizedPath = (() => {
    const rawPath = typeof parsed.pathname === 'string' ? parsed.pathname : '';
    const trimmed = rawPath.replace(/\/+$/, '');
    return (trimmed || '/').toLowerCase();
  })();

  if (parsed.pathname === '/api/phyllo/webhook' && req.method === 'POST') {
    (async () => {
      try {
        const rawBody = await readRawBody(req);
        const signatureHeader =
          req.headers['phyllo-signature'] ||
          req.headers['x-phyllo-signature'] ||
          req.headers['Phyllo-Signature'] ||
          '';
        if (!verifyPhylloWebhookSignature(rawBody, signatureHeader)) {
          console.warn('[Phyllo] Webhook signature verification failed');
          return sendJson(res, 401, { error: 'phyllo_webhook_invalid_signature' });
        }

        let body;
        try {
          body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
        } catch (parseErr) {
          console.error('[Phyllo] Webhook JSON parse error', parseErr);
          return sendJson(res, 400, { error: 'phyllo_webhook_invalid_json' });
        }

        const eventType = body?.type || 'unknown';
        console.log('[Phyllo] Webhook event received:', eventType, body);

        if (eventType === 'ACCOUNTS.CONNECTED' && supabaseAdmin) {
          const account = body?.data?.account;
          if (account && account.id) {
            const phylloAccountId = account.id;
            const phylloUserId = account.user_id;
            const platform = account.work_platform_id;
            const username = account.username || null;
            const profileName = account.profile_name || null;

            supabaseAdmin
              .from('phyllo_users')
              .select('promptly_user_id')
              .eq('phyllo_user_id', phylloUserId)
              .single()
              .then(({ data: userRow }) => {
                if (!userRow) {
                  console.warn('[Phyllo] No promptly user mapping for phyllo_user_id', phylloUserId);
                  return;
                }
                const promptlyUserId = userRow.promptly_user_id;
                return supabaseAdmin
                  .from('phyllo_accounts')
                  .upsert({
                    phyllo_account_id: phylloAccountId,
                    phyllo_user_id: phylloUserId,
                    promptly_user_id: promptlyUserId,
                    work_platform_id: platform,
                    username,
                    profile_name: profileName,
                  }, { onConflict: 'phyllo_account_id' })
                  .then(({ error }) => {
                    if (error) {
                      console.error('[Phyllo] upsert phyllo_accounts error', error);
                    } else {
                      console.log('[Phyllo] phyllo_account stored', phylloAccountId);
                    }
                  });
              })
              .catch((err) => console.error('[Phyllo] lookup phyllo_users failed', err));
          }
        }

        sendJson(res, 200, { received: true });
      } catch (err) {
        console.error('[Phyllo] Webhook handler error:', err);
        sendJson(res, 500, { error: 'phyllo_webhook_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/phyllo/sdk-config' && req.method === 'GET') {
    (async () => {
      if (!process.env.PHYLLO_CLIENT_ID || !process.env.PHYLLO_CLIENT_SECRET) {
        console.error('[Phyllo] Missing PHYLLO_CLIENT_ID or PHYLLO_CLIENT_SECRET env vars');
        return sendJson(res, 200, {
          ok: false,
          error: 'phyllo_env_missing',
          message: 'PHYLLO_CLIENT_ID/PHYLLO_CLIENT_SECRET are not set on the server.',
        });
      }

      try {
        const externalId = 'sandbox-demo-user';

        // 1) try to find existing user
        let phylloUser = await getPhylloUserByExternalId(externalId);

        // 2) create if not found
        if (!phylloUser) {
          try {
            phylloUser = await createPhylloUser({
              name: 'Promptly Sandbox User',
              externalId,
            });
          } catch (err) {
            const status = err.response?.status;
            const data = err.response?.data;
            console.error('[Phyllo] createPhylloUser failed', status, data || err.message);

            return sendJson(res, 200, {
              ok: false,
              error: 'phyllo_create_user_failed',
              status,
              details: data || err.message,
            });
          }
        }

        let sdk;
        try {
          sdk = await createSdkToken({ userId: phylloUser.id });
        } catch (err) {
          const status = err.response?.status;
          const data = err.response?.data;
          console.error('[Phyllo] createSdkToken failed', status, data || err.message);

          return sendJson(res, 200, {
            ok: false,
            error: 'phyllo_create_sdk_token_failed',
            status,
            details: data || err.message,
          });
        }

        const token =
          (sdk && (sdk.token || sdk.sdk_token || sdk.access_token)) ||
          (sdk?.data && (sdk.data.token || sdk.data.sdk_token || sdk.data.access_token));
        const phylloProducts = parsePhylloProducts();

        if (!token) {
          console.error('[Phyllo] SDK token missing in response:', sdk);
          return sendJson(res, 200, {
            ok: false,
            error: 'phyllo_sdk_token_missing',
            details: sdk,
          });
        }

        return sendJson(res, 200, {
          ok: true,
          userId: phylloUser.id,
          token,
          environment: PHYLLO_ENVIRONMENT,
          products: phylloProducts,
          clientDisplayName: process.env.PHYLLO_CONNECT_CLIENT_DISPLAY_NAME || 'Promptly',
        });
      } catch (err) {
        console.error('[Phyllo] sdk-config unexpected error', err);
        return sendJson(res, 200, {
          ok: false,
          error: 'phyllo_sdk_config_failed',
          message: err.message,
        });
      }
    })();
    return;
  }

  // Mock analytics endpoints (no Supabase/OpenAI yet)
  if (parsed.pathname === '/api/phyllo/account-connected' && req.method === 'POST') {
    readJsonBody(req)
      .then(async (body) => {
        try {
          const promptlyUserId = req.user && req.user.id;
          if (!promptlyUserId) {
            return sendJson(res, 401, { ok: false, error: 'unauthorized' });
          }
          const {
            phylloUserId,
            accountId,
            workPlatformId,
            platform,
            handle,
            displayName,
            avatarUrl,
          } = body || {};
          if (!phylloUserId || !accountId || !platform) {
            return sendJson(res, 400, { ok: false, error: 'missing_fields' });
          }
          if (!supabaseAdmin || !upsertPhylloAccount) {
            return sendJson(res, 500, { ok: false, error: 'supabase_not_configured' });
          }
          let profile = {};
          try {
            const details = await getPhylloAccountDetails(accountId);
            profile = (details && details.data) || details || {};
          } catch (e) {
            console.warn('[Phyllo] getPhylloAccountDetails failed', e?.response?.data || e);
          }

          const { error } = await upsertPhylloAccount({
            userId: promptlyUserId,
            phylloUserId,
            platform: profile.platform || platform,
            accountId,
            workPlatformId,
            handle: profile.username || handle,
            displayName: profile.full_name || displayName,
            avatarUrl: profile.avatar_url || avatarUrl,
          });
          if (error) {
            console.error('[Phyllo] upsertPhylloAccount error', error);
            return sendJson(res, 500, { ok: false, error: 'db_error' });
          }
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          console.error('[Phyllo] account-connected route error', err);
          return sendJson(res, 500, { ok: false, error: 'server_error' });
        }
      })
      .catch((err) => {
        console.error('[Phyllo] account-connected parse error', err);
        sendJson(res, 500, { ok: false, error: 'parse_error' });
      });
    return;
  }

  if (parsed.pathname === '/api/phyllo/accounts' && req.method === 'GET') {
    (async () => {
      try {
        const promptlyUserId = req.user && req.user.id;
        if (!promptlyUserId || !supabaseAdmin) {
          return sendJson(res, 200, { ok: true, data: [] });
        }
        const { data, error } = await supabaseAdmin
          .from('phyllo_accounts')
          .select('*')
          .eq('user_id', promptlyUserId)
          .eq('status', 'connected');
        if (error) {
          return sendJson(res, 500, { ok: false, error: 'db_error' });
        }
        return sendJson(res, 200, { ok: true, data: data || [] });
      } catch (err) {
        console.error('[Phyllo] fetch accounts error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/data' && req.method === 'GET') {
    (async () => {
      try {
        const promptlyUserId = req.user && req.user.id;
        const isPro = isUserPro(req);
        if (!promptlyUserId || !supabaseAdmin) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        if (!isPro) {
          return analyticsUpgradeRequired(res);
        }

        const { data: accounts, error: accErr } = await supabaseAdmin
          .from('phyllo_accounts')
          .select('*')
          .eq('user_id', promptlyUserId)
          .eq('status', 'connected');

        if (accErr) {
          return sendJson(res, 500, { ok: false, error: 'db_error' });
        }

        const metrics = await getUserPostMetrics(accounts || []);
        const demographics = await getAudienceDemographics(accounts || []);
        const overview = {
          followerGrowth: metrics?.summary?.followerGrowth || 0,
          engagementRate: metrics?.summary?.engagementRate || 0,
          avgViewsPerPost: metrics?.summary?.avgViews || 0,
          retentionPct: metrics?.summary?.retention || 0,
        };
        await generateAlertsForUser(promptlyUserId, metrics);

        return sendJson(res, 200, {
          ok: true,
          data: {
            accounts: accounts || [],
            posts: metrics.posts || [],
            demographics,
            insights: [],
            alerts: [],
            overview,
          },
        });
      } catch (err) {
        console.error('[Analytics data] error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/phyllo/sync-posts' && req.method === 'POST') {
    (async () => {
      try {
        const promptlyUserId = req.user && req.user.id;
        if (!promptlyUserId || !supabaseAdmin) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }

        const { data: accounts, error: accErr } = await supabaseAdmin
          .from('phyllo_accounts')
          .select('*')
          .eq('user_id', promptlyUserId)
          .eq('status', 'connected');

        if (accErr) {
          console.error('[Phyllo] load accounts error', accErr);
          return sendJson(res, 500, { ok: false, error: 'db_error' });
        }

        if (!accounts || accounts.length === 0) {
          return sendJson(res, 200, { ok: true, syncedPosts: 0 });
        }

        let totalSynced = 0;

      for (const acc of accounts) {
        const postsResp = await getPhylloPosts(acc.account_id);
        const posts = postsResp.data || [];

          for (const p of posts) {
            const { data: postRows, error: postErr } = await upsertPhylloPost({
              phylloAccountId: acc.id,
              platform: acc.platform || p.platform,
              platformPostId: p.id,
              title: p.title || null,
              caption: p.caption || null,
              url: p.url || null,
              publishedAt: p.published_at || null,
            });

            if (postErr) {
              console.error('[Phyllo] upsertPhylloPost error', postErr);
              continue;
            }

            const postRow = Array.isArray(postRows) ? postRows[0] : postRows;
            if (!postRow || !postRow.id) continue;

            const metricsResp = await getPhylloPostMetrics(p.id);
            const m = metricsResp.data || {};

            const views = m.views || 0;
            const likes = m.likes || 0;
            const comments = m.comments || 0;
            const shares = m.shares || 0;
            const saves = m.saves || 0;
            const watchTimeSeconds = m.watch_time_seconds || 0;
            const retentionPct = m.retention_pct || null;

            const { error: metricsErr } = await insertPhylloPostMetrics({
              phylloPostId: postRow.id,
              capturedAt: new Date().toISOString(),
              views,
              likes,
              comments,
              shares,
              saves,
              watchTimeSeconds,
              retentionPct,
            });

            if (metricsErr) {
              console.error('[Phyllo] insertPhylloPostMetrics error', metricsErr);
              continue;
            }

            totalSynced += 1;
      }
    }

    // Demographics sync per account
    for (const acc of accounts) {
      try {
        const demoResp = await getAudienceDemographics(acc.phyllo_user_id);
        if (!demoResp) continue;
        const payload = demoResp.data || demoResp;
        const age_groups = payload.age_groups || payload.age || {};
        const countries = payload.countries || payload.location || {};
        const languages = payload.languages || payload.language || {};
        const genders = payload.genders || payload.gender || {};

        const { error: demoErr } = await supabaseAdmin.from('phyllo_demographics').upsert({
          user_id: promptlyUserId,
          phyllo_user_id: acc.phyllo_user_id,
          account_id: acc.account_id,
          platform: acc.platform || acc.work_platform_id || 'unknown',
          age_groups,
          countries,
          languages,
          genders,
          updated_at: new Date().toISOString(),
        });
        if (demoErr) {
          console.error('[Phyllo] demographics upsert error', demoErr);
        }
      } catch (err) {
        console.error('[Phyllo] demographics sync error', err);
      }
    }

    await updateCachedAnalyticsForUser(promptlyUserId);

    return sendJson(res, 200, { ok: true, syncedPosts: totalSynced });
  } catch (err) {
    console.error('[Phyllo] /api/phyllo/sync-posts error', err);
    return sendJson(res, 500, { ok: false, error: 'server_error' });
  }
    })();
    return;
  }

  if (parsed.pathname === '/api/phyllo/test-posts' && req.method === 'GET') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        if (!userId) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

        const { data: accounts } = await supabaseAdmin
          .from('phyllo_accounts')
          .select('*')
          .eq('user_id', userId)
          .eq('status', 'connected');

        if (!accounts || accounts.length === 0) {
          return sendJson(res, 200, { ok: true, data: [] });
        }

        const first = accounts[0];
        const posts = await getPhylloPosts(first.account_id);

        return sendJson(res, 200, { ok: true, data: posts.data || [] });
      } catch (err) {
        console.error('[Phyllo] test-posts error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/insights' && req.method === 'POST') {
    readJsonBody(req)
      .then(async (body) => {
        try {
          const userId = req.user && req.user.id;
          const isPro = isUserPro(req);
          if (!userId) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
          if (!OPENAI_API_KEY) return sendJson(res, 500, { ok: false, error: 'openai_not_configured' });

          const posts = Array.isArray(body?.posts) ? body.posts : null;
          if (!posts) {
            return sendJson(res, 400, { ok: false, error: 'invalid_posts_array' });
          }

          const promptText = `
You are an analytics engine. Analyze the following posts and produce 3 actionable insights with clear reasoning.

Posts JSON:
${JSON.stringify(posts, null, 2)}

Output format:
[
  { "title": "...", "detail": "..." },
  { "title": "...", "detail": "..." },
  { "title": "...", "detail": "..." }
]
`;

          const payload = JSON.stringify({
            model: process.env.OPENAI_MODEL_ANALYTICS || 'gpt-4o-mini',
            messages: [
              { role: 'system', content: 'You are an analytics assistant.' },
              { role: 'user', content: promptText },
            ],
            temperature: 0.4,
            max_tokens: 600,
          });

          const options = {
            hostname: 'api.openai.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
              Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
          };

          const completion = await openAIRequest(options, payload);
          const content = completion?.choices?.[0]?.message?.content || '';
          let insights = [];
          try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) insights = parsed;
          } catch (e) {
            insights = [{ title: 'Unable to parse model response', detail: content || 'No content' }];
          }

          if (!isPro && Array.isArray(insights)) {
            insights = insights.slice(0, 2);
          }

          if (supabaseAdmin) {
            try {
              await supabaseAdmin.from('analytics_insights').insert({
                user_id: userId,
                insights,
              });
            } catch (insertErr) {
              console.error('[Analytics insights] insert failed', insertErr);
            }
          }

          return sendJson(res, 200, { ok: true, insights });
        } catch (err) {
          console.error('[Analytics insights generation] error', err);
          return sendJson(res, 500, { ok: false, error: 'server_error' });
        }
      })
      .catch((err) => {
        console.error('[Analytics insights generation] parse error', err);
        sendJson(res, 500, { ok: false, error: 'parse_error' });
      });
    return;
  }

  if (parsed.pathname === '/api/analytics/overview' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      data: {
        followerGrowth: 1250,
        engagementRate: 0.072,
        avgViewsPerPost: 5400,
        retentionPct: 0.61,
      },
    });
  }

  // Deprecated demo heatmap (kept for reference, path changed to avoid matching)
  if (parsed.pathname === '/api/analytics/heatmap-demo' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, data: [] });
  }

  if (parsed.pathname === '/api/analytics/posts' && req.method === 'GET') {
    const isPro = isUserPro(req);
    if (!isPro) {
      return analyticsUpgradeRequired(res);
    }
    return sendJson(res, 200, {
      ok: true,
      data: [
        {
          id: 'mock-1',
          title: 'Top 3 Dribbling Drills',
          platform: 'TikTok',
          views: 12000,
          likes: 800,
          retentionPct: 0.68,
          shares: 30,
          saves: 45,
          url: 'https://tiktok.com/@demo/video/1',
          publishedAt: '2025-11-20T19:00:00Z',
        },
        {
          id: 'mock-2',
          title: 'IG Study Hack Reel',
          platform: 'Instagram',
          views: 5000,
          likes: 320,
          retentionPct: 0.72,
          shares: 18,
          saves: 60,
          url: 'https://instagram.com/p/demo2',
          publishedAt: '2025-11-21T16:00:00Z',
        },
      ],
    });
  }

  if (parsed.pathname === '/api/analytics/insights' && req.method === 'GET') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        const isPro = isUserPro(req);
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        const { data, error } = await supabaseAdmin
          .from('analytics_insights')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1);
        if (error) {
          return sendJson(res, 500, { ok: false, error: 'insights_fetch_failed' });
        }
        let insights = (data && data[0] && data[0].insights) || [];
        if (!isPro && Array.isArray(insights)) {
          insights = insights.slice(0, 2);
        }
        return sendJson(res, 200, { ok: true, insights });
      } catch (err) {
        console.error('[Analytics insights fetch] error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/engagement' && req.method === 'GET') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }

        const { data, error } = await supabaseAdmin
          .from('cached_analytics')
          .select('posts')
          .eq('user_id', userId)
          .single();

        if (error) {
          return sendJson(res, 500, { ok: false, error: 'engagement_fetch_failed' });
        }

        const days = getAnalyticsWindowDays(req);
        const posts = filterPostsByWindow(((data && data.posts) || []), days);
        if (!posts.length) return sendJson(res, 200, { ok: true, engagement: 0 });

        let totalViews = 0;
        let totalEngagement = 0;
        posts.forEach((p) => {
          totalViews += Number(p.views || 0);
          totalEngagement += Number(p.likes || 0) + Number(p.comments || 0) + Number(p.shares || 0);
        });

        const engagementRate = totalViews > 0 ? Number(((totalEngagement / totalViews) * 100).toFixed(2)) : 0;

        return sendJson(res, 200, { ok: true, engagement: engagementRate });
      } catch (err) {
        console.error('[Analytics engagement] error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/alerts' && req.method === 'GET') {
    (async () => {
      try {
        const promptlyUserId = req.user && req.user.id;
        if (!promptlyUserId || !supabaseAdmin) {
          return sendJson(res, 200, { ok: true, alerts: [] });
        }
        const days = getAnalyticsWindowDays(req);
        const since = getSinceDate(days).toISOString();
        const { data, error } = await supabaseAdmin
          .from('analytics_alerts')
          .select('*')
          .eq('user_id', promptlyUserId)
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(50);
        if (error) {
          return sendJson(res, 500, { ok: false, error: 'alerts_fetch_failed' });
        }
        return sendJson(res, 200, { ok: true, alerts: data || [] });
      } catch (err) {
        console.error('[Analytics alerts] fetch error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/report/latest' && req.method === 'GET') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }

        const { data, error } = await supabaseAdmin
          .from('analytics_growth_reports')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (error) {
          console.error('latest report fetch error', error);
          return sendJson(res, 500, { ok: false, error: 'internal_error' });
        }

        if (!data) {
          return sendJson(res, 404, { ok: false, error: 'not_found' });
        }

        return sendJson(res, 200, { ok: true, report: data });
      } catch (err) {
        console.error('latest report unexpected error', err);
        return sendJson(res, 500, { ok: false, error: 'internal_error' });
      }
    })();
    return;
  }

  // Stub overview to avoid 404s if frontend calls it
  if (parsed.pathname === '/api/analytics/overview' && req.method === 'GET') {
    (async () => {
      try {
        return sendJson(res, 200, { ok: true, data: null });
      } catch (err) {
        console.error('analytics overview error', err);
        return sendJson(res, 500, { ok: false, error: 'internal_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/experiments' && req.method === 'POST') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        const isPro = isUserPro(req);
        if (!isPro) {
          return analyticsUpgradeRequired(res);
        }
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        const { title, description } = await parseJson(req);
        if (!title || !description) {
          return sendJson(res, 400, { ok: false, error: 'missing_fields' });
        }
        const start = new Date();
        const end = new Date();
        end.setDate(end.getDate() + 7);
        const { data, error } = await supabaseAdmin
          .from('analytics_experiments')
          .insert({
            user_id: userId,
            title,
            description,
            status: 'active',
            start_date: start.toISOString().slice(0, 10),
            end_date: end.toISOString().slice(0, 10),
          })
          .select()
          .single();
        if (error) {
          return sendJson(res, 500, { ok: false, error: 'experiment_create_failed' });
        }
        return sendJson(res, 200, { ok: true, experiment: data });
      } catch (err) {
        console.error('[Analytics experiments create] error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/top-posts' && req.method === 'GET') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }

        const { data, error } = await supabaseAdmin
          .from('cached_analytics')
          .select('*')
          .eq('user_id', userId)
          .single();

        if (error) {
          return sendJson(res, 500, { ok: false, error: 'top_posts_fetch_failed' });
        }

        const postsRaw = (data && data.posts) || [];
        const days = getAnalyticsWindowDays(req);
        const posts = filterPostsByWindow(postsRaw, days);
        const sorted = posts
          .map((p) => ({
            ...p,
            score: (p.likes || 0) + (p.comments || 0) + (p.shares || 0),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);

        return sendJson(res, 200, { ok: true, posts: sorted });
      } catch (err) {
        console.error('[Analytics top posts] error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/heatmap' && req.method === 'GET') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }

        const { data, error } = await supabaseAdmin
          .from('cached_analytics')
          .select('*')
          .eq('user_id', userId)
          .single();

        if (error) {
          return sendJson(res, 500, { ok: false, error: 'heatmap_fetch_failed' });
        }

        const days = getAnalyticsWindowDays(req);
        const posts = filterPostsByWindow(((data && data.posts) || []), days);
        const heatmap = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));

        posts.forEach((p) => {
          if (!p.published_at && !p.publishedAt) return;
          const date = new Date(p.published_at || p.publishedAt);
          const day = date.getDay();
          const hour = date.getHours();
          const score = (p.likes || 0) + (p.comments || 0) + (p.shares || 0);
          if (day >= 0 && day < 7 && hour >= 0 && hour < 24) {
            heatmap[day][hour] += score;
          }
        });

        return sendJson(res, 200, { ok: true, heatmap });
      } catch (err) {
        console.error('[Analytics heatmap] error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/full' && req.method === 'GET') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 200, {
            ok: true,
            overview: null,
            posts: [],
            demographics: {},
            followers: [],
            insights: [],
            last_sync: null,
          });
        }

        const { data: overviewRow, error: overviewErr } = await supabaseAdmin
          .from('cached_analytics_overview')
          .select('*')
          .eq('user_id', userId)
          .maybeSingle();

        const { data: postsRows, error: postsErr } = await supabaseAdmin
          .from('cached_analytics_posts')
          .select('*')
          .eq('user_id', userId);

        const { data: demoRow, error: demoErr } = await supabaseAdmin
          .from('phyllo_demographics')
          .select('*')
          .eq('user_id', userId)
          .maybeSingle();

        const { data: insightsRows, error: insightsErr } = await supabaseAdmin
          .from('analytics_ai_insights')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false });

        const { data: syncRow } = await supabaseAdmin
          .from('analytics_sync_status')
          .select('*')
          .eq('user_id', userId)
          .maybeSingle();

        if (overviewErr || postsErr || demoErr || insightsErr) {
          console.error('[Analytics full] fetch error', overviewErr || postsErr || demoErr || insightsErr);
          return sendJson(res, 500, { ok: false, error: 'db_error' });
        }

        const overview =
          overviewRow && Object.keys(overviewRow).length > 0
            ? {
                follower_growth: overviewRow.follower_growth ?? null,
                avg_views: overviewRow.avg_views ?? null,
                engagement_rate: overviewRow.engagement_rate ?? null,
                retention: overviewRow.retention ?? null,
              }
            : null;

        const days = getAnalyticsWindowDays(req);
        const posts = filterPostsByWindow(postsRows || [], days);
        const demographics = demoRow
          ? {
              age_groups: demoRow.age_groups || {},
              genders: demoRow.genders || {},
              countries: demoRow.countries || {},
              languages: demoRow.languages || {},
            }
          : {
              age_groups: {},
              genders: {},
              countries: {},
              languages: {},
            };

        const insights = insightsRows || [];

        const hasData =
          (overview && Object.values(overview).some((v) => v != null)) ||
          (posts && posts.length) ||
          (demoRow && Object.keys(demographics.age_groups || {}).length) ||
          (insights && insights.length);

        if (!hasData) {
          return sendJson(res, 404, { ok: false, error: 'no_analytics' });
        }

        // Add a range label hint so the client can display the window used
        if (overview) {
          overview.rangeLabel = `Last ${days} days`;
        }

        return sendJson(res, 200, {
          ok: true,
          overview,
          posts,
          demographics,
          insights,
          last_sync: syncRow?.last_sync || null,
        });
      } catch (err) {
        console.error('[Analytics full] error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/followers' && req.method === 'GET') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 200, { ok: true, trends: [] });
        }

        const { data, error } = await supabaseAdmin
          .from('cached_analytics')
          .select('*')
          .eq('user_id', userId)
          .single();

        if (error) {
          return sendJson(res, 500, { ok: false, error: 'followers_fetch_failed' });
        }

        const trends = (data && data.followers) || [];
        const days = getAnalyticsWindowDays(req);
        const limited = filterSeriesByWindow(trends, days);
        const sorted = limited.sort((a, b) => new Date(a.date) - new Date(b.date));

        return sendJson(res, 200, { ok: true, trends: sorted });
      } catch (err) {
        console.error('[Analytics followers] error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/demographics' && req.method === 'GET') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 200, { ok: true, demographics: {} });
        }

        const { data, error } = await supabaseAdmin
          .from('cached_analytics')
          .select('demographics')
          .eq('user_id', userId)
          .single();

        if (error) {
          return sendJson(res, 500, { ok: false, error: 'demographics_fetch_failed' });
        }

        return sendJson(res, 200, {
          ok: true,
          demographics:
            (data && data.demographics) || { age: {}, gender: {}, location: {}, language: {} },
        });
      } catch (err) {
        console.error('[Analytics demographics] error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/sync-status' && req.method === 'GET') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 200, {
            ok: true,
            status: {
              last_sync: null,
              status: 'never',
              message: null,
            },
          });
        }
        const { data, error } = await supabaseAdmin
          .from('analytics_sync_status')
          .select('*')
          .eq('user_id', userId)
          .single();
        if (error) {
          return sendJson(res, 200, {
            ok: true,
            status: {
              last_sync: null,
              status: 'never',
              message: null,
            },
          });
        }
        return sendJson(res, 200, { ok: true, status: data });
      } catch (err) {
        console.error('[Analytics sync status] error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/phyllo/sync-audience' && req.method === 'POST') {
    (async () => {
      try {
        const { user_id } = await parseJson(req);
        if (!user_id) {
          return sendJson(res, 400, { ok: false, error: 'missing_user_id' });
        }
        const result = await syncAudience(user_id);
        return sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        console.error('[Phyllo] sync-audience error', err);
        return sendJson(res, 500, { ok: false, error: 'phyllo_sync_audience_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/phyllo/sync-followers' && req.method === 'POST') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        const result = await syncFollowerMetrics(userId);

        // Update cached analytics with new followers; preserve other fields if present
        const { data: existing } = await supabaseAdmin
          .from('cached_analytics')
          .select('posts, demographics, overview')
          .eq('user_id', userId)
          .single();

        await supabaseAdmin
          .from('cached_analytics')
          .upsert({
            user_id: userId,
            followers: (result && result.followerSeries) || [],
            posts: existing?.posts || [],
            demographics: existing?.demographics || {},
            overview: existing?.overview || {},
            updated_at: new Date().toISOString(),
          });

        return sendJson(res, 200, { ok: true, updated: result.total || 0 });
      } catch (err) {
        console.error('[Phyllo] sync-followers error', err);
        return sendJson(res, 500, { ok: false, error: 'phyllo_sync_followers_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/phyllo/sync-demographics' && req.method === 'POST') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        // Load connected accounts
        const { data: accounts, error: accErr } = await supabaseAdmin
          .from('phyllo_accounts')
          .select('*')
          .eq('user_id', userId)
          .eq('status', 'connected');

        if (accErr) {
          console.error('[Phyllo] sync-demographics accounts error', accErr);
          return sendJson(res, 500, { ok: false, error: 'db_error' });
        }

        if (!accounts || !accounts.length) {
          return sendJson(res, 200, { ok: true, demographics: {} });
        }

        for (const acc of accounts) {
          try {
            const audience = await getAudienceDemographics(acc.phyllo_user_id || acc.creator_id ? [{ creator_id: acc.creator_id, platform: acc.platform, work_platform_id: acc.work_platform_id }] : []);
            const payload = audience && audience[0] ? audience[0].audience || {} : {};

            const age_groups = payload.age || payload.age_groups || {};
            const countries = payload.location || payload.countries || {};
            const languages = payload.language || payload.languages || {};
            const genders = payload.gender || payload.genders || {};

            const { error: upsertErr } = await supabaseAdmin.from('phyllo_demographics').upsert({
              user_id: userId,
              phyllo_user_id: acc.phyllo_user_id,
              account_id: acc.account_id,
              platform: acc.platform || acc.work_platform_id || 'unknown',
              age_groups,
              countries,
              languages,
              genders,
              updated_at: new Date().toISOString(),
            });

            if (upsertErr) {
              console.error('[Phyllo] demographics upsert error', upsertErr);
            }
          } catch (err) {
            console.error('[Phyllo] sync-demographics per-account error', err);
          }
        }

        return sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error('[Phyllo] sync-demographics error', err);
        return sendJson(res, 500, { ok: false, error: 'phyllo_sync_demographics_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/sync-status/update' && req.method === 'POST') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        const { status, message } = await parseJson(req);
        const { error } = await supabaseAdmin.from('analytics_sync_status').upsert({
          user_id: userId,
          last_sync: new Date().toISOString(),
          status,
          message,
        });
        if (error) {
          return sendJson(res, 500, { ok: false, error: 'sync_update_failed' });
        }
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error('[Analytics sync status update] error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/experiments' && req.method === 'GET') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        const isPro = isUserPro(req);
        if (!isPro) {
          return analyticsUpgradeRequired(res);
        }
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 200, { ok: true, experiments: [] });
        }
        const { data, error } = await supabaseAdmin
          .from('analytics_experiments')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false });
        if (error) {
          return sendJson(res, 500, { ok: false, error: 'experiment_fetch_failed' });
        }
        return sendJson(res, 200, { ok: true, experiments: data || [] });
      } catch (err) {
        console.error('[Analytics experiments fetch] error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname.startsWith('/api/analytics/experiments/') && req.method === 'PATCH') {
    // Specific complete endpoint
    if (parsed.pathname.endsWith('/complete')) {
      (async () => {
        try {
          const userId = req.user && req.user.id;
          const isPro = isUserPro(req);
          if (!isPro) {
            return analyticsUpgradeRequired(res);
          }
          if (!userId || !supabaseAdmin) {
            return sendJson(res, 401, { ok: false, error: 'unauthorized' });
          }
          const segments = parsed.pathname.split('/');
          const id = segments[segments.length - 2];
          if (!id) {
            return sendJson(res, 400, { ok: false, error: 'missing_id' });
          }
          const { data, error } = await supabaseAdmin
            .from('analytics_experiments')
            .update({ status: 'completed', end_date: new Date().toISOString() })
            .eq('id', id)
            .eq('user_id', userId)
            .select('*')
            .single();
          if (error) return sendJson(res, 500, { ok: false, error: 'update_failed' });
          return sendJson(res, 200, { ok: true, experiment: data });
        } catch (err) {
          console.error('[Analytics experiments complete] error', err);
          return sendJson(res, 500, { ok: false, error: 'server_error' });
        }
      })();
      return;
    }

    (async () => {
      try {
        const userId = req.user && req.user.id;
        const isPro = isUserPro(req);
        if (!isPro) {
          return analyticsUpgradeRequired(res);
        }
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        const id = parsed.pathname.split('/').pop();
        if (!id) {
          return sendJson(res, 400, { ok: false, error: 'missing_id' });
        }
        const { data, error } = await supabaseAdmin
          .from('analytics_experiments')
          .update({ status: 'completed' })
          .eq('id', id)
          .eq('user_id', userId)
          .select()
          .single();
        if (error) {
          return sendJson(res, 500, { ok: false, error: 'experiment_update_failed' });
        }
        return sendJson(res, 200, { ok: true, experiment: data });
      } catch (err) {
        console.error('[Analytics experiments update] error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname.startsWith('/api/analytics/experiments/') && req.method === 'DELETE') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        const isPro = isUserPro(req);
        if (!isPro) {
          return analyticsUpgradeRequired(res);
        }
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        const id = parsed.pathname.split('/').pop();
        if (!id) {
          return sendJson(res, 400, { ok: false, error: 'missing_id' });
        }
        const { error } = await supabaseAdmin
          .from('analytics_experiments')
          .delete()
          .eq('id', id)
          .eq('user_id', userId);

        if (error) {
          return sendJson(res, 500, { ok: false, error: 'delete_failed' });
        }

        return sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error('[Analytics experiments delete] error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/reports' && req.method === 'POST') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        const isPro = isUserPro(req);
        if (!isPro) {
          return analyticsUpgradeRequired(res);
        }
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }

        const { data: analyticsData } = await supabaseAdmin
          .from('cached_analytics')
          .select('*')
          .eq('user_id', userId)
          .single();

        const { data: insightsRows } = await supabaseAdmin
          .from('analytics_insights')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1);

        const { data: alertsRows } = await supabaseAdmin
          .from('analytics_alerts')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(10);

        const report = await buildWeeklyReport({
          posts: (analyticsData && analyticsData.posts) || [],
          overview: (analyticsData && analyticsData.overview) || {},
          insights: (insightsRows && insightsRows[0] && insightsRows[0].insights) || [],
          alerts: alertsRows || [],
          isPro,
        });

        const { error } = await supabaseAdmin
          .from('analytics_reports')
          .insert({
            user_id: userId,
            report,
          });

        if (error) {
          return sendJson(res, 500, { ok: false, error: 'report_create_failed' });
        }

        return sendJson(res, 200, { ok: true, report });
      } catch (err) {
        console.error('[Analytics reports create] error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/reports/latest' && req.method === 'GET') {
    (async () => {
      try {
        const userId = req.user && req.user.id;
        const isPro = isUserPro(req);
        if (!isPro) {
          return analyticsUpgradeRequired(res);
        }
        if (!userId || !supabaseAdmin) {
          return sendJson(res, 200, { ok: true, report: null });
        }

        const { data, error } = await supabaseAdmin
          .from('analytics_reports')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1);

        if (error) {
          return sendJson(res, 500, { ok: false, error: 'report_fetch_failed' });
        }

        return sendJson(res, 200, { ok: true, report: (data && data[0] && data[0].report) || null });
      } catch (err) {
        console.error('[Analytics reports fetch] error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/accounts' && req.method === 'GET') {
    (async () => {
      try {
        const userId = (req.user && req.user.id) || null;
        if (!userId || !supabaseAdmin) return sendJson(res, 200, { ok: true, data: [] });
        const { data: accounts, error: accountsError } = await supabaseAdmin
          .from('phyllo_accounts')
          .select('work_platform_id, username, profile_name, avatar_url')
          .eq('promptly_user_id', userId);
        if (accountsError) {
          console.error('[Analytics accounts] error', accountsError);
          return sendJson(res, 500, { error: 'accounts_failed' });
        }
        const mapped = (accounts || []).map((a) => ({
          platform: a.work_platform_id,
          username: a.username,
          profile_name: a.profile_name,
          avatar_url: a.avatar_url || null,
        }));
        sendJson(res, 200, mapped);
      } catch (err) {
        console.error('[Analytics accounts] error', err);
        sendJson(res, 500, { error: 'accounts_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/overview' && req.method === 'GET') {
    (async () => {
      try {
        const userId = (req.user && req.user.id) || null;
        if (!userId || !supabaseAdmin) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const plan = (req.user && req.user.plan) || 'free';
        const windowDays = plan === 'pro' || plan === 'teams' ? 365 : 30;
        const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
        let accountsQuery = supabaseAdmin.from('phyllo_accounts').select('*').eq('promptly_user_id', userId);
        const { data: accounts } = await accountsQuery;
        const accountIds = (accounts || []).map((a) => a.phyllo_account_id);
        if (!accountIds.length) {
          sendJson(res, 200, { followers_total: 0, followers_growth_30d: 0, avg_engagement_rate: 0, retention_rate: 0 });
          return;
        }
        const limitedAccounts = plan === 'free' ? accountIds.slice(0, 1) : accountIds;
        const { data: daily } = await supabaseAdmin
          .from('phyllo_account_daily')
          .select('*')
          .in('phyllo_account_id', limitedAccounts)
          .gte('date', since.toISOString().slice(0, 10));
        if (!daily || !daily.length) {
          sendJson(res, 200, { follower_growth: 0, engagement_rate: 0, avg_views_per_post: 0, retention_pct: 0 });
          return;
        }
        const latestByAccount = {};
        const earliestByAccount = {};
        daily.forEach((row) => {
          const key = row.phyllo_account_id;
          if (!latestByAccount[key] || new Date(row.date) > new Date(latestByAccount[key].date)) latestByAccount[key] = row;
          if (!earliestByAccount[key] || new Date(row.date) < new Date(earliestByAccount[key].date)) earliestByAccount[key] = row;
        });
        const followersTotal = Object.values(latestByAccount).reduce((sum, r) => sum + Number(r.followers || 0), 0);
        const followersPast = Object.values(earliestByAccount).reduce((sum, r) => sum + Number(r.followers || 0), 0);
        const followersGrowth = followersTotal - followersPast;
        const engagementRates = daily.map((r) => Number(r.engagement_rate || 0)).filter((n) => !isNaN(n));
        const avgEngagement = engagementRates.length ? engagementRates.reduce((a, b) => a + b, 0) / engagementRates.length : 0;
        const retentionRate = followersPast ? followersTotal / followersPast : 0;
        // avg views per post (last windowDays)
        let avgViewsPerPost = null;
        const { data: postsWindow } = await supabaseAdmin
          .from('phyllo_posts')
          .select('phyllo_content_id, promptly_user_id, platform')
          .eq('promptly_user_id', userId)
          .gte('published_at', since.toISOString());
        const postIds = (postsWindow || []).map((p) => p.phyllo_content_id);
        if (postIds.length) {
          const { data: metricsWindow } = await supabaseAdmin
            .from('phyllo_post_metrics')
            .select('*')
            .in('phyllo_content_id', postIds)
            .order('collected_at', { ascending: false });
          const latestMetrics = {};
          (metricsWindow || []).forEach((m) => {
            if (!latestMetrics[m.phyllo_content_id]) latestMetrics[m.phyllo_content_id] = m;
          });
          const viewsArray = Object.values(latestMetrics).map((m) => Number(m.views || 0));
          if (viewsArray.length) {
            const totalViews = viewsArray.reduce((a, b) => a + b, 0);
            avgViewsPerPost = totalViews / viewsArray.length;
          }
        }
        sendJson(res, 200, {
          ok: true,
          data: {
            follower_growth: followersGrowth,
            engagement_rate: avgEngagement,
            avg_views_per_post: avgViewsPerPost,
            retention_pct: retentionRate,
          },
        });
      } catch (err) {
        console.error('[Analytics overview] error', err);
        sendJson(res, 500, { error: 'analytics_overview_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/heatmap' && req.method === 'GET') {
    (async () => {
      try {
        const userId = (req.user && req.user.id) || null;
        const isPro = isUserPro(req);
        if (!isPro) {
          return analyticsUpgradeRequired(res);
        }
        if (!userId || !supabaseAdmin) return sendJson(res, 401, { error: 'unauthorized' });
        const plan = (req.user && req.user.plan) || 'free';
        const windowDays = plan === 'pro' || plan === 'teams' ? 365 : 30;
        const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
        const { data: posts } = await supabaseAdmin
          .from('phyllo_posts')
          .select('phyllo_content_id,published_at')
          .eq('promptly_user_id', userId)
          .gte('published_at', since.toISOString());
        if (!posts || !posts.length) return sendJson(res, 200, { ok: true, data: [] });
        const ids = posts.map((p) => p.phyllo_content_id);
        const { data: metrics } = await supabaseAdmin
          .from('phyllo_post_metrics')
          .select('*')
          .in('phyllo_content_id', ids)
          .order('collected_at', { ascending: false });
        const latest = {};
        (metrics || []).forEach((m) => {
          if (!latest[m.phyllo_content_id]) latest[m.phyllo_content_id] = m;
        });
        const buckets = {};
        posts.forEach((p) => {
          if (!p.published_at) return;
          const m = latest[p.phyllo_content_id] || {};
          const engagement = Number(m.likes || 0) + Number(m.comments || 0) + Number(m.shares || 0) + Number(m.saves || 0);
          const dt = new Date(p.published_at);
          const day = dt.getUTCDay();
          const hour = dt.getUTCHours();
          const key = `${day}-${hour}`;
          if (!buckets[key]) buckets[key] = { day, hour, engagement: 0 };
          buckets[key].engagement += engagement;
        });
        const data = Object.values(buckets).sort((a, b) => a.day - b.day || a.hour - b.hour);
        sendJson(res, 200, { ok: true, data });
      } catch (err) {
        console.error('[Analytics heatmap] error', err);
        sendJson(res, 500, { error: 'analytics_heatmap_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/posts' && req.method === 'GET') {
    (async () => {
      try {
        const userId = (req.user && req.user.id) || null;
        const isPro = isUserPro(req);
        if (!isPro) {
          return analyticsUpgradeRequired(res);
        }
        if (!userId || !supabaseAdmin) return sendJson(res, 401, { error: 'unauthorized' });
        const plan = (req.user && req.user.plan) || 'free';
        const windowDays = plan === 'pro' || plan === 'teams' ? 365 : 30;
        const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
        const limit = Math.min(parseInt(parsed.query?.limit, 10) || 50, 200);
        const offset = parseInt(parsed.query?.offset, 10) || 0;
        const { data: posts } = await supabaseAdmin
          .from('phyllo_posts')
          .select('*')
          .eq('promptly_user_id', userId)
          .gte('published_at', since.toISOString())
          .order('published_at', { ascending: false })
          .range(offset, offset + limit - 1);
        const ids = (posts || []).map((p) => p.phyllo_content_id);
        if (!ids.length) return sendJson(res, 200, { ok: true, data: [] });
        const { data: metrics } = await supabaseAdmin
          .from('phyllo_post_metrics')
          .select('*')
          .in('phyllo_content_id', ids)
          .order('collected_at', { ascending: false });
        const latest = {};
        (metrics || []).forEach((m) => {
          if (!latest[m.phyllo_content_id]) latest[m.phyllo_content_id] = m;
        });
        const result = (posts || []).map((p) => {
          const m = latest[p.phyllo_content_id] || {};
          const engagement = Number(m.views || 0) > 0
            ? ((Number(m.likes || 0) + Number(m.comments || 0) + Number(m.shares || 0) + Number(m.saves || 0)) / Number(m.views || 1))
            : 0;
          return {
            id: p.id,
            platform: p.platform,
            title: p.title,
            views: Number(m.views || 0),
            likes: Number(m.likes || 0),
            retention: m.retention != null ? Number(m.retention) : null,
            shares: Number(m.shares || 0),
            saves: Number(m.saves || 0),
            engagement_rate: engagement,
            published_at: p.published_at,
            post_url: p.url || null,
          };
        });
        sendJson(res, 200, { ok: true, data: result, total: result.length, limit, offset });
      } catch (err) {
        console.error('[Analytics posts] error', err);
        sendJson(res, 500, { error: 'analytics_posts_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/internal/phyllo/sync' && req.method === 'POST') {
    (async () => {
      const token = req.headers['x-internal-token'] || '';
      if (!process.env.INTERNAL_SYNC_TOKEN || token !== process.env.INTERNAL_SYNC_TOKEN) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (!supabaseAdmin) {
        sendJson(res, 500, { error: 'supabase_not_configured' });
        return;
      }
      try {
        const { data: accounts } = await supabaseAdmin.from('phyllo_accounts').select('*');
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const until = new Date();
        for (const acct of accounts || []) {
          try {
            const contents = await fetchAccountContents({ accountId: acct.phyllo_account_id, since, until });
            const engagement = await fetchAccountEngagement({ accountId: acct.phyllo_account_id, since, until });
            const items = contents?.data || contents?.items || contents || [];
            const metricsByDay = {};
            for (const item of items) {
              const contentId = item.id || item.content_id;
              if (!contentId) continue;
              const platform = item.platform || acct.work_platform_id || 'unknown';
              const publishedAt = item.published_at || item.posted_at || item.created_at || null;
              await supabaseAdmin.from('phyllo_posts').upsert({
                phyllo_content_id: contentId,
                phyllo_account_id: acct.phyllo_account_id,
                promptly_user_id: acct.promptly_user_id,
                platform,
                title: item.title || item.caption || null,
                caption: item.caption || null,
                url: item.url || item.link || null,
                published_at: publishedAt,
              }, { onConflict: 'phyllo_content_id' });
              const metrics = item.metrics || item.stats || item;
              const views = Number(metrics.views || metrics.impressions || 0);
              const likes = Number(metrics.likes || 0);
              const comments = Number(metrics.comments || 0);
              const shares = Number(metrics.shares || metrics.reposts || 0);
              const saves = Number(metrics.saves || 0);
              await supabaseAdmin.from('phyllo_post_metrics').insert({
                phyllo_content_id: contentId,
                collected_at: new Date().toISOString(),
                views,
                likes,
                comments,
                shares,
                saves,
              });
              const dateKey = (publishedAt ? new Date(publishedAt) : new Date()).toISOString().slice(0, 10);
              if (!metricsByDay[dateKey]) metricsByDay[dateKey] = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 };
              metricsByDay[dateKey].views += views;
              metricsByDay[dateKey].likes += likes;
              metricsByDay[dateKey].comments += comments;
              metricsByDay[dateKey].shares += shares;
              metricsByDay[dateKey].saves += saves;
            }
            const engagementData = engagement?.data || engagement?.items || engagement || [];
            engagementData.forEach((row) => {
              const dateKey = row.date || row.day || row.collected_at;
              if (!dateKey) return;
              if (!metricsByDay[dateKey]) metricsByDay[dateKey] = {};
              metricsByDay[dateKey].followers = Number(row.followers || metricsByDay[dateKey].followers || 0);
              metricsByDay[dateKey].impressions = Number(row.impressions || metricsByDay[dateKey].impressions || 0);
              metricsByDay[dateKey].engagement_rate = Number(row.engagement_rate || metricsByDay[dateKey].engagement_rate || 0);
            });
            for (const [dateKey, agg] of Object.entries(metricsByDay)) {
              await supabaseAdmin.from('phyllo_account_daily').upsert({
                phyllo_account_id: acct.phyllo_account_id,
                date: dateKey,
                followers: agg.followers || null,
                impressions: agg.impressions || agg.views || null,
                engagement_rate: agg.engagement_rate || null,
              }, { onConflict: 'phyllo_account_id,date' });
            }
          } catch (err) {
            console.error('[Phyllo Sync] account failed', acct.phyllo_account_id, err?.response?.data || err);
          }
        }
        sendJson(res, 200, { ok: true, accounts: (accounts || []).length });
      } catch (err) {
        console.error('[Phyllo Sync] error', err);
        sendJson(res, 500, { error: 'sync_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/internal/analytics/insights' && req.method === 'POST') {
    (async () => {
      const token = req.headers['x-internal-token'] || '';
      if (!process.env.INTERNAL_SYNC_TOKEN || token !== process.env.INTERNAL_SYNC_TOKEN) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (!supabaseAdmin || !OPENAI_API_KEY) {
        sendJson(res, 500, { error: 'missing_openai_or_supabase' });
        return;
      }
      try {
        const { data: users } = await supabaseAdmin
          .from('phyllo_posts')
          .select('promptly_user_id')
          .not('promptly_user_id', 'is', null);
        const userIds = Array.from(new Set((users || []).map((r) => r.promptly_user_id))).filter(Boolean);
        const weekStart = (() => {
          const d = new Date();
          const day = d.getUTCDay();
          const diff = (day === 0 ? -6 : 1) - day;
          d.setUTCDate(d.getUTCDate() + diff);
          d.setUTCHours(0, 0, 0, 0);
          return d.toISOString().slice(0, 10);
        })();

        for (const userId of userIds) {
          try {
            const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const { data: posts } = await supabaseAdmin
              .from('phyllo_posts')
              .select('*')
              .eq('promptly_user_id', userId)
              .gte('published_at', since.toISOString());
            if (!posts || !posts.length) continue;
            const ids = posts.map((p) => p.phyllo_content_id);
            const { data: metrics } = await supabaseAdmin
              .from('phyllo_post_metrics')
              .select('*')
              .in('phyllo_content_id', ids)
              .order('collected_at', { ascending: false });
            const latest = {};
            (metrics || []).forEach((m) => {
              if (!latest[m.phyllo_content_id]) latest[m.phyllo_content_id] = m;
            });
            const payload = {
              posts: posts.map((p) => {
                const m = latest[p.phyllo_content_id] || {};
                return {
                  platform: p.platform,
                  views: Number(m.views || 0),
                  likes: Number(m.likes || 0),
                  comments: Number(m.comments || 0),
                  shares: Number(m.shares || 0),
                  saves: Number(m.saves || 0),
                  published_at: p.published_at,
                  title: p.title,
                  caption: p.caption,
                };
              }),
            };
            const prompt = [
              { role: 'system', content: 'You are an analytics assistant for content creators.' },
              {
                role: 'user',
                content: `Analyze these posts and return JSON { "summary": string, "recommendations": [ { "title": string, "description": string } ] }. Data: ${JSON.stringify(payload)}`,
              },
            ];
            const payloadJson = JSON.stringify({
              model: process.env.OPENAI_MODEL_ANALYTICS || 'gpt-4o-mini',
              messages: prompt,
              temperature: 0.4,
              max_tokens: 800,
            });
            const options = {
              hostname: 'api.openai.com',
              path: '/v1/chat/completions',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payloadJson),
                Authorization: `Bearer ${OPENAI_API_KEY}`,
              },
            };
            const completion = await openAIRequest(options, payloadJson);
            const content = completion.choices?.[0]?.message?.content || '';
            let summary = '';
            let recommendations = [];
            try {
              const parsed = JSON.parse(content);
              summary = parsed.summary || content;
              recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
            } catch (e) {
              summary = content;
            }
            await supabaseAdmin.from('growth_insights').upsert({
              promptly_user_id: userId,
              week_start: weekStart,
              summary: summary || 'No insights generated.',
              recommendations,
            }, { onConflict: 'promptly_user_id,week_start' });
          } catch (err) {
            console.error('[Insights] user failed', userId, err?.response?.data || err);
          }
        }
        sendJson(res, 200, { ok: true, users: userIds.length });
      } catch (err) {
        console.error('[Insights] error', err);
        sendJson(res, 500, { error: 'insights_failed' });
      }
    })();
    return;
  }

  if (isBrandKitPath(normalizedPath) && (req.method === 'POST' || req.method === 'GET')) {
    res.writeHead(410, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Brand Design has been removed.' }));
    return;
  }

  if (parsed.pathname === '/api/brand/ingest' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { userId, text } = JSON.parse(body || '{}');
        if (!userId || !text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'userId and text required' }));
        }
        if (!OPENAI_API_KEY) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'OPENAI_API_KEY not set' }));
        }
        const chunks = chunkText(text);
        const embeddings = await embedTextList(chunks);
        const stored = chunks.map((t, i) => ({ id: i + 1, text: t, embedding: embeddings[i] }));
        const saved = saveBrand(userId, stored);
        // Also persist the raw text to Supabase for durability
        try {
          await upsertBrandBrainPreference(userId, text);
        } catch (err) {
          console.warn('[BrandBrain] preference upsert skipped', err?.message || err);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, chunks: saved.chunks.length }));
      } catch (err) {
        console.error('Brand ingest error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/brand/profile' && req.method === 'GET') {
    (async () => {
      try {
        const userId = parsed.query.userId;
        if (!userId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'userId required' }));
        }
        // Prefer Supabase-backed preference, fall back to legacy file store
        const dbPref = await fetchBrandBrainPreference(userId);
        const brand = loadBrand(userId);
        const textFromFile = extractBrandVoiceText(brand);
        const text = (dbPref?.text || textFromFile || '').trim();
        const updatedAt = dbPref?.updatedAt || brand?.updatedAt || null;
        const chunksCount = Array.isArray(brand?.chunks) ? brand.chunks.length : 0;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            ok: true,
            hasProfile: !!text,
            chunks: chunksCount,
            text,
            updatedAt,
          })
        );
      } catch (err) {
        console.error('Brand profile error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: String(err) }));
      }
    })();
    return;
  }

  // Handle clean URLs (e.g., /success -> /success.html)
  let safePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  let filePath = path.join(__dirname, path.normalize(safePath));

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Forbidden' }));
  }

    fs.stat(filePath, (err, stats) => {
      // If file not found and no extension, try adding .html
      if (err && !path.extname(safePath)) {
        safePath = safePath + '.html';
        filePath = path.join(__dirname, path.normalize(safePath));
        
        if (!filePath.startsWith(__dirname)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Forbidden' }));
        }
        
        fs.stat(filePath, (err2, stats2) => {
          if (err2 || !stats2.isFile()) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Not found' }));
          }
          serveFile(filePath, res);
        });
        return;
      }
      
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Not found' }));
      }

      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css',
        '.js': 'text/javascript',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.ico': 'image/x-icon',
      };

      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const headers = { 'Content-Type': contentType };
      if (ext === '.html') headers['Cache-Control'] = 'no-store';
      else if (ext === '.js' || ext === '.css') headers['Cache-Control'] = 'public, max-age=300';
      else headers['Cache-Control'] = 'public, max-age=86400';
      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(res);
    });
  } catch (err) {
    const requestId = generateRequestId('handler');
    logServerError('http_request_error', err, {
      method: req.method,
      path: req.url,
      requestId,
    });
    respondWithServerError(res, err, { requestId });
  }
});

function serveFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';
  const headers = { 'Content-Type': contentType };
  if (ext === '.html') headers['Cache-Control'] = 'no-store';
  else if (ext === '.js' || ext === '.css') headers['Cache-Control'] = 'public, max-age=300';
  else headers['Cache-Control'] = 'public, max-age=86400';
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

const PORT = process.env.PORT || 8000;

if (require.main === module) {
  // Daily analytics sync (06:00 America/Los_Angeles)
  cron.schedule(
    '0 6 * * *',
    async () => {
      console.log('[Cron] Daily analytics sync started');
      try {
        const { data: rows, error } = await supabaseAdmin
          .from('phyllo_accounts')
          .select('user_id')
          .eq('status', 'connected');

        if (error || !rows || !rows.length) {
          console.error('[Cron] No accounts or error:', error);
          return;
        }

        const userIds = [...new Set(rows.map((r) => r.user_id))];

        for (const userId of userIds) {
          try {
            console.log('[Cron] Sync user', userId);
            await syncFollowerMetrics(userId);
            await syncDemographics(userId);
            await updateCachedAnalyticsForUser(userId);
            await supabaseAdmin.from('analytics_sync_status').upsert({
              user_id: userId,
              last_sync: new Date().toISOString(),
              status: 'success',
              message: 'Daily cron sync completed',
            });
          } catch (userErr) {
            console.error('[Cron] Error syncing user', userId, userErr);
            await supabaseAdmin.from('analytics_sync_status').upsert({
              user_id: userId,
              last_sync: new Date().toISOString(),
              status: 'failed',
              message: 'Daily cron sync failed',
            });
          }
        }

        console.log('[Cron] Daily analytics sync finished');
      } catch (err) {
        console.error('[Cron] Fatal error in daily analytics sync', err);
      }
    },
    {
      timezone: 'America/Los_Angeles',
    }
  );

  server.listen(PORT, () => console.log(`Promptly server running on http://localhost:${PORT}`));

  process.on('uncaughtException', (err) => console.error('Uncaught:', err));
  process.on('unhandledRejection', (r) => console.error('Unhandled rejection:', r));
}

module.exports = {
  ensurePinnedFieldsValid,
  dedupePinnedComments,
  buildPrompt,
};

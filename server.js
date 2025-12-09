const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const promptPresets = require('./assets/prompt-presets.json');
const JSZip = require('jszip');
const { supabaseAdmin, getDesignAssetById, updateDesignAsset, createDesignAsset } = require('./services/supabase-admin');
const { advanceDesignAssetPipeline } = require('./advanceDesignAssetPipeline');
const {
  uploadAssetFromUrl,
  buildCloudinaryUrl,
  isCloudinaryConfigured,
  generateBrandedBackgroundImage,
} = require('./services/cloudinary');
const { getBrandBrainForUser } = require('./services/brand-brain');
const { createPhylloUser, createSdkToken, fetchAccountContents, fetchAccountEngagement } = require('./services/phyllo');
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

if (!OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set.');
}
if (!STABILITY_API_KEY) {
  console.warn('Warning: STABILITY_API_KEY is not set. /api/design/generate will return 501.');
}
if (!STORY_TEMPLATE_ID) {
  console.warn('Warning: PLACID_STORY_TEMPLATE_ID is not set. Story assets will fail to render.');
}
if (!CAROUSEL_TEMPLATE_ID) {
  console.warn('Warning: PLACID_CAROUSEL_TEMPLATE_ID is not set. Carousel assets will fail to render.');
}
console.log('[Placid config]', {
  STORY_TEMPLATE_ID: STORY_TEMPLATE_ID ? '[set]' : '[missing]',
  CAROUSEL_TEMPLATE_ID: CAROUSEL_TEMPLATE_ID ? '[set]' : '[missing]',
});
validatePlacidTemplateConfig().catch((err) => {
  console.error('[Placid] Template validation failed', err);
});

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
    if (assetRow.status === 'rendering' || assetRow.status === 'queued') {
      try {
        await advanceDesignAssetPipeline();
        const refreshed = await getDesignAssetById(assetId, user.id);
        if (refreshed) assetRow = refreshed;
      } catch (pipelineError) {
        console.warn('Design asset inline pipeline tick failed', pipelineError?.message || pipelineError);
      }
    }
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


function openAIRequest(options, payload, retryCount = 0) {
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
            if ((res.statusCode === 502 || res.statusCode === 503 || res.statusCode === 504) && retryCount < 3) {
              const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
              console.log(`OpenAI ${res.statusCode} error, retrying in ${delay}ms (attempt ${retryCount + 1}/3)...`);
              setTimeout(() => {
                openAIRequest(options, payload, retryCount + 1).then(resolve).catch(reject);
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
      if (retryCount < 3) {
        const delay = Math.pow(2, retryCount) * 1000;
        console.log(`OpenAI network error, retrying in ${delay}ms (attempt ${retryCount + 1}/3)...`, err.message);
        setTimeout(() => {
          openAIRequest(options, payload, retryCount + 1).then(resolve).catch(reject);
        }, delay);
      } else {
        reject(err);
      }
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// Generic sanitizer + parse attempts for LLM JSON array output.
// Returns { data, attempts } where data is parsed array (or object wrapped into array) and attempts is diagnostics.
function parseLLMArray(rawContent, { requireArray = true, itemValidate } = {}) {
  const diagnostics = { rawLength: rawContent.length, attempts: [] };
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
  const truncated = raw.slice(0, 500);
  const msg = 'Failed to parse JSON after attempts: ' + (lastErr && lastErr.message) + '\nRaw (truncated): ' + truncated;
  throw new Error(msg);
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

function buildPrompt(nicheStyle, brandContext, opts = {}) {
  const days = Math.max(1, Math.min(30, Number(opts.days || 30)));
  const startDay = Math.max(1, Math.min(30, Number(opts.startDay || 1)));
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
  const qualityRules = `Quality Rules — Make each post plug-and-play & conversion-ready:\n1) Hook harder: first 3 seconds must be scroll-stopping; videoScript.hook must be punchy.\n2) Hashtags: mix broad + niche/local; 6–8 total (balance reach + targeting).\n3) CTA: time-bound urgency (e.g., \"book today\", \"spots fill fast\").\n4) Design: specify colors, typography, pacing, and end-card CTA.\n5) Repurpose: 2–3 concrete transformations (e.g., Reel→Carousel slides, Static→Reel).\n6) Engagement: natural, friendly scripts for comments & DMs.\n7) Format: Reels 7–12s with trending audio; Carousels start with bold headline.\n8) Captions: start with a short hook line, then 1–2 value lines (use \n).\n9) Keep outputs concise to avoid truncation.\n10) CRITICAL: Every post MUST include videoScript — Reels dominate reach. Even for Static/Carousel/Story, provide an \"optional Reel version\" script to help creators repurpose it.`;
  const nicheSpecific = nicheRules ? `\nNiche-specific constraints:\n${nicheRules}` : '';
  return `You are a content strategist.${brandBlock}${presetBlock}${qualityRules}${nicheSpecific}${promoGuardrail}\n\nCreate a calendar for \"${nicheStyle}\". Return a JSON array of ${days} objects for days ${startDay}..${startDay + days - 1}.\nALL FIELDS BELOW ARE REQUIRED for every object (never omit any):\n- day (number)\n- idea (string)\n- type (educational|promotional|lifestyle|interactive)\n- caption (exactly 2 short lines; the first line is the hook)\n- hashtags (array of 6–8 strings; mix broad + niche/local; no punctuation)\n- format (Reel|Story|Carousel|Static)\n- cta (urgent, time-bound)\n- pillar (Education|Social Proof|Promotion|Lifestyle)\n- storyPrompt (<= 120 chars)\n- designNotes (<= 120 chars; specific)\n- repurpose (array of 2–3 short strings)\n- analytics (array of 2–3 short metric names, e.g., [\"Reach\",\"Saves\"])\n- engagementScripts { commentReply, dmReply } (each <= 140 chars; friendly, natural)\n- promoSlot (boolean)\n- weeklyPromo (string; include only if promoSlot is true; otherwise set to \"\")\n- videoScript { hook, body, cta } (REQUIRED for ALL posts regardless of format; hook 5–8 words; body 2–3 short beats; cta urgent)\n\nRules:\n- If unsure, invent concise, plausible content rather than omitting fields.\n- Always include every field above (use empty string only if absolutely necessary).\n- Return ONLY a valid JSON array of ${days} objects. No markdown, no comments, no trailing commas.`;
}
function sanitizePostForPrompt(post = {}) {
  const fields = ['idea','title','type','caption','format','pillar','storyPrompt','designNotes','repurpose','hashtags','cta','videoScript'];
  const sanitized = {};
  fields.forEach((field) => {
    if (post[field] != null) sanitized[field] = post[field];
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
1) Hook harder: first 3 seconds must be scroll-stopping; videoScript.hook must punch.
2) Hashtags: mix broad + niche/local; 6–8 total to balance reach and targeting.
3) CTA: time-bound urgency (e.g., "book today", "spots fill fast").
4) Design notes: specify colors, typography, pacing, and end-card CTA.
5) Repurpose: 2–3 concrete transformations (Reel→Carousel slides, Static→Reel, etc.).
6) Engagement: natural, friendly scripts for comments & DMs.
7) Format: Reels 7–12s with trending audio; carousels start with bold headline.
8) Captions: start with a short hook line, then 1–2 value lines (use \\n).
9) Keep outputs concise to avoid truncation.
10) CRITICAL: every post MUST include videoScript — even non-video formats should note how to adapt it.`;
  const nicheSpecific = nicheRules ? `\nNiche-specific constraints:\n${nicheRules}` : '';
  const schema = `Return ONLY a JSON array containing exactly 1 object for day ${day}. It must include ALL fields in the master schema (day, idea, type, caption, hashtags, format, cta, pillar, storyPrompt, designNotes, repurpose, analytics, engagementScripts, promoSlot, weeklyPromo, videoScript).`;
  const snapshot = JSON.stringify(sanitizePostForPrompt(post), null, 2);
  return `You are a content strategist.${brandBlock}${presetBlock}${qualityRules}${nicheSpecific}

Niche/Style: ${nicheStyle}
Day to regenerate: ${day}

Current post (reference only — do NOT reuse text):
${snapshot}

Rewrite this day from scratch with a fresh angle while respecting every schema field. ${schema}`;
}

function hasAllRequiredFields(p){
  if (!p) return false;
  const ok = p.day!=null && p.idea && p.type && p.caption && p.hashtags && Array.isArray(p.hashtags) && p.hashtags.length>=6
    && p.format && p.cta && p.pillar && p.storyPrompt && p.designNotes
    && p.repurpose && Array.isArray(p.repurpose) && p.repurpose.length>=2
    && p.analytics && Array.isArray(p.analytics) && p.analytics.length>=2
    && p.engagementScripts && p.engagementScripts.commentReply && p.engagementScripts.dmReply
    && p.videoScript && p.videoScript.hook && p.videoScript.body && p.videoScript.cta
    && typeof p.promoSlot === 'boolean' && (p.promoSlot ? typeof p.weeklyPromo==='string' : true);
  return !!ok;
}

async function repairMissingFields(nicheStyle, brandContext, partialPosts){
  try {
    const schema = `Fill missing fields for each post. Keep existing values exactly as given. Return ONLY a JSON array with the same length and order. ALL fields must be present for every item (never omit):
- day (number)
- idea (string)
- type (educational|promotional|lifestyle|interactive)
- caption (exactly 2 short lines; first line is the hook)
- hashtags (array of 6â8 strings)
- format (Reel|Story|Carousel|Static)
- cta (string)
- pillar (Education|Social Proof|Promotion|Lifestyle)
- storyPrompt (string <= 120 chars)
- designNotes (string <= 120 chars)
- repurpose (array of 2â3 short strings)
- analytics (array of 2â3 strings)
- engagementScripts { commentReply, dmReply } (each <= 140 chars)
- promoSlot (boolean)
- weeklyPromo (string; include empty string if promoSlot is false)
- videoScript { hook, body, cta }`;
    const prompt = `Brand Context (optional):
${brandContext || 'N/A'}

Niche/Style: ${nicheStyle}

Here are partial posts with some fields missing. Repair them to include ALL required fields with concise, plausible values. Preserve existing values verbatim.

Partial posts (JSON array):
${JSON.stringify(partialPosts)}

${schema}`;
    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 3000,
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
    const json = await openAIRequest(options, payload);
    const content = json.choices?.[0]?.message?.content || '[]';
    const { data } = parseLLMArray(content, { requireArray: true });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('repairMissingFields error:', e.message);
    return [];
  }
}

function normalizePost(post, idx = 0, startDay = 1, forcedDay) {
  const fallbackDay = typeof forcedDay === 'number'
    ? Number(forcedDay)
    : (startDay ? Number(startDay) + idx : idx + 1);
  const defaultHashtags = ['marketing', 'content', 'tips', 'learn', 'growth', 'brand'];
  const out = Object.assign({}, post);
  out.day = typeof out.day === 'number' ? out.day : fallbackDay;
  out.idea = out.idea || out.title || 'Engaging post idea';
  out.type = out.type || 'educational';
  out.caption = out.caption || 'Quick tip that helps you today.\nSave this for later.';
  if (!Array.isArray(out.hashtags)) {
    if (typeof out.hashtags === 'string') {
      out.hashtags = out.hashtags.split(/[,\s]+/).filter(Boolean);
    } else {
      out.hashtags = defaultHashtags.slice();
    }
  }
  out.format = out.format || 'Reel';
  out.cta = out.cta || 'DM us to book today';
  out.pillar = out.pillar || 'Education';
  out.storyPrompt = out.storyPrompt || "Share behind-the-scenes of today's work.";
  out.designNotes = out.designNotes || 'Clean layout, bold headline, brand colors.';
  if (!Array.isArray(out.repurpose) || !out.repurpose.length) {
    out.repurpose = ['Reel -> Carousel (3 slides)', 'Caption -> Story (2 frames)'];
  }
  if (!Array.isArray(out.analytics) || !out.analytics.length) {
    out.analytics = ['Reach', 'Saves'];
  }
  if (!out.engagementScripts) {
    out.engagementScripts = { commentReply: '', dmReply: '' };
  }
  if (!out.engagementScripts.commentReply) {
    out.engagementScripts.commentReply = 'Thanks! Want our quick guide?';
  }
  if (!out.engagementScripts.dmReply) {
    out.engagementScripts.dmReply = 'Starts at $99. Want me to book you this week?';
  }
  if (typeof out.promoSlot !== 'boolean') out.promoSlot = !!out.weeklyPromo;
  if (!out.promoSlot && out.weeklyPromo) out.weeklyPromo = '';
  if (!out.videoScript) out.videoScript = { hook: '', body: '', cta: '' };
  if (!out.videoScript.hook) out.videoScript.hook = 'Stop scrollingâquick tip';
  if (!out.videoScript.body) out.videoScript.body = 'Show result â¢ Explain 1 step â¢ Tease benefit';
  if (!out.videoScript.cta) out.videoScript.cta = 'DM us to grab your spot';
  return out;
}

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

function callOpenAI(nicheStyle, brandContext, opts = {}) {
  const prompt = buildPrompt(nicheStyle, brandContext, opts);
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,
    max_tokens: 4000,
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
  const fetchAndParse = async (attempt = 0) => {
    const json = await openAIRequest(options, payload);
    const content = json.choices?.[0]?.message?.content || '';
    try {
      const { data, attempts } = parseLLMArray(content, {
        requireArray: true,
        itemValidate: (p) => p && typeof p.day === 'number',
      });
      if (debugEnabled) console.log('[CALENDAR PARSE] attempts:', attempts);
      return data;
    } catch (e) {
      if (attempt < 1) { // Single parse-level retry (fresh completion)
        if (debugEnabled) console.warn('[CALENDAR PARSE] retry after failure:', e.message);
        return fetchAndParse(attempt + 1);
      }
      throw e;
    }
  };
  return fetchAndParse(0);
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

  if (parsed.pathname === '/api/generate-calendar' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { nicheStyle, userId, days, startDay } = JSON.parse(body || '{}');
        if (!nicheStyle) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'nicheStyle required' }));
        }
        if (!OPENAI_API_KEY) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'OPENAI_API_KEY not set' }));
        }
        // pull brand context if available
        const brand = userId ? loadBrand(userId) : null;
        const brandContext = summarizeBrandForPrompt(brand);
        let posts = await callOpenAI(nicheStyle, brandContext, { days, startDay });
        // First-pass repair via LLM if any items are missing required fields
        const incomplete = posts.map((p, i) => ({ p, i })).filter(({ p }) => !hasAllRequiredFields(p));
        if (incomplete.length > 0) {
          const repaired = await repairMissingFields(nicheStyle, brandContext, incomplete.map(x => x.p));
          if (Array.isArray(repaired) && repaired.length === incomplete.length) {
            incomplete.forEach((entry, idx) => {
              const fixed = repaired[idx] || {};
              // Merge: prefer repaired values, fall back to original
              const merged = Object.assign({}, entry.p, fixed);
              if (typeof merged.promoSlot !== 'boolean') merged.promoSlot = !!merged.weeklyPromo;
              if (merged.promoSlot && typeof merged.weeklyPromo !== 'string') merged.weeklyPromo = '';
              // Normalize arrays
              if (!Array.isArray(merged.hashtags)) merged.hashtags = merged.hashtags ? String(merged.hashtags).split(/\s+|,\s*/).filter(Boolean) : [];
              if (!Array.isArray(merged.repurpose)) merged.repurpose = merged.repurpose ? [merged.repurpose] : [];
              if (!Array.isArray(merged.analytics)) merged.analytics = merged.analytics ? [merged.analytics] : [];
              // Ensure engagementScripts object shape
              if (!merged.engagementScripts) merged.engagementScripts = {};
              if (!merged.engagementScripts.commentReply && merged.engagementScript) merged.engagementScripts.commentReply = merged.engagementScript;
              if (!merged.engagementScripts.dmReply) merged.engagementScripts.dmReply = '';
              // Ensure videoScript object shape
              if (!merged.videoScript) merged.videoScript = { hook: '', body: '', cta: '' };
              posts[entry.i] = merged;
            });
          }
        }
        let promoCount = 0;
        const promoKeywords = /\b(discount|special|deal|promo|offer|sale|glow special|student)\b/i;
        posts = posts.map((p, idx) => {
          const normalized = normalizePost(p, idx, startDay);
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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ posts }));
      } catch (err) {
        console.error('API error:', err);
        let errorMessage = String(err);
        // Provide more helpful error messages for common issues
        if (errorMessage.includes('502')) {
          errorMessage = 'OpenAI servers are temporarily unavailable. Please try again in a moment.';
        } else if (errorMessage.includes('503')) {
          errorMessage = 'OpenAI service is overloaded. Please try again in a few seconds.';
        } else if (errorMessage.includes('504')) {
          errorMessage = 'Request timed out. Please try again.';
        } else if (errorMessage.includes('429')) {
          errorMessage = 'Rate limit exceeded. Please wait a moment before trying again.';
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: errorMessage }));
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
            });
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
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { nicheStyle, day, post, userId } = JSON.parse(body || '{}');
        if (!nicheStyle || typeof day === 'undefined' || day === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'nicheStyle and day are required' }));
        }
        if (!post || typeof post !== 'object') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'post payload required' }));
        }
        if (!OPENAI_API_KEY) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'OPENAI_API_KEY not set' }));
        }
        const brand = userId ? loadBrand(userId) : null;
        const brandContext = summarizeBrandForPrompt(brand);
        const prompt = buildSingleDayPrompt(nicheStyle, day, post, brandContext);
        const payload = JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.55,
          max_tokens: 1600,
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
        const json = await openAIRequest(options, payload);
        const content = json.choices?.[0]?.message?.content || '';
        const { data } = parseLLMArray(content, { requireArray: true });
        if (!Array.isArray(data) || data.length === 0) {
          throw new Error('Model returned no data');
        }
        const normalized = normalizePost(data[0], 0, Number(day) || 1, Number(day));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ post: normalized }));
      } catch (err) {
        console.error('regen-day error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Failed to regenerate day' }));
      }
    });
    return;
  }

  const normalizedPath = (() => {
    const rawPath = typeof parsed.pathname === 'string' ? parsed.pathname : '';
    const trimmed = rawPath.replace(/\/+$/, '');
    return (trimmed || '/').toLowerCase();
  })();

  if (parsed.pathname === '/api/phyllo/webhook' && req.method === 'POST') {
    readJsonBody(req)
      .then((body) => {
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
      })
      .catch((err) => {
        console.error('[Phyllo] Webhook handler error:', err);
        sendJson(res, 500, { error: 'phyllo_webhook_error' });
      });
    return;
  }

  if (parsed.pathname === '/api/phyllo/sdk-config' && req.method === 'GET') {
    return sendJson(res, 200, {
      userId: 'sandbox-demo-user',
      token: 'sandbox-demo-token',
      environment: 'sandbox',
      clientDisplayName: process.env.PHYLLO_CONNECT_CLIENT_DISPLAY_NAME || 'Promptly',
    });
  }

  if (parsed.pathname === '/api/analytics/accounts' && req.method === 'GET') {
    (async () => {
      try {
        const userId = (req.user && req.user.id) || null;
        if (!userId || !supabaseAdmin) return sendJson(res, 401, { error: 'unauthorized' });
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
          sendJson(res, 200, { followers_total: 0, followers_growth_30d: 0, avg_engagement_rate: 0, retention_rate: 0 });
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
          follower_growth: followersGrowth,
          engagement_rate: avgEngagement,
          avg_views_per_post: avgViewsPerPost,
          retention_pct: retentionRate,
        });
      } catch (err) {
        console.error('[Analytics overview] error', err);
        sendJson(res, 500, { error: 'analytics_overview_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/posts' && req.method === 'GET') {
    (async () => {
      try {
        const userId = (req.user && req.user.id) || null;
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
        if (!ids.length) return sendJson(res, 200, []);
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
        sendJson(res, 200, result);
      } catch (err) {
        console.error('[Analytics posts] error', err);
        sendJson(res, 500, { error: 'analytics_posts_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/insights' && req.method === 'GET') {
    (async () => {
      try {
        const userId = (req.user && req.user.id) || null;
        if (!userId || !supabaseAdmin) return sendJson(res, 401, { error: 'unauthorized' });
        const { data: rows } = await supabaseAdmin
          .from('growth_insights')
          .select('*')
          .eq('promptly_user_id', userId)
          .order('week_start', { ascending: false })
          .limit(4);
        sendJson(res, 200, rows || []);
      } catch (err) {
        console.error('[Analytics insights] error', err);
        sendJson(res, 500, { error: 'analytics_insights_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/alerts' && req.method === 'GET') {
    (async () => {
      try {
        const userId = (req.user && req.user.id) || null;
        if (!userId || !supabaseAdmin) return sendJson(res, 401, { error: 'unauthorized' });
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        const { data: recent } = await supabaseAdmin
          .from('phyllo_account_daily')
          .select('*')
          .gte('date', sevenDaysAgo.toISOString().slice(0, 10));
        const { data: previous } = await supabaseAdmin
          .from('phyllo_account_daily')
          .select('*')
          .gte('date', twoWeeksAgo.toISOString().slice(0, 10))
          .lt('date', sevenDaysAgo.toISOString().slice(0, 10));
        const alerts = [];
        const avgRecentEng = recent && recent.length
          ? recent.reduce((a, b) => a + Number(b.engagement_rate || 0), 0) / recent.length
          : null;
        const avgPrevEng = previous && previous.length
          ? previous.reduce((a, b) => a + Number(b.engagement_rate || 0), 0) / previous.length
          : null;
        if (avgRecentEng != null && avgPrevEng != null && avgPrevEng > 0 && (avgPrevEng - avgRecentEng) / avgPrevEng > 0.2) {
          alerts.push({ type: 'warning', message: 'Engagement dropped more than 20% week over week.' });
        }
        sendJson(res, 200, alerts);
      } catch (err) {
        console.error('[Analytics alerts] error', err);
        sendJson(res, 500, { error: 'analytics_alerts_failed' });
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
    try {
      const userId = parsed.query.userId;
      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'userId required' }));
      }
      const brand = loadBrand(userId);
      const text = Array.isArray(brand?.chunks)
        ? brand.chunks
            .map((chunk) => (typeof chunk?.text === 'string' ? chunk.text.trim() : ''))
            .filter(Boolean)
            .join('\n\n')
        : '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          ok: true,
          hasProfile: !!brand,
          chunks: brand?.chunks?.length || 0,
          text,
          updatedAt: brand?.updatedAt || null,
        })
      );
    } catch (err) {
      console.error('Brand profile error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(err) }));
    }
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
// Run design asset pipeline on interval to progress renders (disabled when design lab is off).
if (ENABLE_DESIGN_LAB) {
  setInterval(() => {
    advanceDesignAssetPipeline().catch((err) => {
      console.error('[Pipeline] Tick error', err);
    });
  }, 20000);
}

server.listen(PORT, () => console.log(`Promptly server running on http://localhost:${PORT}`));

process.on('uncaughtException', (err) => console.error('Uncaught:', err));
process.on('unhandledRejection', (r) => console.error('Unhandled rejection:', r));

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
  getWorkPlatformIds,
  ensurePhylloWebhook,
} = require('./services/phyllo');
const { getFeatureUsageCount, incrementFeatureUsage } = require('./services/featureUsage');
const {
  STORY_PROMPT_KEYWORD_OVERRIDE_VALIDATE_FAILED,
  validateStoryPromptKeywordOverride,
} = require('./server/lib/storyPromptOverrideValidator');
const {
  getNonHolidayHot100,
  getEvergreenFallbackList,
  isHolidayTrack,
  normalizeAudioString,
} = require('./server/lib/billboardHot100');
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
const PHYLLO_WEBHOOK_ENV = process.env.PHYLLO_WEBHOOK_ENV || 'production';
const PHYLLO_WEBHOOK_URL =
  process.env.PHYLLO_WEBHOOK_URL ||
  (CANONICAL_HOST ? `${CANONICAL_HOST.replace(/\/+$/, '')}/api/phyllo/webhook` : '');
const PHYLLO_WEBHOOK_DESCRIPTION = process.env.PHYLLO_WEBHOOK_DESCRIPTION || 'Promptly Phyllo webhook';
const PHYLLO_WEBHOOK_EVENTS = (process.env.PHYLLO_WEBHOOK_EVENTS || [
  'ACCOUNTS.CONNECTED',
  'ACCOUNTS.DISCONNECTED',
  'PROFILES.UPDATED',
  'CONTENTS.CREATED',
  'CONTENTS.UPDATED',
  'CONTENT_GROUPS.CREATED',
  'CONTENT_GROUPS.UPDATED',
  'COMMENTS.CREATED',
  'AUDIENCE.UPDATED',
].join(','))
  .split(',')
  .map((item) => String(item || '').trim())
  .filter(Boolean);
const PHYLLO_CLIENT_ID = process.env.PHYLLO_CLIENT_ID || '';
const PHYLLO_CLIENT_SECRET = process.env.PHYLLO_CLIENT_SECRET || '';
const PHYLLO_WORK_PLATFORM_LABELS = {
  'de55aeec-0dc8-4119-bf90-16b3d1f0c987': 'tiktok',
  '9bb8913b-ddd9-430b-a66a-d74d846e6c66': 'instagram',
};

const ANALYTICS_CACHE_TTL_MS = 120 * 1000;
const analyticsCache = new Map();

async function ensurePhylloUserForPromptlyUser(promptlyUserId) {
  if (!promptlyUserId) throw new Error('Promptly user ID is required for Phyllo user lookup');
  const externalId = String(promptlyUserId);
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('phyllo_users')
        .select('phyllo_user_id')
        .eq('promptly_user_id', promptlyUserId)
        .single();
      if (!error && data?.phyllo_user_id) {
        return { phylloUserId: data.phyllo_user_id, externalId };
      }
    } catch (err) {
      console.error('[Phyllo] fetch phyllo_users mapping failed', err);
    }
  }
}

async function resolvePromptlyUserIdFromPhyllo({ phylloUserId, phylloAccountId }) {
  if (!supabaseAdmin) return null;
  if (phylloUserId) {
    try {
      const { data, error } = await supabaseAdmin
        .from('phyllo_users')
        .select('promptly_user_id')
        .eq('phyllo_user_id', phylloUserId)
        .single();
      if (!error && data?.promptly_user_id) {
        return data.promptly_user_id;
      }
    } catch (err) {
      console.error('[Phyllo] resolvePromptlyUserIdFromPhyllo failed', err);
    }
  }
  if (phylloAccountId) {
    try {
      const { data, error } = await supabaseAdmin
        .from('phyllo_accounts')
        .select('promptly_user_id')
        .eq('phyllo_account_id', phylloAccountId)
        .single();
      if (!error && data?.promptly_user_id) {
        return data.promptly_user_id;
      }
    } catch (err) {
      console.error('[Phyllo] resolvePromptlyUserIdFromPhyllo (account) failed', err);
    }
  }
  return null;
}

async function processPhylloWebhookEvent(event = {}) {
  if (!event || typeof event !== 'object') return;
  const type = event?.type || 'unknown';
  const data = event?.data || {};
  const account = data.account || {};
  const phylloUserId = account.user_id || data.user_id;
  const phylloAccountId = account.id || data.account_id;
  const promptlyUserId = await resolvePromptlyUserIdFromPhyllo({ phylloUserId, phylloAccountId });
  const ensureAnalyticsRefresh = async () => {
    if (promptlyUserId) {
      try {
        await updateCachedAnalyticsForUser(promptlyUserId);
      } catch (err) {
        console.error('[Phyllo] updateCachedAnalyticsForUser failed', err);
      }
    }
  };

  switch (type) {
    case 'ACCOUNTS.CONNECTED':
      if (supabaseAdmin && upsertPhylloAccount) {
        try {
          await upsertPhylloAccount({
            userId: promptlyUserId,
            phylloUserId,
            platform: account.platform || account.work_platform_id || 'unknown',
            accountId: phylloAccountId,
            workPlatformId: account.work_platform_id,
            handle: account.username || account.handle,
            displayName: account.profile_name || account.display_name,
            avatarUrl: account.avatar_url || account.profile?.avatar_url,
          });
        } catch (err) {
          console.error('[Phyllo] webhook upsert account failed', err);
        }
      }
      await ensureAnalyticsRefresh();
      break;
    case 'ACCOUNTS.DISCONNECTED':
      if (supabaseAdmin && phylloAccountId) {
        try {
          await supabaseAdmin
            .from('phyllo_accounts')
            .update({ status: 'disconnected' })
            .eq('phyllo_account_id', phylloAccountId);
        } catch (err) {
          console.error('[Phyllo] webhook disconnect update failed', err);
        }
      }
      await ensureAnalyticsRefresh();
      break;
    case 'PROFILES.UPDATED':
      if (supabaseAdmin && phylloAccountId) {
        try {
          await supabaseAdmin
            .from('phyllo_accounts')
            .update({
              username: account.username || account.handle || account.login,
              profile_name: account.profile_name || account.display_name,
            })
            .eq('phyllo_account_id', phylloAccountId);
        } catch (err) {
          console.error('[Phyllo] webhook profile update failed', err);
        }
      }
      await ensureAnalyticsRefresh();
      break;
    case 'CONTENTS.CREATED':
    case 'CONTENTS.UPDATED':
    case 'CONTENT_GROUPS.CREATED':
    case 'CONTENT_GROUPS.UPDATED':
    case 'COMMENTS.CREATED':
    case 'AUDIENCE.UPDATED':
      await ensureAnalyticsRefresh();
      break;
    default:
      await ensureAnalyticsRefresh();
      break;
  }
}

async function syncAccountMetricsForAnalytics(acct = {}, since = new Date(), until = new Date()) {
  if (!acct || !acct.phyllo_account_id || !acct.promptly_user_id) return;
  if (!supabaseAdmin) return;
  try {
    const contents = await fetchAccountContents({ accountId: acct.phyllo_account_id, since, until });
    await wait(50);
    const engagement = await fetchAccountEngagement({ accountId: acct.phyllo_account_id, since, until });
    const items = contents?.data || contents?.items || contents || [];
    const metricsByDay = {};
    for (const item of items) {
      const contentId = item.id || item.content_id;
      if (!contentId) continue;
      const platform = item.platform || acct.work_platform_id || 'unknown';
      const publishedAt = item.published_at || item.posted_at || item.created_at || null;
      await supabaseAdmin.from('phyllo_posts').upsert(
        {
          phyllo_content_id: contentId,
          phyllo_account_id: acct.phyllo_account_id,
          promptly_user_id: acct.promptly_user_id,
          platform,
          title: item.title || item.caption || null,
          caption: item.caption || null,
          url: item.url || item.link || null,
          published_at: publishedAt,
        },
        { onConflict: 'phyllo_content_id' }
      );
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
      await supabaseAdmin.from('phyllo_account_daily').upsert(
        {
          phyllo_account_id: acct.phyllo_account_id,
          date: dateKey,
          followers: agg.followers || null,
          impressions: agg.impressions || agg.views || null,
          engagement_rate: agg.engagement_rate || null,
        },
        { onConflict: 'phyllo_account_id,date' }
      );
    }
  } catch (err) {
    console.error('[Phyllo Sync] account refresh failed', acct.phyllo_account_id, err?.response?.data || err);
  }
}

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
  const headers = { 'Content-Type': 'application/json' };
  if (payload && payload.requestId) headers['x-request-id'] = payload.requestId;
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

const isProduction = process.env.NODE_ENV === 'production';
const DEBUG_ANALYTICS = process.env.DEBUG_ANALYTICS === 'true';

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
  const requestIdValue = requestId || generateRequestId('server_error');
  const status = statusCode || err?.statusCode || (isOpenAISchema ? 502 : 500);
  const code = isOpenAISchema ? 'OPENAI_SCHEMA_ERROR' : err?.code || 'server_error';
  const message = isOpenAISchema ? 'openai_schema_error' : err?.message || 'internal_error';
  const payload = {
    error: {
      code,
      message,
      requestId: requestIdValue,
    },
  };
  if (isOpenAISchema) {
    const detailPayload = { ...(err?.details || {}) };
    if (err?.schemaSnippet) detailPayload.schemaSnippet = err.schemaSnippet;
    if (Object.keys(detailPayload).length) {
      payload.error.details = detailPayload;
    }
    if (!isProduction && err?.rawContent) {
      payload.error.debug = err.rawContent;
    }
  } else if (!isProduction && err?.stack) {
    payload.debugStack = err.stack;
  }
  sendJson(res, status, payload);
}

const REQUIRED_PHYLLO_ENV_KEYS = [
  'PHYLLO_ENABLED',
  'PHYLLO_CLIENT_ID',
  'PHYLLO_CLIENT_SECRET',
  'PHYLLO_API_BASE_URL',
  'PHYLLO_ENVIRONMENT',
];

function getMissingSupabaseEnvVars() {
  const missing = [];
  if (!process.env.SUPABASE_URL) {
    missing.push('SUPABASE_URL');
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SERVICE_KEY) {
    missing.push('SUPABASE_SERVICE_ROLE_KEY');
  }
  return missing;
}

function getMissingPhylloEnvVars() {
  return REQUIRED_PHYLLO_ENV_KEYS.filter((key) => {
    const value = process.env[key];
    return value === undefined || value === null || value === '';
  });
}

function sendServerMisconfigured(res, missing, requestId) {
  const payload = { ok: false, error: 'server_misconfigured', missing };
  if (requestId) payload.requestId = requestId;
  sendJson(res, 500, payload);
}

function getAnalyticsCache(key) {
  const cached = analyticsCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > ANALYTICS_CACHE_TTL_MS) {
    analyticsCache.delete(key);
    return null;
  }
  return cached.value;
}

function setAnalyticsCache(key, value) {
  analyticsCache.set(key, { timestamp: Date.now(), value });
}

function buildEmptyAnalyticsPayload({ connected = false, upstream_ok = true } = {}) {
  return {
    ok: true,
    connected,
    upstream_ok,
    overview: null,
    posts: [],
    demographics: {
      age_groups: {},
      genders: {},
      countries: {},
      languages: {},
    },
    insights: [],
    alerts: [],
    last_sync: null,
  };
}

function resolvePhylloPlatformLabel(account = {}) {
  if (!account) return 'unknown';
  if (account.platform) return String(account.platform).toLowerCase();
  const workPlatform = account.work_platform_id || account.workPlatformId;
  if (workPlatform && PHYLLO_WORK_PLATFORM_LABELS[workPlatform]) {
    return PHYLLO_WORK_PLATFORM_LABELS[workPlatform];
  }
  return workPlatform || 'unknown';
}

function mapPhylloAccountForResponse(account = {}) {
  if (!account) return null;
  return {
    id: account.phyllo_account_id || account.account_id || account.id,
    platform: resolvePhylloPlatformLabel(account),
    username: account.username || account.handle || null,
    handle: account.username || account.handle || null,
    external_account_id: account.account_id || account.phyllo_account_id || null,
    status: account.status || null,
    connected_at: account.connected_at || null,
    work_platform_id: account.work_platform_id || null,
    profile_name: account.profile_name || null,
    avatar_url: account.avatar_url || null,
  };
}

async function getConnectedPhylloAccounts(userId, requestId, route) {
  if (!userId || !supabaseAdmin) return { accounts: [], error: 'missing_supabase' };
  try {
    const { data, error } = await supabaseAdmin
      .from('phyllo_accounts')
      .select('*')
      .eq('promptly_user_id', userId)
      .eq('status', 'connected');
    if (error) {
      logServerError('phyllo_accounts_db_error', error, {
        requestId,
        route,
        userId,
        query: 'phyllo_accounts_select',
      });
      return { accounts: [], error: 'db_error' };
    }
    return { accounts: data || [], error: null };
  } catch (err) {
    logServerError('phyllo_accounts_db_error', err, {
      requestId,
      route,
      userId,
      query: 'phyllo_accounts_select',
    });
    return { accounts: [], error: 'db_error' };
  }
}

async function fetchPhylloAnalyticsSnapshot({ userId, requestId, route }) {
  if (!userId) return buildEmptyAnalyticsPayload({ connected: false });
  const cacheKey = `${userId}:analytics`;
  const cached = getAnalyticsCache(cacheKey);
  if (cached) return cached;

  const { accounts, error: accountsError } = await getConnectedPhylloAccounts(userId, requestId, route);
  if (accountsError) {
    const empty = buildEmptyAnalyticsPayload({ connected: false, upstream_ok: false });
    setAnalyticsCache(cacheKey, empty);
    return empty;
  }
  if (!accounts.length) {
    const empty = buildEmptyAnalyticsPayload({ connected: false });
    setAnalyticsCache(cacheKey, empty);
    return empty;
  }
  if (DEBUG_ANALYTICS) {
    console.log('[Analytics][Debug] connected accounts', {
      requestId,
      route,
      userId,
      count: accounts.length,
    });
  }
  const missingPhyllo = getMissingPhylloEnvVars();
  if (missingPhyllo.length) {
    logServerError('phyllo_env_missing', new Error('Missing Phyllo environment variables'), {
      requestId,
      route,
      missing: missingPhyllo,
    });
    return buildEmptyAnalyticsPayload({ connected: true, upstream_ok: false });
  }
  console.log('[Analytics] phyllo accounts', {
    requestId,
    route,
    userId,
    platforms: accounts.map((acc) => acc.platform || acc.work_platform_id || 'unknown'),
    count: accounts.length,
  });

  try {
    if (DEBUG_ANALYTICS) {
      console.log('[Analytics][Debug] fetching Phyllo metrics', {
        requestId,
        route,
        userId,
      });
    }
    const metrics = await getUserPostMetrics(accounts, { requestId, userId });
    if (DEBUG_ANALYTICS) {
      console.log('[Analytics][Debug] fetching Phyllo demographics', {
        requestId,
        route,
        userId,
      });
    }
    const demographicsRaw = await getAudienceDemographics(accounts, { requestId, userId });
    const overview = {
      follower_growth: metrics?.summary?.followerGrowth ?? null,
      engagement_rate: metrics?.summary?.engagementRate ?? null,
      avg_views: metrics?.summary?.avgViews ?? null,
      retention: metrics?.summary?.retention ?? null,
    };
    const demographics = Array.isArray(demographicsRaw)
      ? { age_groups: {}, genders: {}, countries: {}, languages: {} }
      : {
          age_groups: demographicsRaw?.age_groups || demographicsRaw?.age || {},
          genders: demographicsRaw?.genders || demographicsRaw?.gender || {},
          countries: demographicsRaw?.countries || demographicsRaw?.location || {},
          languages: demographicsRaw?.languages || demographicsRaw?.language || {},
        };
    const payload = {
      ok: true,
      connected: true,
      upstream_ok: true,
      overview,
      posts: metrics?.posts || [],
      demographics,
      insights: [],
      alerts: [],
      last_sync: null,
    };
    setAnalyticsCache(cacheKey, payload);
    return payload;
  } catch (err) {
    logServerError('phyllo_upstream_error', err, { requestId, route });
    return buildEmptyAnalyticsPayload({ connected: true, upstream_ok: false });
  }
}

async function authenticateRequestForRoute(req, res, requestId, route) {
  const missingEnv = getMissingSupabaseEnvVars();
  if (missingEnv.length) {
    logServerError('supabase_env_missing', new Error('Missing Supabase environment variables'), {
      requestId,
      route,
      missing: missingEnv,
    });
    sendServerMisconfigured(res, missingEnv, requestId);
    return null;
  }
  try {
    const user = await requireSupabaseUser(req);
    req.user = user;
    return user;
  } catch (err) {
    if (err?.statusCode === 401) {
      sendJson(res, 401, { ok: false, error: 'unauthorized', error_code: 'unauthorized', requestId });
      return null;
    }
    logServerError('supabase_auth_error', err, { requestId, route });
    sendJson(res, 500, { ok: false, error: 'server_error', error_code: 'server_error', requestId });
    return null;
  }
}

async function handleAnalyticsHeatmap(req, res) {
  const requestId = generateRequestId('analytics_heatmap');
  try {
    const user = await authenticateRequestForRoute(req, res, requestId, '/api/analytics/heatmap');
    if (!user) return;

    const snapshot = await fetchPhylloAnalyticsSnapshot({
      userId: user.id,
      requestId,
      route: '/api/analytics/heatmap',
    });
    const days = getAnalyticsWindowDays(req);
    const posts = filterPostsByWindow((snapshot.posts || []), days);
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

    return sendJson(res, 200, { ok: true, heatmap, requestId });
  } catch (err) {
    logServerError('analytics_heatmap_error', err, {
      requestId,
      route: '/api/analytics/heatmap',
    });
    if (!res.headersSent) {
      sendJson(res, 502, {
        ok: false,
        error: 'analytics_heatmap_upstream_failed',
        error_code: 'analytics_heatmap_upstream_failed',
        requestId,
      });
    }
  }
}

async function handleAnalyticsFull(req, res) {
  const requestId = generateRequestId('analytics_full');
  try {
    const user = await authenticateRequestForRoute(req, res, requestId, '/api/analytics/full');
    if (!user) return;

    const snapshot = await fetchPhylloAnalyticsSnapshot({
      userId: user.id,
      requestId,
      route: '/api/analytics/full',
    });

    let insights = [];
    let lastSync = null;
    if (supabaseAdmin) {
      const { data: insightsRows, error: insightsErr } = await supabaseAdmin
        .from('analytics_ai_insights')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (insightsErr) {
        logServerError('analytics_full_insights_error', insightsErr, {
          requestId,
          route: '/api/analytics/full',
        });
      } else {
        insights = insightsRows || [];
      }
      const { data: syncRow } = await supabaseAdmin
        .from('analytics_sync_status')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      lastSync = syncRow?.last_sync || null;
    }

    return sendJson(res, 200, {
      ...snapshot,
      insights,
      last_sync: lastSync,
      requestId,
    });
  } catch (err) {
    logServerError('analytics_full_error', err, {
      requestId,
      route: '/api/analytics/full',
    });
    if (!res.headersSent) {
      sendJson(res, 502, {
        ok: false,
        error: 'analytics_full_upstream_failed',
        error_code: 'analytics_full_upstream_failed',
        requestId,
      });
    }
  }
}

async function handleAnalyticsFollowers(req, res) {
  const requestId = generateRequestId('analytics_followers');
  try {
    const user = await authenticateRequestForRoute(req, res, requestId, '/api/analytics/followers');
    if (!user) return;

    const snapshot = await fetchPhylloAnalyticsSnapshot({
      userId: user.id,
      requestId,
      route: '/api/analytics/followers',
    });
    const trends = (snapshot && snapshot.followers) || [];
    const days = getAnalyticsWindowDays(req);
    const limited = filterSeriesByWindow(trends, days);
    const sorted = limited.sort((a, b) => new Date(a.date) - new Date(b.date));

    return sendJson(res, 200, { ok: true, trends: sorted, requestId });
  } catch (err) {
    logServerError('analytics_followers_error', err, {
      requestId,
      route: '/api/analytics/followers',
    });
    if (!res.headersSent) {
      sendJson(res, 502, {
        ok: false,
        error: 'analytics_followers_upstream_failed',
        error_code: 'analytics_followers_upstream_failed',
        requestId,
      });
    }
  }
}

async function handleAnalyticsDemographics(req, res) {
  const requestId = generateRequestId('analytics_demographics');
  try {
    const user = await authenticateRequestForRoute(
      req,
      res,
      requestId,
      '/api/analytics/demographics'
    );
    if (!user) return;

    const snapshot = await fetchPhylloAnalyticsSnapshot({
      userId: user.id,
      requestId,
      route: '/api/analytics/demographics',
    });
    return sendJson(res, 200, {
      ok: true,
      demographics: snapshot.demographics || { age_groups: {}, genders: {}, countries: {}, languages: {} },
      requestId,
    });
  } catch (err) {
    logServerError('analytics_demographics_error', err, {
      requestId,
      route: '/api/analytics/demographics',
    });
    if (!res.headersSent) {
      sendJson(res, 502, {
        ok: false,
        error: 'analytics_demographics_upstream_failed',
        error_code: 'analytics_demographics_upstream_failed',
        requestId,
      });
    }
  }
}

async function handleAnalyticsAlerts(req, res) {
  const requestId = generateRequestId('analytics_alerts');
  try {
    const user = await authenticateRequestForRoute(req, res, requestId, '/api/analytics/alerts');
    if (!user) return;

    if (!supabaseAdmin) {
      return sendJson(res, 200, { ok: true, alerts: [], requestId });
    }
    const days = getAnalyticsWindowDays(req);
    const since = getSinceDate(days).toISOString();
    const { data, error } = await supabaseAdmin
      .from('analytics_alerts')
      .select('*')
      .eq('user_id', user.id)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      logServerError('analytics_alerts_db_error', error, {
        requestId,
        route: '/api/analytics/alerts',
      });
      return sendJson(res, 200, { ok: true, alerts: [], requestId });
    }

    return sendJson(res, 200, { ok: true, alerts: data || [], requestId });
  } catch (err) {
    logServerError('analytics_alerts_error', err, {
      requestId,
      route: '/api/analytics/alerts',
    });
    if (!res.headersSent) {
      sendJson(res, 502, {
        ok: false,
        error: 'analytics_alerts_upstream_failed',
        error_code: 'analytics_alerts_upstream_failed',
        requestId,
      });
    }
  }
}

async function handlePhylloAccounts(req, res) {
  const requestId = generateRequestId('phyllo_accounts');
  try {
    const user = await authenticateRequestForRoute(req, res, requestId, '/api/phyllo/accounts');
    if (!user) return;

    const missingPhyllo = getMissingPhylloEnvVars();
    if (missingPhyllo.length) {
      logServerError('phyllo_env_missing', new Error('Missing Phyllo environment variables'), {
        requestId,
        route: '/api/phyllo/accounts',
        missing: missingPhyllo,
      });
      return sendJson(res, 200, { ok: true, connected: false, accounts: [], upstream_ok: false, requestId });
    }

    const { accounts, error: accountsError } = await getConnectedPhylloAccounts(
      user.id,
      requestId,
      '/api/phyllo/accounts'
    );
    if (accountsError) {
      return sendJson(res, 502, {
        ok: false,
        error: 'phyllo_accounts_db_error',
        error_code: 'phyllo_accounts_db_error',
        requestId,
      });
    }
    const mapped = accounts.map(mapPhylloAccountForResponse).filter(Boolean);

    return sendJson(res, 200, {
      ok: true,
      connected: mapped.length > 0,
      accounts: mapped,
      upstream_ok: true,
      requestId,
    });
  } catch (err) {
    logServerError('phyllo_accounts_error', err, {
      requestId,
      route: '/api/phyllo/accounts',
    });
    if (!res.headersSent) {
      sendJson(res, 502, {
        ok: false,
        error: 'phyllo_accounts_upstream_failed',
        error_code: 'phyllo_accounts_upstream_failed',
        requestId,
      });
    }
  }
}

function isUserPro(req) {
  const plan = req?.user?.plan;
  const tier = req?.user?.tier;
  if (req?.user?.isPro) return true;
  const normalizedTier = tier ? String(tier).toLowerCase().trim() : '';
  if (normalizedTier === 'pro' || normalizedTier === 'paid' || normalizedTier === 'premium') return true;
  if (plan && (plan === 'pro' || plan === 'teams')) return true;
  return false;
}

function isUserAdmin(req) {
  return !!req?.user?.isAdmin;
}

async function configurePhylloWebhook() {
  if (!PHYLLO_WEBHOOK_URL) {
    throw new Error('Phyllo webhook URL is not configured');
  }
  const events = PHYLLO_WEBHOOK_EVENTS || [];
  const payload = await ensurePhylloWebhook({
    webhookUrl: PHYLLO_WEBHOOK_URL,
    events,
    environment: PHYLLO_WEBHOOK_ENV,
    description: PHYLLO_WEBHOOK_DESCRIPTION,
  });
  const webhookId = payload?.id || payload?.webhook_id;
  if (webhookId) {
    const map = loadCustomersMap();
    map.phyllo_webhook_id = webhookId;
    saveCustomersMap(map);
    console.log('[Phyllo] webhook configured', webhookId);
  }
  return payload;
}

function analyticsUpgradeRequired(res) {
  return sendJson(res, 200, {
    disabled: true,
    reason: 'upgrade_required',
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

async function resolveAuthorizationHeaderUser(req) {
  if (!supabaseAdmin) return null;
  if (req.user) return req.user;
  const authHeader =
    (req.headers['authorization'] || req.headers['Authorization'] || '').trim();
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      console.warn('[Auth] Authorization header lookup failed', error?.message || 'invalid token');
      return null;
    }
    req.user = data.user;
    return data.user;
  } catch (err) {
    console.warn('[Auth] Authorization header processing error', err?.message || err);
    return null;
  }
}

async function ensureAnalyticsRequestUser(req) {
  if (req.user) return req.user;
  return resolveAuthorizationHeaderUser(req);
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
    'Ensure the design feels native to Instagram/TikTok: bold hook, social proof mid-frame, urgent CTA at the end.',
    'Use bold, legible typography and high-contrast layering suitable for mobile.',
    paletteTokens.length ? `Stick to this palette: ${paletteTokens.join(', ')}.` : '',
    fontTokens.length ? `Typography should pair ${fontTokens.join(' + ')}.` : '',
    brandKit ? describeBrandKitForPrompt(brandKit, { includeLogo: true }) : '',
  ].filter(Boolean);
  return pieces.join(' ');
}


const OPENAI_MAX_CONCURRENCY = (() => {
  const configured = Number(process.env.OPENAI_MAX_CONCURRENCY);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 2;
})();
const OPENAI_CHUNK_MAX_DAYS = (() => {
  const configured = Number(process.env.OPENAI_CHUNK_MAX_DAYS);
  return Number.isFinite(configured) && configured >= 1 ? Math.max(1, Math.floor(configured)) : 2;
})();
const OPENAI_GENERATION_TIMEOUT_MS = (() => {
  const configured = Number(process.env.OPENAI_GENERATION_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 120000 ? configured : 120000;
})();
const OPENAI_MAX_ATTEMPTS = (() => {
  const configured = Number(process.env.OPENAI_MAX_ATTEMPTS);
  return Number.isFinite(configured) && configured >= 1 ? Math.max(1, Math.floor(configured)) : 2;
})();
const openAiQueue = [];
let openAiActiveRequests = 0;
async function withOpenAiSlot(fn) {
  if (openAiActiveRequests >= OPENAI_MAX_CONCURRENCY) {
    await new Promise((resolve) => {
      openAiQueue.push(resolve);
    });
  }
  openAiActiveRequests += 1;
  try {
    return await fn();
  } finally {
    openAiActiveRequests -= 1;
    const next = openAiQueue.shift();
    if (next) next();
  }
}

function openAIRequest(options, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            const err = new Error(`OpenAI error ${res.statusCode}: ${data}`);
            err.code = 'OPENAI_BACKEND_ERROR';
            err.statusCode = res.statusCode;
            reject(err);
          }
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
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

function buildCalendarPostSchema(minDay = 1, maxDay = 30) {
  const safeMin = Number.isFinite(Number(minDay)) ? Number(minDay) : 1;
  const safeMax = Number.isFinite(Number(maxDay)) && Number(maxDay) >= safeMin ? Number(maxDay) : safeMin;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['day', 'title', 'hook', 'caption', 'cta', 'hashtags', 'script', 'reelScript', 'designNotes', 'storyPrompt', 'storyPromptPlus', 'engagementScripts'],
    properties: {
      day: {
        type: 'integer',
        minimum: safeMin,
        maximum: safeMax,
      },
      title: { type: 'string', minLength: 1 },
      hook: { type: 'string', minLength: 1 },
      caption: { type: 'string', minLength: 1 },
      cta: { type: 'string', minLength: 1 },
      designNotes: { type: 'string', minLength: 1 },
      storyPrompt: { type: 'string', minLength: 1 },
      storyPromptPlus: { type: 'string', minLength: 1 },
      hashtags: {
        type: 'array',
        minItems: 6,
        items: { type: 'string', minLength: 1 },
      },
      script: {
        type: 'object',
        additionalProperties: false,
        required: ['hook', 'body', 'cta'],
        properties: {
          hook: { type: 'string', minLength: 1 },
          body: { type: 'string', minLength: 1 },
          cta: { type: 'string', minLength: 1 },
        },
      },
      reelScript: {
        type: 'object',
        additionalProperties: false,
        required: ['hook', 'body', 'cta'],
        properties: {
          hook: { type: 'string', minLength: 1 },
          body: { type: 'string', minLength: 1 },
          cta: { type: 'string', minLength: 1 },
        },
      },
      engagementScripts: {
        type: 'object',
        additionalProperties: false,
        required: ['commentReply', 'dmReply'],
        properties: {
          commentReply: { type: 'string', minLength: 1 },
          dmReply: { type: 'string', minLength: 1 },
        },
      },
    },
  };
}

function buildCalendarSchemaObject(totalPostsRequired, minDay = 1, maxDay = 30) {
  const safeCount = Math.max(1, Number.isFinite(Number(totalPostsRequired)) ? Number(totalPostsRequired) : 1);
  return {
    type: 'object',
    additionalProperties: false,
    required: ['posts'],
    properties: {
      posts: {
        type: 'array',
        minItems: safeCount,
        maxItems: safeCount,
        items: buildCalendarPostSchema(minDay, maxDay),
      },
    },
  };
}

function buildBrandBrainDirective(settings = {}) {
  if (!settings || !settings.enabled) return '';
  const lines = [
    'Apply sales psychology and platform heuristics without naming specific apps.',
    'Use a strong hook, retention beat, and clear CTA in every post.',
    'Favor shorter, skimmable captions and avoid repeating hooks or angles.',
    'Add engagement loops periodically (binary questions or comment keywords).',
    'Use conversion-forward language while staying compliant and specific.',
    'Rotate CTAs across the month to avoid repetition.',
    'Category overlays:',
    '- Educational: emphasize saves/shares, step structure, clear outcome, and common-mistake framing.',
    '- Promotional/offer: handle one objection, add risk reversal, and clarify the next step with ethical urgency.',
    '- Story/personal: use identity + tension + lesson, then a soft conversion CTA.',
    '- Engagement: ask a forced-choice question tied to the niche; avoid spammy comment bait.',
    '- Testimonial/case study: include before/after, numbers or process, and a takeaway CTA.',
    '- Trend-based: keep it niche-specific, add a twist, and include value + CTA.',
  ];
  return lines.join('\n');
}

function buildPrompt(nicheStyle, brandContext, opts = {}) {
  const days = Math.max(1, Math.min(30, Number(opts.days || 30)));
  const startDay = Math.max(1, Math.min(30, Number(opts.startDay || 1)));
  const postsPerDaySetting =
    Number.isFinite(Number(opts.postsPerDay)) && Number(opts.postsPerDay) > 0
      ? Number(opts.postsPerDay)
      : 1;
  const totalPostsRequired = days * postsPerDaySetting;
  const dayRangeLabel = `${startDay}..${startDay + days - 1}`;
  const cleanNiche = nicheStyle ? ` for ${nicheStyle}` : '';
  const brandBlock = brandContext ? `Brand context: ${brandContext.trim()}
` : '';
  const brandBrainAddendum = opts.brandBrainDirective
    ? [
        `Brand Brain Core Rules (apply to every card and field):`,
        `Optimize for watch time, shares, saves, comments, profile taps, DMs, and sales conversion.`,
        `Use curiosity gaps, pattern interrupts, open loops, and concrete specificity (numbers/timeframes/outcomes).`,
        `Use strong POV + polarizing-but-safe framing; avoid generic advice.`,
        `Handle objections inside the content (time, cost, skepticism).`,
        `CTA must be single, explicit, frictionless; match card objective.`,
        `Each field must be distinct; do not restate other fields.`,
        `No emojis unless already required by base rules. No holiday-themed music suggestions; if audio exists, format as "Song Title - Artist" only.`,
        `BRAND BRAIN MUST DIFFER: Every field must include at least one of proof, objection handling, retention device, or save-worthy framework. If any field would match a non-Brand-Brain output, rewrite it.`,
        `Never output long paragraphs; prefer tight lines/bullets.`,
        `FIELD CONTRACT (use exact field names):`,
        `HOOK (hook): 1–2 lines, max 14 words per line. Must be one of: Contrarian claim; "Stop doing X"; "You're doing X wrong"; short myth-bust; "I did X for 7 days"; Pain -> payoff gap. Must create a curiosity gap with concrete payoff. Avoid generic questions unless sharply specific.`,
        `BODY (caption): Force structure with tight lines or bullets: Problem (specific, visceral). Mechanism (1–2 lines). Mistake -> Consequence -> Fix (always present). Proof (choose exactly one: mini-case, quantified result, credential, or observable before/after pattern). Objection crusher (top friction). Save-worthy step list (3–5 steps) OR checklist OR framework acronym. No vague claims.`,
        `CTA (cta): exactly one action. Educational -> Comment keyword or Save/share. Conversion -> DM keyword or Book. Must include explicit keyword in quotes and immediate benefit. Never "Ready for" questions.`,
        `REEL SCRIPT (reelScript): Must be a script, not a summary. Hook (repeat hook verbatim). 3-beat body: Pain/mistake (fast), Mechanism + fix (clear), Proof + next step (tight). Include pattern interrupts every 2–4 seconds as stage directions in parentheses. Include exactly one save/share trigger line.`,
        `DESIGN NOTES (designNotes): specify first 1 second visual + on-screen text. Include 2–3 concrete shot beats. Include one retention device (countdown, caption promise, visual checklist, split screen).`,
        `ENGAGEMENT LOOP (engagementScripts): include one pinned comment prompt (binary choice or "which one are you?"); one short DM follow-up script; one follow-up post suggestion (carousel/testimonial/FAQ) that reuses the same hook angle.`,
        `STORY PROMPT (storyPrompt): single tight narrative prompt for story asset. Must include opening frame visual + 3 beats + CTA frame. Must not repeat the full body. Max 450 chars.`,
        `DISTRIBUTION PLAN (distributionPlan if present): output exactly: 1 sentence viewer promise. 3 bullets retention beats with timestamps (0–1s, 2–5s, 6–10s). Caption path: 3 lines (insight, support, CTA). 5 hashtags max, non-generic, niche-specific. No meta-instructions.`,
        `CATEGORY PLAYBOOK (apply based on type/pillar/category): Educational -> Mistake -> Consequence -> Fix, authority, save/share. Promotional -> Problem -> Mechanism -> Offer -> Proof -> CTA; include who it is for. Testimonial -> Before -> After -> Process -> Proof -> CTA; numbers only if plausible. Behind-the-scenes -> what people think vs reality, process transparency, credibility. Trend -> trend hook + niche twist + value; no generic dance prompts. Community -> identity framing + debate prompt + pinned comment structure.`,
      ].join('\\n')
    : '';
  const brandBrainBlock = opts.brandBrainDirective
    ? `Brand Brain directives:\n${opts.brandBrainDirective.trim()}\n${brandBrainAddendum}\n`
    : '';
  if (opts.brandBrainDirective) {
    console.log('[BrandBrain][Prompt] addendum_appended=%s', Boolean(brandBrainAddendum));
  }
  const usedSignatures = (Array.isArray(opts.usedSignatures) ? opts.usedSignatures : [])
    .map((sig) => normalizeCalendarSignature(sig))
    .filter(Boolean);
  const usedBlock = usedSignatures.length
    ? `Avoid matching these signatures: ${usedSignatures.join(', ')}.`
    : 'No prior signatures to avoid yet.';
  const extraInstructions = opts.extraInstructions ? `${opts.extraInstructions.trim()}\n` : '';
  return `You are a thoughtful calendar writer${cleanNiche}.
 ${brandBlock}${brandBrainBlock}Return STRICT valid JSON only (no markdown, no commentary). Generate EXACTLY ${totalPostsRequired} posts for days ${dayRangeLabel} (postsPerDay=${postsPerDaySetting}). Use plain ASCII quotes and keep strings concise.
 Each object must include day, title, hook, caption, cta, hashtags, script, reelScript, designNotes, storyPrompt, and engagementScripts with non-empty values. script and reelScript must each contain hook, body, and cta; engagementScripts must include commentReply and dmReply.
 StoryPrompt must be a short creator prompt/question and must never append the niche label at the end.
 Uniqueness: treat each day number as a unique slot and base the topic/title/hook on that day so no two days share the same angle or opening phrase. Imagine a 30-day topic pool and pick a distinct subset for this batch, avoiding repeated sentence templates. ${extraInstructions}${usedBlock}
 `;
}

function normalizeCalendarSignature(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

function buildCalendarSchemaBlock(expectedCount) {
  return `Calendar schema: ${expectedCount} posts with day, title, hook, caption, cta, hashtags[], script{hook,body,cta}, reelScript{hook,body,cta}, designNotes, storyPrompt, engagementScripts{commentReply,dmReply}. Each field must be non-empty and JSON must be valid.`;
}

function sanitizeJsonContent(content = '') {
  if (typeof content !== 'string') return '';
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return content;
  }
  let snippet = content.slice(firstBrace, lastBrace + 1);
  snippet = snippet.replace(/,\s*([}\]])/g, '$1');
  snippet = snippet.replace(/[\u2018\u2019]/g, "'");
  return snippet;
}

function parseCalendarPostsFromContent(content = '') {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.posts) ? parsed.posts : null;
  } catch {
    return null;
  }
}

function tryParsePosts(content = '', expectedCount = null) {
  const posts = parseCalendarPostsFromContent(content);
  if (!Array.isArray(posts)) {
    return { posts: null, reason: 'missing_posts', parsed: null };
  }
  if (expectedCount !== null && posts.length !== expectedCount) {
    return { posts: null, reason: 'count_mismatch', parsed: posts };
  }
  return { posts, reason: null };
}

function buildFallbackChunkPosts(nicheStyle, startDay, postsPerDay, totalCount) {
  const fallback = [];
  for (let idx = 0; idx < totalCount; idx += 1) {
    const day = computePostDayIndex(idx, startDay, postsPerDay);
    fallback.push(buildFallbackPost(nicheStyle, day));
  }
  return fallback;
}

function stableHash(value = '') {
  let hash = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function selectBillboardEntry(list = [], indexSeed = 0) {
  if (!Array.isArray(list) || !list.length) return null;
  const safeIndex = Math.abs(Number(indexSeed) || 0) % list.length;
  return list[safeIndex];
}

function sanitizeAudioText(value = '') {
  let text = toPlainString(value || '').trim();
  text = text.replace(/\(link:[^)]+\)/gi, '');
  text = text.replace(/https?:\/\/\S+/gi, '');
  text = text.replace(/@[A-Za-z0-9._-]+/g, '');
  text = text.replace(/[\u2018\u2019]/g, "'");
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function isValidSuggestedAudio(audio = '') {
  if (!audio || typeof audio !== 'string') return false;
  return /.+\s-\s.+/.test(audio);
}

function ensureSuggestedAudioForPosts(posts = [], { audioEntries = [], chunkStartDay = 1, postsPerDay = 1 } = {}) {
  if (!Array.isArray(posts) || !posts.length) {
    return { total: 0, missingAudio: 0 };
  }
  const list = Array.isArray(audioEntries) ? audioEntries : [];
  const stats = { total: posts.length, missingAudio: 0 };
  posts.forEach((post, idx) => {
    if (!list.length) {
      post.suggestedAudio = '';
      stats.missingAudio += 1;
      return;
    }
    const dayIndex = Number(post.day) || computePostDayIndex(idx, chunkStartDay, postsPerDay);
    const postIndex = Number.isFinite(Number(post.slot)) ? Number(post.slot) - 1 : (idx % postsPerDay);
    const pickIndex = (dayIndex + postIndex) % list.length;
    const entry = selectBillboardEntry(list, pickIndex) || selectBillboardEntry(list, idx);
    const audioString = normalizeAudioString(entry?.title || '', entry?.artist || '');
    post.suggestedAudio = audioString || '';
    if (!audioString) stats.missingAudio += 1;
  });
  return stats;
}

function sanitizePostForPrompt(post = {}) {
  const fields = ['idea','title','type','hook','caption','format','pillar','storyPrompt','storyPromptPlus','designNotes','repurpose','hashtags','cta','script','instagram_caption','tiktok_caption','linkedin_caption','audio'];
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
  const qualityRules = `Quality Rules — Make each post specific and actionable:
1) Hook: write ONE sentence (6–14 words, sentence case) that acts as a niche-specific cold open tied directly to the post’s unique idea/context. Reference a tension, routine, insight, or surprising takeaway about the provided niche/style, and immediately promise a payoff that only this niche would understand. Do not mention unrelated niches or platforms, and do not prefix the line with “Hook:” or any label. Avoid templates, clichés, or repeating the same phrasing across cards—each hook must feel novel, grounded, and non-generic.
2) Hashtags: generate 6–10 space-separated hashtags that tie directly to the niche and this post’s concept. At least half must be specific to the niche/topic (no generic tags or weekday gimmicks). Avoid reusing the same set across posts and keep filler tags to a minimum.
3) CTA: write one short call-to-action (4–10 words) that is specific to this post’s topic. Do not output generic prompts such as “Thoughts?”, “Let us know!”, “Tell me what you think”, or “Share your story.” Never include “DM me” unless the context explicitly involves booking/consult calls, and avoid advising direct “Book now”/“Sign up” style language. Output only the CTA text with no label or prefix.
4) Design notes: output 2–4 bullet points tied directly to this post’s concept. Each bullet should describe concrete visual choices (lighting, shot type, on-screen text, pacing) that reinforce the specific message and feel native to the niche. Avoid generic advice or filler (no “use warm footage”, “keep it high energy”, “add captions”). Output only bullets.
5) Repurpose: 2–3 concrete transformations (Reel remix ideas).
6) Response Guidance: output two items tied to the niche and post concept: (1) a sample reply to a viewer comment (1–2 sentences) that feels specific, helpful, and speaks to the idea without slipping into promotional language; (2) a follow-up prompt (1 sentence) that nudges the viewer to keep the conversation going on the same topic. Avoid boilerplate “DM me” pushes or scripted closings; keep both items informative and grounded in the niche. Output only those two items.
7) Reel Script: write 3–6 short lines that form a niche-specific mini script rooted in this post’s concept. Each line should feel concrete (no generic “introduce, explain, close” scaffolds); vary the structure line-to-line and let the closing line naturally lead into the CTA. Avoid reusing the same phrasing from other cards. Output only the script lines (no extra labels or commentary).
8) Format: Choose the best format for this post in the niche: {nicheStyle}, based on the post’s concept/context. Output exactly one value from this allowed list: Reel, Story, Carousel, Static. Output only the single value.
        9) CAPTION BODY RULES (HARD): write 2–4 sentences that follow the same emotional thread as the Hook and stay tightly anchored to the post’s unique idea. Avoid template prefixes or “story spotlight” labels. Keep the tone concrete and niche-credible; do not repeat scaffolds from other posts. Use natural wording (no hashtags, emojis, platform references, or overly promotional language). End with a single, non-generic question that relates directly to the topic. Output only the caption text.
10) Keep outputs concise to avoid truncation.
11) CRITICAL: every post MUST include script { hook, body, cta }.`;
  const nicheSpecific = nicheRules ? `\nNiche-specific constraints:\n${nicheRules}` : '';
  const schema = `Return ONLY a JSON array containing exactly 1 object for day ${day}. It must include ALL fields in the master schema (day, idea, type, hook, caption, hashtags, format MUST be "Reel", cta, pillar, storyPrompt, storyPromptPlus, designNotes, repurpose, analytics, engagementScripts, promoSlot, weeklyPromo, script, instagram_caption, tiktok_caption, linkedin_caption, audio). storyPrompt must be 1–2 short sentences max that read like a free-form creator note tied to the niche/topic, vary phrasing across posts, allow either no question or a single question mark, never include "!?", and ban canned CTA templates such as "Tag a friend", "DM us", or "Comment below". storyPromptPlus must be 1–2 sentences (at least 12 words) that expands on the topic with extra stakes or proof and ends with a follow-up question. Return JSON only; do not omit fields or use null/placeholder values.`;
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
  const keyword = String(raw.pinned_keyword || raw.pinnedKeyword || raw.keyword || '').trim();
  const deliverable = String(raw.pinned_deliverable || raw.pinnedDeliverable || '').trim();
  return {
    angle: angleText,
    objective: objectiveText,
    pinned_keyword: keyword,
    pinned_deliverable: deliverable,
    target_saves_pct: Number.isFinite(savesPct) ? savesPct : null,
    target_comments_pct: Number.isFinite(commentsPct) ? commentsPct : null,
    hook_options: dedupedHooks,
  };
}

const BANNED_TERMS = ['angle', 'objective', 'major objection', 'insight'];
const PINNED_COMMENT_REGEX = /^Comment\s+([A-Za-z0-9]+)\s+and I(?:'|’|`)?ll send you\s+(.+)\.$/i;
const KEYWORD_STOPWORDS = new Set(['THE','A','AN','AND','OR','TO','OF','IN','ON','FOR','WITH','MY','YOUR','THIS','THAT']);

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
const STORY_PROMPT_KEYWORD_OVERRIDES = {};

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

function stripOverridesFromPost(post = {}) {
  if (!post || typeof post !== 'object') return post;
  const sanitized = { ...(post || {}) };
  STORY_PROMPT_OVERRIDE_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(sanitized, key)) delete sanitized[key];
  });
  return sanitized;
}

function stripStoryPromptOverrideFields(payload = {}) {
  const clean = { ...(payload || {}) };
  STORY_PROMPT_OVERRIDE_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(clean, key)) delete clean[key];
  });
  if (Array.isArray(clean.posts)) {
    clean.posts = clean.posts.map(stripOverridesFromPost);
  }
  return clean;
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

function isOverrideTokenSafe(token = '') {
  const normalized = String(token || '').trim();
  return /^[A-Z]{3,12}$/.test(normalized.toUpperCase());
}

function getSafeOverrideTokens(nicheKey = '') {
  const overrides = (STORY_PROMPT_KEYWORD_OVERRIDES && typeof STORY_PROMPT_KEYWORD_OVERRIDES === 'object')
    ? STORY_PROMPT_KEYWORD_OVERRIDES
    : {};
  const tokens = Array.isArray(overrides[nicheKey]) ? overrides[nicheKey] : [];
  return tokens.filter(isOverrideTokenSafe);
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
  const fallback = '';
  const key = `${post.userId || 'anon'}|${nicheStyle}`;
  if (!STORY_PROMPT_PLUS_LOGGED.has(key)) {
    console.warn('[Calendar] StoryPromptPlusFallbackRegen', { userId: post.userId || null, niche: nicheStyle, original: trimmed || '[empty]' });
    STORY_PROMPT_PLUS_LOGGED.add(key);
  }
  return fallback;
}

function buildStoryPromptPlusNicheFallback(nicheStyle = '') {
  return '';
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
  const dev_story = sanitizeStoryPromptPlus(dev_niche, 'What’s your favorite combo right now? Add a poll and slider.');
  if (/facial|peel|glow/.test(dev_story.toLowerCase())) {
    console.warn('[Calendar][Dev] StoryPromptPlus sanitize failed to strip banned terms');
  }
  if (!/fast|food/.test(dev_story.toLowerCase())) {
    console.warn('[Calendar][Dev] StoryPromptPlus missing niche anchor', dev_story);
  }
}

function ensureStoryPromptMatchesNiche(nicheStyle = '', storyPrompt = '', hashtags = []) {
  const trimmed = String(storyPrompt || '').trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  const tokens = extractNicheTokens(nicheStyle, hashtags);
  const hasNicheToken = tokens.size && [...tokens].some((token) => lower.includes(token));
  const nicheKey = deriveStoryPromptNicheKey(nicheStyle);
  const bannedTerms = STORY_PROMPT_BANNED_TERMS[nicheKey] || [];
  const hasBanned = bannedTerms.some((term) => lower.includes(term));
  const overrideTokens = getSafeOverrideTokens(nicheKey);
  if (hasBanned && !overrideTokens.some((term) => tokens.has(term))) {
    return '';
  }
  if (tokens.size && !hasNicheToken) {
    return '';
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

function sanitizeHashtagToken(value = '') {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return normalized;
}

function buildFallbackHashtagList(nicheStyle = '', platform = '') {
  const tokens = [];
  const addToken = (value) => {
    const sanitized = sanitizeHashtagToken(value);
    if (sanitized && !tokens.includes(sanitized)) tokens.push(sanitized);
  };
  addToken(nicheStyle);
  addToken(platform);
  const extras = ['content', 'creator', 'shortform', 'story', 'strategy', 'engagement', 'tips', 'insight', 'daily', 'plan', 'workflow', 'framework', 'ideas'];
  extras.forEach(addToken);
  let fillerIndex = 0;
  while (tokens.length < 8) {
    addToken(`content${fillerIndex}`);
    fillerIndex += 1;
  }
  return tokens.slice(0, 15).map((token) => `#${token}`);
}

function normalizeScriptObject(source = {}) {
  const hook = toPlainString(source.hook);
  const body = toPlainString(source.body);
  const cta = toPlainString(source.cta);
  return { hook, body, cta };
}

const PLACEHOLDER_PROMPT_REGEX = /^(?:tbd|n\/a|null|undefined|none|story prompt here)$/i;
const DISTRIBUTION_PLACEHOLDER_REGEX = /^(?:tbd|n\/a|null|undefined|none|distribution plan here)$/i;

const STORY_PROMPT_ALIASES = [
  'storyPrompt',
  'story_prompt',
  'story prompt',
  'storyPromptPlus',
  'story_prompt_plus',
  'storyPromptExpanded',
  'story_prompt_expanded',
  'storyPromptVariant',
  'story_prompt_variant',
];

function resolveStoryPromptValue(post = {}) {
  for (const key of STORY_PROMPT_ALIASES) {
    if (!Object.prototype.hasOwnProperty.call(post, key)) continue;
    const value = post[key];
    const trimmed = toPlainString(value);
    if (trimmed && !PLACEHOLDER_PROMPT_REGEX.test(trimmed)) return trimmed;
  }
  return '';
}

function buildStoryPromptFromPost(post = {}, nicheStyle = '') {
  const topic = toPlainString(post.topic || post.idea || post.caption || post.title || 'today’s insight');
  const hook = toPlainString(post.hook || '');
  const niche = toPlainString(nicheStyle || '');
  const parts = [hook, topic]
    .map((part) => toPlainString(part))
    .map((part) => part.trim())
    .filter(Boolean);
  if (niche) {
    const normalizedNiche = niche.trim();
    if (normalizedNiche && !parts.some((part) => part.toLowerCase().includes(normalizedNiche.toLowerCase()))) {
      parts.push(normalizedNiche);
    }
  }
  return parts.join('. ');
}

function ensureStoryPromptFallback(post = {}, nicheStyle = '') {
  const current = String(post.storyPrompt || '').trim();
  if (current) return current;
  const fallback = buildStoryPromptFromPost(post, nicheStyle);
  if (fallback) return fallback;
  const idea = toPlainString(post.idea || post.title || 'talk through this insight');
  if (idea) return `${idea}.`;
  return `Share an idea about ${nicheStyle || 'your niche'}.`;
}

function ensureStoryPromptPlusFallback(post = {}, nicheStyle = '') {
  const current = String(post.storyPromptPlus || '').trim();
  if (current) return current;
  const fallback = buildStoryPromptPlusFromPost(post, nicheStyle);
  if (fallback) return fallback;
  const idea = toPlainString(post.idea || post.title || 'add more context');
  if (idea) return `Add context to ${idea} and ask what viewers think?`;
  return `Add more detail about ${nicheStyle || 'the topic'}?`;
}

function ensureDesignNotesFallback(post = {}, nicheStyle = '') {
  const existing = String(post.designNotes || '').trim();
  if (existing) return existing;
  const idea = toPlainString(post.idea || post.title || post.hook || '');
  const promptRef = toPlainString(post.storyPrompt || '').trim();
  const topic = idea || promptRef || 'this topic';
  const format = toPlainString(post.format || 'Reel').toLowerCase();
  const niche = toPlainString(nicheStyle || 'your niche');
  const direction = [];
  if (format) {
    direction.push(`Frame this ${format} with visual cues that spotlight ${topic}.`);
  } else {
    direction.push(`Use visuals that underline ${topic}.`);
  }
  if (niche) {
    direction.push(`Tie palette and props to ${niche} so the story feels anchored.`);
  }
  if (promptRef) {
    direction.push(`Let the movement echo "${promptRef}" while keeping transitions smooth.`);
  }
  return direction.join(' ').trim() || `Visuals should stay focused on ${topic}.`;
}

function escapeRegexPattern(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeStoryPromptFromNiche(text = '', nicheStyle = '') {
  const raw = String(text || '').trim();
  if (!raw) return raw;
  const niche = String(nicheStyle || '').trim();
  if (!niche) return raw;
  const escaped = escapeRegexPattern(niche);
  const trailing = new RegExp(`[\\s\\-—|:.]*${escaped}[\\s\\-—|:.]*$`, 'i');
  if (trailing.test(raw)) {
    return raw.replace(trailing, '').trim().replace(/\s+$/, '');
  }
  return raw;
}

function sanitizeCtaText(value) {
  return String(value || '').trim().replace(/[!?]/g, '');
}

function hasNormalizedEngagement(post = {}) {
  const comment = toPlainString(post.engagementScripts?.commentReply);
  const dm = toPlainString(post.engagementScripts?.dmReply);
  return Boolean(comment) && Boolean(dm);
}

function ensureEngagementScriptsFallback(post = {}, nicheStyle = '') {
  const scripts = post.engagementScripts || {};
  const commentCandidate = toPlainString(
    scripts.commentReply || scripts.comment || post.engagementScript || post.engagement_comment
  );
  const dmCandidate = toPlainString(
    scripts.dmReply || scripts.dm || post.engagementDm || post.engagement_dm
  );
  const topic = toPlainString(post.title || post.idea || post.hook || nicheStyle || 'this topic');
  const topicLabel = topic || 'this topic';
  return {
    commentReply: commentCandidate || `Appreciate you noticing this idea about ${topicLabel}.`,
    dmReply: dmCandidate || `Happy to keep unpacking ${topicLabel}.`,
  };
}

function ensureCtaFallback(post = {}) {
  const normalizedCta =
    sanitizeCtaText(post.cta) ||
    sanitizeCtaText(post.callToAction) ||
    sanitizeCtaText(post.call_to_action) ||
    sanitizeCtaText(post.cta_text);
  if (normalizedCta) return normalizedCta;
  const pillar = String(post.pillar || '').toLowerCase();
  const format = String(post.format || post.platform || '').toLowerCase();
  const promoSlot = !!post.promoSlot;
  if (promoSlot || pillar.includes('promo')) return 'Book now';
  if (pillar.includes('social proof') || pillar.includes('proof')) return 'See the proof';
  if (pillar.includes('engagement')) return 'Share your take';
  if (format.includes('story') || format.includes('reel')) return 'Watch this';
  if (format.includes('static')) return 'Check it out';
  return 'Learn more';
}

const MIN_HASHTAGS = 6;

function isNonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function validatePostCompleteness(post = {}) {
  const missing = [];
  const checkString = (value, key) => {
    if (!isNonEmptyString(value) && !missing.includes(key)) {
      missing.push(key);
    }
  };
  checkString(post.title, 'title');
  checkString(post.hook, 'hook');
  checkString(post.caption, 'caption');
  checkString(post.cta, 'cta');
  checkString(post.storyPrompt, 'storyPrompt');
  checkString(post.designNotes, 'designNotes');
  if (!Number.isFinite(Number(post.day))) missing.push('day');

  const hashtags = Array.isArray(post.hashtags) ? post.hashtags : [];
  const validHashtags = hashtags
    .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
    .filter(Boolean);
  if (validHashtags.length < MIN_HASHTAGS) missing.push('hashtags');

  const scriptCandidate = post.script || post.videoScript;
  if (!scriptCandidate) {
    missing.push('script');
  } else {
    checkString(scriptCandidate.hook, 'script.hook');
    checkString(scriptCandidate.body, 'script.body');
    checkString(scriptCandidate.cta, 'script.cta');
  }

  const reelCandidate = post.reelScript || post.reel_script || post.script || post.videoScript;
  if (!reelCandidate) {
    missing.push('reelScript');
  } else {
    checkString(reelCandidate.hook, 'reelScript.hook');
    checkString(reelCandidate.body, 'reelScript.body');
    checkString(reelCandidate.cta, 'reelScript.cta');
  }

  const engagement = post.engagementScripts;
  if (!engagement) {
    missing.push('engagementScripts');
  } else {
    checkString(engagement.commentReply, 'engagementScripts.commentReply');
    checkString(engagement.dmReply, 'engagementScripts.dmReply');
  }

  return missing;
}

function stripSuggestedAudioLinks(value = '') {
  let text = String(value || '').trim();
  if (!text) return '';
  text = text.replace(/\([^)]*(https?:\/\/|link:)[^)]*\)/gi, '');
  text = text.replace(/\bhttps?:\/\/\S+/gi, '');
  text = text.replace(/\blink:\s*\S+/gi, '');
  text = text.replace(/@[A-Za-z0-9._-]+/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function splitSuggestedAudioTitleArtist(text = '') {
  const cleaned = stripSuggestedAudioLinks(text).trim();
  if (!cleaned) return { title: '', artist: '' };
  const parts = cleaned.split(/\s+—\s+|\s+-\s+/);
  if (parts.length <= 1) return { title: cleaned, artist: '' };
  const title = parts.shift().trim();
  const artist = parts.join(' - ').trim();
  return { title, artist };
}

function normalizeSuggestedAudioFromText(text = '') {
  return splitSuggestedAudioTitleArtist(String(text || ''));
}

function sanitizeSuggestedAudioEntry(entry = {}) {
  const title = stripSuggestedAudioLinks(entry.title || entry.name || entry.sound || entry.track || '');
  const artist = stripSuggestedAudioLinks(entry.artist || entry.creator || entry.by || '');
  return { title, artist };
}

function normalizeSuggestedAudioValue(candidate, fallbackEntry = null) {
  const fallback = fallbackEntry || getEvergreenFallbackList()[0] || { title: 'Top track', artist: 'Billboard Hot 100' };
  const fallbackString = normalizeAudioString(fallback.title, fallback.artist);
  if (!candidate) {
    return fallbackString;
  }
  if (typeof candidate === 'string') {
    const parsed = normalizeSuggestedAudioFromText(candidate);
    return normalizeAudioString(parsed.title || fallback.title, parsed.artist || fallback.artist);
  }
  if (candidate && typeof candidate === 'object') {
    const hasDirect = candidate.title || candidate.name || candidate.track;
    if (hasDirect) {
      const sanitized = sanitizeSuggestedAudioEntry(candidate);
      return normalizeAudioString(sanitized.title || fallback.title, sanitized.artist || fallback.artist);
    }
    const sanitized = sanitizeSuggestedAudioEntry(candidate);
    return normalizeAudioString(sanitized.title || fallback.title, sanitized.artist || fallback.artist);
  }
  return fallbackString;
}

function fillMissingFieldsFromFallback(post = {}, fallback = {}, missingFields = [], nicheStyle = '') {
  const missingSet = new Set(missingFields || []);
  if (missingSet.has('title')) post.title = post.title || fallback.title;
  if (missingSet.has('hook')) post.hook = post.hook || fallback.hook;
  if (missingSet.has('caption')) post.caption = post.caption || fallback.caption;
  if (missingSet.has('cta')) post.cta = post.cta || fallback.cta;
  if (missingSet.has('storyPrompt')) post.storyPrompt = post.storyPrompt || fallback.storyPrompt;
  if (missingSet.has('designNotes')) post.designNotes = post.designNotes || fallback.designNotes;
  if (missingSet.has('hashtags')) {
    post.hashtags = Array.isArray(post.hashtags) && post.hashtags.length
      ? post.hashtags
      : buildFallbackHashtagList(nicheStyle || fallback.nicheStyle || '', post.format || 'Reel');
  }
  if (missingSet.has('script') || missingSet.has('script.hook') || missingSet.has('script.body') || missingSet.has('script.cta')) {
    post.script = {
      hook: post.script?.hook || fallback.script?.hook || fallback.hook,
      body: post.script?.body || fallback.script?.body || fallback.caption,
      cta: post.script?.cta || fallback.script?.cta || fallback.cta,
    };
  }
  if (missingSet.has('reelScript') || missingSet.has('reelScript.hook') || missingSet.has('reelScript.body') || missingSet.has('reelScript.cta')) {
    post.reelScript = post.reelScript || post.script || fallback.script || {};
  }
  if (missingSet.has('engagementScripts') || missingSet.has('engagementScripts.commentReply') || missingSet.has('engagementScripts.dmReply')) {
    post.engagementScripts = post.engagementScripts || fallback.engagementScripts;
  }
  return post;
}

function ensureRegenRequiredFields(rawPost = {}, nicheStyle = '', dayNumber = 1) {
  const normalized = normalizePostWithOverrideFallback(rawPost, 0, dayNumber, dayNumber, nicheStyle);
  const applied = [];
  if (!isNonEmptyString(normalized.title)) {
    normalized.title = normalized.idea || `Day ${String(dayNumber).padStart(2, '0')} idea`;
    applied.push('title');
  }
  if (!isNonEmptyString(normalized.hook)) {
    normalized.hook = `Start with ${normalized.idea || 'a key insight'}.`;
    applied.push('hook');
  }
  normalized.cta = ensureCtaFallback(normalized);
  if (!isNonEmptyString(normalized.caption)) {
    normalized.caption = `${normalized.hook} ${normalized.cta}.`.trim();
    applied.push('caption');
  }
  if (!isNonEmptyString(normalized.storyPrompt)) {
    normalized.storyPrompt = ensureStoryPromptFallback(normalized, nicheStyle);
    applied.push('storyPrompt');
  }
  normalized.storyPromptPlus = ensureStoryPromptPlusFallback(normalized, nicheStyle);
  normalized.storyPromptExpanded = sanitizeStoryPromptPlus(nicheStyle, normalized.storyPromptPlus, normalized);
  if (!isNonEmptyString(normalized.designNotes)) {
    normalized.designNotes = ensureDesignNotesFallback(normalized, nicheStyle);
    applied.push('designNotes');
  }
  if (!isNonEmptyString(normalized.distributionPlan)) {
    normalized.distributionPlan = buildDistributionPlanFallback(normalized, nicheStyle);
    applied.push('distributionPlan');
  }
  normalized.engagementScripts = ensureEngagementScriptsFallback(normalized, nicheStyle);
  const scriptBase = {
    hook: normalized.script?.hook || normalized.hook,
    body: normalized.script?.body || normalized.caption || normalized.idea,
    cta: normalized.script?.cta || normalized.cta,
  };
  normalized.script = scriptBase;
  normalized.videoScript = normalized.videoScript && normalized.videoScript.hook ? normalized.videoScript : scriptBase;
  normalized.reelScript = normalized.reelScript || scriptBase;
  const fallbackAudio = getEvergreenFallbackList()[0] || { title: 'Top track', artist: 'Billboard Hot 100' };
  normalized.suggestedAudio = normalizeSuggestedAudioValue(
    normalized.suggestedAudio || rawPost.suggestedAudio || rawPost.suggested_audio,
    fallbackAudio
  );
  let missing = validatePostCompleteness(normalized);
  if (missing.length) {
    const fallback = buildFallbackPost(nicheStyle, dayNumber);
    fillMissingFieldsFromFallback(normalized, fallback, missing, nicheStyle);
    missing = validatePostCompleteness(normalized);
  }
  return { post: normalized, missingFields: missing, appliedFixes: applied };
}

function runRegenNormalizationSelfTest() {
  if (isProduction) return;
  const sample = 'Calm Down — Rema (link: https://tiktok.com)';
  const parsed = normalizeSuggestedAudioFromText(sample);
  if (!parsed.title || !parsed.artist) {
    console.warn('[Calendar][Test] suggested audio normalize failed', { parsed });
  }
  const repaired = ensureRegenRequiredFields({ day: 1, idea: 'Test idea' }, 'Test niche', 1);
  if (repaired.missingFields.length) {
    console.warn('[Calendar][Test] regen normalization missing fields', repaired.missingFields);
  }
}

if (!isProduction) {
  runRegenNormalizationSelfTest();
}

function computePostCountTarget(days, postsPerDay) {
  const safeDays = Number.isFinite(Number(days)) ? Number(days) : null;
  const safePerDay = Number.isFinite(Number(postsPerDay)) ? Number(postsPerDay) : null;
  if (safeDays && safePerDay) {
    return Math.max(1, Math.round(safeDays)) * Math.max(1, Math.round(safePerDay));
  }
  return null;
}

function computePostDayIndex(index, startDay = 1, postsPerDay = 1) {
  const baseStart = Number.isFinite(Number(startDay)) ? Number(startDay) : 1;
  const perDay = Number.isFinite(Number(postsPerDay)) && Number(postsPerDay) > 0 ? Number(postsPerDay) : 1;
  return baseStart + Math.floor(index / perDay);
}

function buildFallbackPost(nicheStyle = '', day = 1) {
  const normalizedNiche = toPlainString(nicheStyle || 'this niche').trim();
  const sanitizedNiche = normalizedNiche || 'this niche';
  const idea = `Placeholder idea about ${sanitizedNiche}`;
  const baseHashtag = sanitizedNiche.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'niche';
  return {
    day,
    idea,
    title: idea,
    type: 'lifestyle',
    hook: `Share a quick tip about ${sanitizedNiche}.`,
    caption: `Walk through why ${sanitizedNiche} matters and how to approach it.`,
    hashtags: [`#${baseHashtag}`],
    format: 'Reel',
    formatIntent: '',
    cta: 'Let me know what you think.',
    pillar: 'Lifestyle',
    storyPrompt: `Talk briefly about ${sanitizedNiche} and invite a reaction.`,
    storyPromptPlus: `Add proof or context on ${sanitizedNiche} and ask what viewers would try next?`,
    designNotes: 'Neutral background with subtle motion.',
    repurpose: [],
    analytics: [],
    engagementScripts: { commentReply: 'Thanks! What would you try next?', dmReply: 'Happy to share more details.' },
    promoSlot: false,
    weeklyPromo: '',
    script: { hook: 'Quick hook', body: 'Explain the idea fast.', cta: 'Ask for feedback.' },
    instagram_caption: '',
    tiktok_caption: '',
    linkedin_caption: '',
    audio: '',
    strategy: {
      angle: `Placeholder angle for ${sanitizedNiche}`,
      objective: 'engagement',
      target_saves_pct: 3,
      target_comments_pct: 2,
      pinned_keyword: 'IDEA',
      pinned_deliverable: 'Checklist',
      hook_options: ['Hook 1', 'Hook 2', 'Hook 3'],
      pinned_comment: `Tell me what you think.`,
    },
    distributionPlan: '',
  };
}

const STORY_PROMPT_PLUS_ALIASES = [
  'storyPromptPlus',
  'storyPromptPlusInstructions',
  'storyPromptPlusPrompt',
  'storyPromptPlusText',
  'storyPrompt+',
  'story prompt plus',
  'story_prompt_plus',
  'story_prompt_plus_instructions',
  'story_prompt_plus_prompt',
  'story_prompt_plus_text',
  'storyPromptExpanded',
  'story_prompt_expanded',
];

const DISTRIBUTION_PLAN_ALIASES = [
  'distributionPlan',
  'distribution_plan',
  'distribution plan',
  'distributionPlanSteps',
  'distribution_plan_steps',
  'distributionPlanText',
];

function resolveStoryPromptPlusValue(post = {}) {
  for (const key of STORY_PROMPT_PLUS_ALIASES) {
    if (!Object.prototype.hasOwnProperty.call(post, key)) continue;
    const value = post[key];
    const trimmed = toPlainString(value);
    if (trimmed && !PLACEHOLDER_PROMPT_REGEX.test(trimmed)) return trimmed;
  }
  return '';
}

function resolveDistributionPlanValue(post = {}) {
  for (const key of DISTRIBUTION_PLAN_ALIASES) {
    if (!Object.prototype.hasOwnProperty.call(post, key)) continue;
    const value = post[key];
    const trimmed = toPlainString(value);
    if (trimmed && !DISTRIBUTION_PLACEHOLDER_REGEX.test(trimmed)) return trimmed;
  }
  return '';
}

function buildDistributionPlanFallback(post = {}) {
  const idea = toPlainString(post.idea || post.title || 'this idea');
  const topic = toPlainString(post.topic || post.caption || 'the topic');
  const cta = toPlainString(post.cta || 'Share what you think.');
  const ctaClause = cta.endsWith('?') ? cta : `${cta}.`;
  const plan = [
    `Explain how the hook and ${idea} lead into the CTA clause, naming the key action or insight each step highlights without quoting the hook.`,
    `List two concrete visual beats tied to ${topic}, mentioning specific moments, motions, or props that reinforce the story.`,
    `Outline a caption path: one sentence stating the insight, one sentence with a supporting detail, and the CTA clause that closes the idea.`,
  ];
  return plan.join(' ');
}

function buildStoryPromptPlusFromPost(post = {}, nicheStyle = '') {
  const format = toPlainString(post.format || 'Reel') || 'Reel';
  const topic = toPlainString(post.topic || post.idea || post.caption || post.title || 'today’s insight');
  const niche = toPlainString(nicheStyle || 'this niche');
  const hook = toPlainString(post.hook || '');
  const angle = toPlainString(post.angle || '');
  const detail = hook || angle || topic;
  const cta = toPlainString(post.cta || 'What would you try next?');
  const question = cta.endsWith('?') ? cta : `${cta}?`;
  const base = toPlainString(post.storyPrompt || detail);
  return `Shape a ${format} story for ${niche} about ${base}: describe the turning point, what changed, and ask ${question}`;
}

function extractSuggestedAudioFromPost(post = {}) {
  if (!post || typeof post !== 'object') return null;
  const candidate = post.suggestedAudio ?? post.suggested_audio;
  if (!candidate) return null;
  if (typeof candidate === 'string') {
    return candidate.trim();
  }
  if (typeof candidate === 'object') {
    const normalized = normalizeSuggestedAudioValue(candidate);
    return normalized || null;
  }
  return null;
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
  const platform = toPlainString(post.format || post.platform || 'Reel');
  const fallbackHashtags = buildFallbackHashtagList(nicheStyle, platform);
  const hashtags = ensureHashtagArray(post.hashtags || [], fallbackHashtags, 8);
  const repurpose = ensureStringArray(post.repurpose || [], ['Reel -> Remix with new hook', 'Reel -> Clip as teaser'], 2);
  const analytics = ensureStringArray(post.analytics || [], ['Reach', 'Saves'], 2);
  const scriptSource = post.script || post.videoScript || post.reelScript || {};
  const script = normalizeScriptObject(scriptSource);
  const videoScript = { ...script };
  const engagementComment = toPlainString(post.engagementScripts?.commentReply || post.engagementScript || '') || '';
  const engagementDm = toPlainString(post.engagementScripts?.dmReply || '') || '';
  const rawStoryPrompt = resolveStoryPromptValue(post);
  let storyPrompt = ensureStoryPromptMatchesNiche(nicheStyle, rawStoryPrompt, hashtags);
  if (!storyPrompt) {
    storyPrompt = ensureStoryPromptMatchesNiche(nicheStyle, buildStoryPromptFromPost(post, nicheStyle), hashtags);
  }
  const rawStoryPromptPlus = resolveStoryPromptPlusValue(post);
  let storyPromptPlus = ensureStoryPromptMatchesNiche(nicheStyle, rawStoryPromptPlus, hashtags);
  if (!storyPromptPlus) {
    storyPromptPlus = ensureStoryPromptMatchesNiche(nicheStyle, buildStoryPromptPlusFromPost(post, nicheStyle), hashtags);
  }
  let distributionPlan = resolveDistributionPlanValue(post);
  if (!distributionPlan) {
    distributionPlan = buildDistributionPlanFallback(post, nicheStyle);
  }
  const normalized = {
    day: typeof post.day === 'number' ? post.day : fallbackDay,
    idea: toPlainString(post.idea || post.title || 'Engaging post idea'),
    title: toPlainString(post.title || post.idea || ''),
    type: toPlainString(post.type || 'educational'),
    hook: toPlainString(post.hook || script.hook || ''),
    caption: toPlainString(post.caption || ''),
    hashtags,
    format: 'Reel',
    formatIntent: toPlainString(post.formatIntent || ''),
    cta: toPlainString(post.cta || ''),
    pillar: toPlainString(post.pillar || 'Education'),
    storyPrompt,
    storyPromptPlus,
    designNotes: toPlainString(post.designNotes || ''),
    repurpose,
    analytics,
    engagementScripts: { commentReply: engagementComment, dmReply: engagementDm },
    promoSlot: typeof post.promoSlot === 'boolean' ? post.promoSlot : !!post.weeklyPromo,
    weeklyPromo: typeof post.weeklyPromo === 'string' ? post.weeklyPromo : '',
    script,
    videoScript,
    instagram_caption: toPlainString(post.instagram_caption || post.caption || ''),
    tiktok_caption: toPlainString(post.tiktok_caption || post.caption || ''),
    linkedin_caption: toPlainString(post.linkedin_caption || post.caption || ''),
    audio: toPlainString(post.audio || ''),
    strategy: post.strategy || {},
    distributionPlan,
    suggestedAudio: extractSuggestedAudioFromPost(post),
  };
  if (!normalized.promoSlot) normalized.weeklyPromo = '';
  normalized.cta = ensureCtaFallback(normalized);
  normalized.engagementScripts = ensureEngagementScriptsFallback(normalized, nicheStyle);
  return normalized;
}

const STORY_PROMPT_OVERRIDE_KEYS = [
  'storyPromptKeywordOverride',
  'storyPromptKeyword',
  'storyPromptOverride',
];
const STORY_PROMPT_KEYWORD_OVERRIDE_WARNING = 'STORY_PROMPT_KEYWORD_OVERRIDE_SKIPPED';

function getStoryPromptOverrideValue(post = {}) {
  for (const key of STORY_PROMPT_OVERRIDE_KEYS) {
    const candidate = post?.[key];
    if (candidate === null || candidate === undefined) continue;
    if (Array.isArray(candidate)) {
      if (candidate.some((item) => String(item || '').trim())) return candidate;
      continue;
    }
    if (String(candidate).trim()) return candidate;
  }
  return null;
}

function removeStoryPromptOverrideFields(post = {}) {
  const sanitized = { ...(post || {}) };
  STORY_PROMPT_OVERRIDE_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(sanitized, key)) delete sanitized[key];
  });
  return sanitized;
}

function computeOverrideDay(post = {}, idx = 0, startDay = 1) {
  if (typeof post?.day === 'number') return post.day;
  if (Number.isFinite(startDay)) {
    return Number(startDay) + idx;
  }
  return idx + 1;
}

function pushOverrideWarning(loggingContext = {}, day = null) {
  if (!Array.isArray(loggingContext.warnings)) return;
  loggingContext.warnings.push({
    code: STORY_PROMPT_KEYWORD_OVERRIDE_WARNING,
    requestId: loggingContext.requestId || 'unknown',
    day,
  });
}

function normalizePostWithOverrideFallback(post, idx = 0, startDay = 1, forcedDay, nicheStyle = '', loggingContext = {}) {
  const rawOverride = getStoryPromptOverrideValue(post);
  const overrideDay = computeOverrideDay(post, idx, startDay);
  if (rawOverride) {
    const validated = validateStoryPromptKeywordOverride(rawOverride, loggingContext);
    if (!validated) {
      pushOverrideWarning(loggingContext, overrideDay);
      return normalizePost(removeStoryPromptOverrideFields(post), idx, startDay, forcedDay, nicheStyle);
    }
  }
    try {
      return normalizePost(post, idx, startDay, forcedDay, nicheStyle);
    } catch (err) {
      const isOverrideError = String(err?.message || '').includes(STORY_PROMPT_KEYWORD_OVERRIDE_VALIDATE_FAILED);
      if (!isOverrideError) throw err;
      const contextMeta = {
        requestId: loggingContext?.requestId || 'unknown',
        userId: loggingContext?.userId || null,
        niche: nicheStyle,
        day: overrideDay,
      };
      console.warn('[Calendar] Story prompt override invalid, continuing without it', {
        ...contextMeta,
        message: err.message,
      });
      const sanitized = removeStoryPromptOverrideFields(post);
      try {
        return normalizePost(sanitized, idx, startDay, forcedDay, nicheStyle);
      } catch (fallbackErr) {
        const fallbackDay = computePostDayIndex(idx, startDay);
        console.warn('[Calendar] Story prompt override fallback failed, using fallback post', {
          ...contextMeta,
          message: fallbackErr.message,
        });
        pushOverrideWarning(loggingContext, overrideDay);
        const fallbackPost = buildFallbackPost(nicheStyle, fallbackDay);
        return fallbackPost;
      }
    }
}

const buildDistributionPlanText = (post = {}) => toPlainString(post.distributionPlan || '');

const buildStoryPromptExpanded = (post = {}) => {
  const text = toPlainString(post.storyPromptExpanded);
  return sanitizeStoryPromptPlus(post.niche || post.nicheStyle || '', text, post);
};

const enrichRegenPost = (post = {}, dayIndex = 0) => {
  const enriched = { ...post };
  enriched.distributionPlan = buildDistributionPlanText(post);
  enriched.storyPromptExpanded = buildStoryPromptExpanded(post);
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
  const maxTokenCap = opts.reduceVerbosity ? 1400 : 1600;
  const requestedTokens =
    Number.isFinite(Number(opts.maxTokens)) && Number(opts.maxTokens) > 0
      ? Number(opts.maxTokens)
      : maxTokenCap;
  const maxTokens = Math.min(requestedTokens, maxTokenCap);
  const chunkDays = Number.isFinite(Number(opts.days)) && Number(opts.days) > 0 ? Number(opts.days) : 1;
  const chunkStartDay = Number.isFinite(Number(opts.startDay)) ? Number(opts.startDay) : 1;
  const postsPerDay = Number.isFinite(Number(opts.postsPerDay)) && Number(opts.postsPerDay) > 0 ? Number(opts.postsPerDay) : 1;
  const expectedChunkCount = chunkDays * postsPerDay;
    const schema = buildCalendarSchemaObject(
    expectedChunkCount,
    chunkStartDay,
    Number.isFinite(Number(chunkStartDay + chunkDays - 1)) ? chunkStartDay + chunkDays - 1 : chunkStartDay
  );
  const debugEnabled = process.env.DEBUG_AI_PARSE === '1';
  const extractContentText = (json) => {
    const messageContent = json?.choices?.[0]?.message?.content;
    if (!messageContent) return '';
    if (typeof messageContent === 'string') return messageContent;
    if (Array.isArray(messageContent)) {
      return messageContent
        .map((item) => {
          if (typeof item === 'string') return item;
          if (typeof item?.text === 'string') return item.text;
          if (typeof item?.value === 'string') return item.value;
          if (typeof item?.content === 'string') return item.content;
          return '';
        })
        .filter(Boolean)
        .join('');
    }
    if (typeof messageContent?.text === 'string') return messageContent.text;
    if (typeof messageContent?.value === 'string') return messageContent.value;
    return '';
  };
  const buildRequestOptions = (payload) => ({
    hostname: 'api.openai.com',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  });
  const attemptStart = Date.now();
  const contextLabel = formatCalendarLogContext(loggingContext);
  const label = contextLabel ? ` (${contextLabel})` : '';
  const previewJson = (value = '') => {
    if (!value) return '';
    const snippet = String(value);
    return snippet.length <= 500 ? snippet : `${snippet.slice(0, 500)}...`;
  };
  const logParseFailure = (phase, reason, content) => {
    const message = reason ? String(reason).substring(0, 120) : 'parse failure';
    console.warn(
      `[Calendar] callOpenAI parse ${phase} failure${label}: ${message}; preview: ${previewJson(content)}`
    );
  };
  const attemptRequest = async (extraInstructions = '') => {
    const attemptTimestamp = Date.now();
    const attemptOpts = {
      ...opts,
      days: chunkDays,
      startDay: chunkStartDay,
      postsPerDay,
      extraInstructions,
    };
    const prompt = buildPrompt(nicheStyle, brandContext, attemptOpts);
    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: maxTokens,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'calendar_batch',
          strict: true,
          schema,
        },
      },
    });
    const requestPromise = withOpenAiSlot(() => openAIRequest(buildRequestOptions(payload), payload));
    const timeoutPromise = new Promise((_, reject) => {
      const timeoutId = setTimeout(() => {
        const timeoutErr = new Error('OpenAI request timed out');
        timeoutErr.code = 'OPENAI_TIMEOUT';
        reject(timeoutErr);
      }, OPENAI_GENERATION_TIMEOUT_MS);
      requestPromise.finally(() => clearTimeout(timeoutId));
    });
    const json = await Promise.race([requestPromise, timeoutPromise]);
    const content = extractContentText(json);
    if (debugEnabled) {
      console.log('[CALENDAR PARSE] chunk schema response length', (content || '').length);
    }
    return { content, latency: Date.now() - attemptTimestamp };
  };

  try {
    let lastLatency = 0;
    let parsedContent = '';
    let parseResult = null;

    const firstResponse = await attemptRequest('');
    parsedContent = firstResponse.content;
    lastLatency = firstResponse.latency;
    parseResult = tryParsePosts(parsedContent, expectedChunkCount);

    if (!parseResult.posts) {
      logParseFailure('initial', parseResult?.reason || 'missing posts', parsedContent);
      const sanitized = sanitizeJsonContent(parsedContent);
      if (sanitized && sanitized !== parsedContent) {
        parsedContent = sanitized;
        parseResult = tryParsePosts(parsedContent, expectedChunkCount);
      }
    }

    if (!parseResult.posts) {
      logParseFailure('retry', parseResult?.reason || 'missing posts', parsedContent);
      const retryInstructions =
        'If the previous response failed, return ONLY JSON in the form { "posts": [ ... ] } and do not add any explanation.';
      const retryResponse = await attemptRequest(retryInstructions);
      parsedContent = retryResponse.content;
      lastLatency = retryResponse.latency;
      parseResult = tryParsePosts(parsedContent, expectedChunkCount);
      if (!parseResult.posts) {
        const sanitizedRetry = sanitizeJsonContent(parsedContent);
        if (sanitizedRetry && sanitizedRetry !== parsedContent) {
          parsedContent = sanitizedRetry;
          parseResult = tryParsePosts(parsedContent, expectedChunkCount);
        }
      }
    }

    if (parseResult && parseResult.posts) {
      return {
        posts: parseResult.posts,
        rawContent: parsedContent,
        latency: lastLatency,
      };
    }

    const fallbackReason = parseResult ? parseResult.reason : 'unknown reason';
    console.warn(`[Calendar] callOpenAI parse fallback${label}: ${fallbackReason}`);
  } catch (err) {
    console.warn(`[Calendar] callOpenAI failed${label}:`, err.message);
  }

  const fallbackPosts = buildFallbackChunkPosts(nicheStyle, chunkStartDay, postsPerDay, expectedChunkCount);
  console.warn(
    `[Calendar] callOpenAI returning fallback posts${label}: expected ${expectedChunkCount}, returning ${fallbackPosts.length}`
  );
  return {
    posts: fallbackPosts,
    rawContent: '',
    latency: Date.now() - attemptStart,
    fallback: true,
  };
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

const BRAND_BRAIN_DEFAULT_SETTINGS = {
  enabled: false,
};

function normalizeBrandBrainSettings(input = {}) {
  return { enabled: Boolean(input?.enabled) };
}

async function fetchBrandBrainSettings(userId) {
  if (!userId || !supabaseAdmin) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('profile_settings')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const settings = data?.profile_settings || {};
    const enabled = Boolean(settings?.brand_brain_enabled);
    return normalizeBrandBrainSettings({ enabled });
  } catch (err) {
    console.error('[BrandBrain] settings fetch failed', err?.message || err);
    return null;
  }
}

async function upsertBrandBrainSettings(userId, settings) {
  if (!userId || !supabaseAdmin) return null;
  try {
    const payload = normalizeBrandBrainSettings(settings);
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('profile_settings')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    const current = data?.profile_settings && typeof data.profile_settings === 'object'
      ? data.profile_settings
      : {};
    const nextSettings = { ...current, brand_brain_enabled: payload.enabled };
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({ profile_settings: nextSettings, updated_at: new Date().toISOString() })
      .eq('id', userId)
      .select('profile_settings')
      .maybeSingle();
    if (updateError) throw updateError;
    const enabled = Boolean(updated?.profile_settings?.brand_brain_enabled);
    return normalizeBrandBrainSettings({ enabled });
  } catch (err) {
    console.error('[BrandBrain] settings upsert failed', err?.message || err);
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
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://unpkg.com https://cdn.jsdelivr.net/npm/@supabase https://cdn.getphyllo.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https://usepromptly.app https://res.cloudinary.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://api.openai.com https://*.supabase.co https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://fonts.gstatic.com https://api.insightiq.ai https://api.getphyllo.com; frame-src 'self' https://connect.getphyllo.com; frame-ancestors 'none';");
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
  async function generateCalendarPosts(payload = {}, attempt = 1) {
    const { nicheStyle, userId, days, startDay, postsPerDay, context } = payload;
    const loggingContext = context || {};
    if (userId) loggingContext.userId = userId;
    const tStart = Date.now();
    console.log('[Calendar][Server][Perf] generateCalendarPosts start', {
      nicheStyle,
      userId: !!userId,
      days,
      startDay,
      postsPerDay,
      context: loggingContext,
      attempt,
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
    const brandBrainSettings = userId ? await fetchBrandBrainSettings(userId) : null;
    const brandBrainDirective = brandBrainSettings?.enabled
      ? buildBrandBrainDirective(brandBrainSettings)
      : '';
    console.log('[BrandBrain] generation mode enabled=%s', Boolean(brandBrainDirective));
    const callStart = Date.now();
    console.log('[Calendar][Server][Perf] callOpenAI start', {
      nicheStyle,
      days,
      startDay,
      postsPerDay,
      context: loggingContext,
    });
    const logContext = {
      requestId: loggingContext?.requestId || 'unknown',
      days,
      startDay,
      postsPerDay,
    };
    const safeDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : null;
    const safePostsPerDay =
      Number.isFinite(Number(postsPerDay)) && Number(postsPerDay) > 0 ? Number(postsPerDay) : null;
    const perDay = safePostsPerDay || 1;
    const targetCount = computePostCountTarget(days, postsPerDay);
    const expectedCount = Number.isFinite(Number(targetCount)) ? targetCount : null;
    const fallbackStart = Number.isFinite(Number(startDay)) ? Number(startDay) : 1;
    const daysToGenerate = safeDays || (targetCount ? Math.max(1, Math.ceil(targetCount / perDay)) : 1);
    const chunkLimit = Math.max(1, OPENAI_CHUNK_MAX_DAYS);
    const incomingSignatures = Array.isArray(payload.usedSignatures) ? payload.usedSignatures : [];
    const normalizedUsedSignatures = Array.from(new Set(incomingSignatures.map((sig) => normalizeCalendarSignature(sig)).filter(Boolean)));
    const chunkMetrics = [];
    let aggregatedRawPosts = [];
    let remainingDays = daysToGenerate;
    let processedDays = 0;
    const chunkBaseTokens = 1600;
    const chunkMinTokens = 1000;

    async function fetchChunk(chunkDays, chunkStartDay, chunkIndex) {
      const chunkContext = { ...loggingContext, chunkIndex, chunkStartDay };
      const chunkMaxTokens = Math.max(chunkMinTokens, chunkBaseTokens);
      const result = await callOpenAI(nicheStyle, brandContext, {
        days: chunkDays,
        startDay: chunkStartDay,
        postsPerDay: perDay,
        loggingContext: chunkContext,
        maxTokens: chunkMaxTokens,
        reduceVerbosity: true,
        usedSignatures: normalizedUsedSignatures,
        brandBrainDirective,
      });
      return {
        posts: Array.isArray(result.posts) ? result.posts : [],
        rawLength: String(result.rawContent || '').length,
        latency: result.latency || 0,
      };
    }

    while (remainingDays > 0) {
      const chunkDays = Math.min(remainingDays, chunkLimit);
      const chunkStartDay = fallbackStart + processedDays;
      const chunkIndex = chunkMetrics.length;
      const chunkResult = await fetchChunk(chunkDays, chunkStartDay, chunkIndex);
      aggregatedRawPosts = aggregatedRawPosts.concat(chunkResult.posts || []);
      chunkMetrics.push({
        chunkIndex,
        startDay: chunkStartDay,
        days: chunkDays,
        rawLength: chunkResult.rawLength,
        duration: chunkResult.latency,
        timeoutMs: OPENAI_GENERATION_TIMEOUT_MS,
      });
      remainingDays -= chunkDays;
      processedDays += chunkDays;
    }
    console.log('[Calendar][Server][Chunks]', {
      requestId: logContext.requestId,
      startDay,
      days,
      postsPerDay,
      chunkCount: chunkMetrics.length,
      timeoutMs: OPENAI_GENERATION_TIMEOUT_MS,
      chunkDetails: chunkMetrics,
    });
    const rawLength = chunkMetrics.reduce((sum, chunk) => sum + (chunk.rawLength || 0), 0);

    const rawPosts = aggregatedRawPosts;
    if (expectedCount && rawPosts.length !== expectedCount) {
      const err = new Error('Calendar response count mismatch');
      err.code = 'OPENAI_SCHEMA_ERROR';
      err.statusCode = 500;
      err.details = {
        expectedCount,
        actualCount: rawPosts.length,
      };
      console.warn('[Calendar][Server][SchemaValidation] count mismatch', {
        requestId: loggingContext?.requestId,
        startDay,
        days,
        postsPerDay,
        ...err.details,
        responseLength: rawLength,
      });
      err.schemaSnippet = buildCalendarSchemaBlock(expectedCount);
      throw err;
    }
    const missingFieldsReport = [];
    rawPosts.forEach((post, idx) => {
      const missing = validatePostCompleteness(post);
      if (!missing.length) return;
      const day = Number.isFinite(Number(post.day)) ? Number(post.day) : computePostDayIndex(idx, fallbackStart, perDay);
      const slot = perDay > 1 ? ((idx % perDay) + 1) : 1;
      missingFieldsReport.push({ index: idx, day, slot, missing });
    });
    if (missingFieldsReport.length) {
      const err = new Error('Calendar response missing required fields');
      err.code = 'OPENAI_SCHEMA_ERROR';
      err.statusCode = 500;
      err.details = missingFieldsReport;
      console.warn('[Calendar][Server][SchemaValidation] missing required fields', {
        requestId: loggingContext?.requestId,
        startDay,
        days,
        postsPerDay,
        expectedCount,
        actualCount: rawPosts.length,
        missingFields: missingFieldsReport.length,
        responseLength: rawLength,
        detailSamples: missingFieldsReport.slice(0, 3),
      });
      throw err;
    }
    console.log('[Calendar][Server][SchemaValidation]', {
      requestId: loggingContext?.requestId,
      startDay,
      days,
      postsPerDay,
      expectedCount: expectedCount || rawPosts.length,
      actualCount: rawPosts.length,
      missingFieldsBefore: missingFieldsReport.length,
      missingFieldsAfter: 0,
      retryUsed: false,
      responseLength: rawLength,
    });
    if (!rawPosts.length) {
      console.warn('[Calendar] No posts returned across chunks', logContext);
    }
    const openDuration = Date.now() - callStart;
    const openAiLatency = chunkMetrics.reduce((max, chunk) => Math.max(max, chunk.duration || 0), 0);
    const validationStart = Date.now();
    const normalizedPosts = [];
    for (let idx = 0; idx < rawPosts.length; idx += 1) {
      const normalized = normalizePostWithOverrideFallback(rawPosts[idx], idx, startDay, undefined, nicheStyle, loggingContext);
      if (normalized) normalizedPosts.push(normalized);
    }
    let posts = normalizedPosts;
    const signatureSet = new Set(normalizedUsedSignatures);
    const duplicates = [];
    for (const post of posts) {
      const signature = normalizeCalendarSignature(post.title);
      if (!signature) continue;
      if (signatureSet.has(signature)) {
        duplicates.push({ day: post.day, signature });
      } else {
        signatureSet.add(signature);
      }
    }
    if (duplicates.length) {
      console.warn('[Calendar] duplicate signatures detected; continuing', {
        requestId: loggingContext?.requestId,
        startDay,
        days,
        duplicates,
      });
    }
    posts.forEach((post) => {
      post.storyPrompt = sanitizeStoryPromptFromNiche(post.storyPrompt, nicheStyle);
    });
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
    const {
      tracks: billboardEntries,
      chartDateUsed,
      source: audioSource,
      filteredOut,
    } = await getNonHolidayHot100({
      requestId: loggingContext?.requestId,
      minCount: 20,
    });
    const audioStats = ensureSuggestedAudioForPosts(posts, {
      audioEntries: billboardEntries,
      requestId: loggingContext?.requestId,
      chunkStartDay: startDay,
      postsPerDay: perDay,
    });
    const fallbackAudioEntry = getEvergreenFallbackList()[0] || { title: 'Top track', artist: 'Billboard Hot 100' };
    let normalizedAudioCount = 0;
    posts = posts.map((post) => {
      if (!post || !isValidSuggestedAudio(post.suggestedAudio)) {
        normalizedAudioCount += 1;
        post.suggestedAudio = normalizeSuggestedAudioValue(post.suggestedAudio, fallbackAudioEntry);
      }
      return post;
    });
    if (normalizedAudioCount) {
      console.log('[Calendar] normalized suggestedAudio shape', {
        requestId: loggingContext?.requestId,
        normalizedAudioCount,
      });
    }
    const audioSample = posts
      .slice(0, 2)
      .map((post) => ({
        day: post.day,
        audio: post?.suggestedAudio,
      }))
      .filter((entry) => entry.audio);
    const postProcessingMs = Date.now() - validationStart;
    console.log('[Calendar][Server][Perf] callOpenAI timings', {
      openMs: openDuration,
      latencyMs: openAiLatency,
      parseMs: postProcessingMs,
      postCount: posts.length,
      rawLength,
      context: loggingContext,
    });
    console.log('[Calendar] audio summary', {
      requestId: loggingContext?.requestId,
      totalPosts: audioStats.total,
      missingAudio: audioStats.missingAudio,
      source: audioSource,
      chartDate: chartDateUsed,
      holidayFilteredOut: Number(filteredOut) || 0,
      sample: audioSample,
    });
    if (!isProduction) {
      const holidayHits = posts.filter((post) => {
        const value = post?.suggestedAudio || '';
        const parsed = normalizeSuggestedAudioFromText(value);
        return parsed?.title && isHolidayTrack(parsed.title, parsed.artist);
      });
      if (holidayHits.length) {
        const sample = holidayHits.slice(0, 2).map((post) => ({
          day: post.day,
          audio: post?.suggestedAudio,
        }));
        throw new Error(`Holiday audio detected in suggestedAudio: ${JSON.stringify(sample)}`);
      }
    }
    console.log('[Calendar][Server][Perf] generateCalendarPosts end', {
      elapsedMs: Date.now() - tStart,
      count: posts.length,
      expectedCount: expectedCount || posts.length,
      rawLength,
      latencyMs: openAiLatency,
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
      const regenContext = { requestId, warnings: [] };
      try {
        // Require auth for regen, but still allow body userId to pass brand
        const user = await requireSupabaseUser(req);
        req.user = user;
        try {
          const response = await supabaseAdmin
            .from('profiles')
            .select('subscription_plan')
            .eq('id', user.id)
            .single();
          if (response?.data?.subscription_plan) {
            req.user.plan = response.data.subscription_plan;
          }
        } catch (planErr) {
          console.warn('[Calendar] failed to resolve subscription plan', {
            requestId,
            userId: user.id,
            error: planErr?.message || planErr,
          });
        }
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
        if (body && typeof body === 'object') {
          body.userId = user.id;
        }
        const usedSignaturesInput = Array.isArray(body?.usedSignatures) ? body.usedSignatures : [];
        const sanitizedUsedSignatures = Array.from(
          new Set(usedSignaturesInput.map((sig) => normalizeCalendarSignature(sig)).filter(Boolean))
        );
        const targetCalendarId = body?.calendarId ?? null;
        console.log('[Calendar][Server][Perf] regen generation start', {
          requestId,
          days: body?.days,
          startDay: body?.startDay,
          postsPerDay: body?.postsPerDay,
        });
        regenContext.batchIndex = body?.batchIndex;
        regenContext.startDay = body?.startDay;
        const requestedPostsPerDay =
          Number.isFinite(Number(body?.postsPerDay)) && Number(body?.postsPerDay) > 0
            ? Number(body.postsPerDay)
            : 1;
        const posts = await generateCalendarPosts({
          ...(body || {}),
          postsPerDay: requestedPostsPerDay,
          usedSignatures: sanitizedUsedSignatures,
          context: regenContext,
        });
        const missingAudioCount = posts.filter((post) => !isValidSuggestedAudio(post?.suggestedAudio)).length;
        console.log('[Calendar] regen audio counts', {
          requestId,
          assigned: posts.length - missingAudioCount,
          missing: missingAudioCount,
        });
        if (!isPro) {
          await incrementFeatureUsage(supabaseAdmin, user.id, CALENDAR_EXPORT_FEATURE_KEY);
        }
        console.log('[Calendar][Server][Perf] regen response ready', {
          requestId,
          elapsedMs: Date.now() - tStart,
          postCount: Array.isArray(posts) ? posts.length : 0,
        });
        const payloadWarnings = Array.isArray(regenContext.warnings) ? regenContext.warnings : [];
        if (!Array.isArray(posts) || !posts.length) {
          return sendJson(res, 500, {
            error: { message: 'REGENERATE_RETURNED_NO_POSTS' },
            requestId,
          });
        }
        const responsePayload = { calendarId: targetCalendarId, posts, requestId };
        if (payloadWarnings.length) responsePayload.warnings = payloadWarnings;
        return sendJson(res, 200, responsePayload);
      } catch (err) {
        const errorContext = {
          postsPerDay: body?.postsPerDay,
          days: body?.days,
          startDay: body?.startDay,
          nicheStyle: body?.nicheStyle,
        };
        const errorMessage = String(err?.message || '');
        const overrideError = errorMessage.includes('STORY_PROMPT_KEYWORD_OVERRIDE') || errorMessage.includes('VALIDATE_FAILED');
        if (overrideError) {
          console.warn('[Calendar][Server] regen override invalid, retrying without override', { requestId, context: errorContext });
          const sanitizedBody = stripStoryPromptOverrideFields(body);
          const sanitizedContext = {
            requestId,
            batchIndex: sanitizedBody?.batchIndex,
            startDay: sanitizedBody?.startDay,
            warnings: [],
          };
          try {
            const posts = await generateCalendarPosts({
              ...(sanitizedBody || {}),
              usedSignatures: sanitizedUsedSignatures,
              context: sanitizedContext,
            });
            if (!isPro) {
              await incrementFeatureUsage(supabaseAdmin, user.id, CALENDAR_EXPORT_FEATURE_KEY);
            }
            console.log('[Calendar][Server][Perf] regen override retry success', { requestId, context: errorContext });
            const warnings = [
              ...(Array.isArray(regenContext.warnings) ? regenContext.warnings : []),
              ...(Array.isArray(sanitizedContext.warnings) ? sanitizedContext.warnings : []),
            ].filter(Boolean);
            if (!Array.isArray(posts) || !posts.length) {
              return sendJson(res, 500, {
                error: { message: 'REGENERATE_RETURNED_NO_POSTS' },
                requestId,
              });
            }
            const responsePayload = { calendarId: sanitizedBody?.calendarId ?? null, posts, requestId };
            if (warnings.length) responsePayload.warnings = warnings;
            return sendJson(res, 200, responsePayload);
          } catch (retryErr) {
            logServerError('calendar_regenerate_error', retryErr, { requestId, context: errorContext });
            throw retryErr;
          }
        }
        const isSchemaError = err?.code === 'OPENAI_SCHEMA_ERROR';
        const logInfo = { requestId, context: errorContext };
        if (isSchemaError) {
          if (err?.schemaSnippet) logInfo.schemaSnippet = err.schemaSnippet;
          if (err?.details) logInfo.schemaPayload = err.details;
          if (err?.rawContent) logInfo.rawContentPreview = String(err.rawContent).slice(0, 400);
        }
        logServerError('calendar_regenerate_error', err, logInfo);
        if (res.headersSent) return;
        const status = isSchemaError ? 502 : (err?.statusCode || 500);
        const payload = {
          error: isSchemaError
            ? { message: 'openai_schema_error', code: 'OPENAI_SCHEMA_ERROR' }
            : { message: err?.message || 'Internal Server Error', code: err?.code || 'CALENDAR_REGENERATE_FAILED' },
          requestId,
        };
        if (isSchemaError) {
          if (!isProduction && err?.rawContent) {
            payload.error.debug = err.rawContent;
          }
          const detailPayload = { ...(err?.details || {}) };
          if (err?.schemaSnippet) detailPayload.schemaSnippet = err.schemaSnippet;
          if (Object.keys(detailPayload).length) {
            payload.error.details = detailPayload;
          }
        }
        if (!isSchemaError && !isProduction && err?.stack) {
          payload.debugStack = err.stack;
        }
        return sendJson(res, status, payload);
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/generate-variants' && req.method === 'POST') {
    (async () => {
      try {
        await requireSupabaseUser(req);
        return sendJson(res, 200, { variants: [] });
      } catch (err) {
        const status = err?.statusCode || 401;
        console.error('[Calendar] generate-variants error', { error: err?.message || err });
        return sendJson(res, status, {
          error: err?.message || 'generate_variants_failed',
        });
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

  if (parsed.pathname === '/api/regen-day' && req.method === 'POST') {
    (async () => {
      const requestId = generateRequestId('regen-day');
      try {
        const user = await requireSupabaseUser(req);
        req.user = user;
        const body = await readJsonBody(req);
        const { nicheStyle, day, post, userId } = body || {};
        if (!nicheStyle || typeof day === 'undefined' || day === null) {
          return sendJson(res, 400, { error: 'nicheStyle and day are required' });
        }
        if (!post || typeof post !== 'object') {
          return sendJson(res, 400, { error: 'post payload required' });
        }
        const dayNumber = Number(day);
        const resolvedUserId = user?.id || userId || null;
        const postsPerDay =
          Number.isFinite(Number(body?.postsPerDay)) && Number(body?.postsPerDay) > 0
            ? Number(body.postsPerDay)
            : 1;
        const logContext = { requestId, userId: resolvedUserId, nicheStyle, day: dayNumber, postsPerDay };
        console.log('[Calendar][Server] regen-day request', logContext);
        const maxAttempts = 2;
        let attempt = 0;
        let normalized = null;
        let missingFields = [];
        let appliedFixes = [];
        while (attempt < maxAttempts) {
          attempt += 1;
          let posts;
          try {
            posts = await generateCalendarPosts({
              nicheStyle,
              userId: resolvedUserId,
              days: 1,
              startDay: dayNumber,
              postsPerDay,
              context: { requestId, batchIndex: 0, startDay: dayNumber, attempt },
            });
          } catch (genErr) {
            throw genErr;
          }
          const candidate = Array.isArray(posts) && posts.length ? posts[0] : null;
          if (!candidate) throw new Error('Calendar generator returned no posts');
          const normalizedResult = ensureRegenRequiredFields(candidate, nicheStyle, dayNumber);
          normalized = normalizedResult.post;
          missingFields = normalizedResult.missingFields || [];
          appliedFixes = normalizedResult.appliedFixes || [];
          if (!missingFields.length) break;
          console.warn('[Calendar] regen-day missing fields after normalization', {
            requestId,
            attempt,
            missingFields,
          });
        }
        if (!normalized) throw new Error('Regeneration failed to normalize output');
        if (missingFields.length) {
          return sendJson(res, 422, {
            error: 'REGEN_INVALID_OUTPUT',
            message: 'Regeneration did not return required fields.',
            requestId,
            missingFields,
          });
        }
        if (appliedFixes.length) {
          console.log('[Calendar] regen-day normalized output', {
            requestId,
            appliedFixes,
          });
        }
        const enriched = enrichRegenPost(normalized, dayNumber - 1);
        return sendJson(res, 200, { post: enriched });
      } catch (err) {
        console.error('regen-day error:', err);
        const status = err.statusCode || 500;
        return sendJson(res, status, { error: err.message || 'Failed to regenerate day' });
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
    const chunks = [];
    req.on('data', (chunk) => {
      if (chunk) chunks.push(chunk);
    });
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks || []);
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

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));

      setImmediate(() => {
        processPhylloWebhookEvent(body).catch((err) => {
          console.error('[Phyllo] webhook processing error', err);
        });
      });
    });
    req.on('error', (err) => {
      console.error('[Phyllo] webhook request error', err);
      sendJson(res, 500, { error: 'phyllo_webhook_error' });
    });
    return;
  }

  if (parsed.pathname === '/api/phyllo/sdk-config' && req.method === 'GET') {
    (async () => {
      await ensureAnalyticsRequestUser(req);
      const promptlyUserId = req.user && req.user.id;
      if (!promptlyUserId) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }
      if (!process.env.PHYLLO_CLIENT_ID || !process.env.PHYLLO_CLIENT_SECRET) {
        console.error('[Phyllo] Missing PHYLLO_CLIENT_ID or PHYLLO_CLIENT_SECRET env vars');
        return sendJson(res, 200, {
          ok: false,
          error: 'phyllo_env_missing',
          message: 'PHYLLO_CLIENT_ID/PHYLLO_CLIENT_SECRET are not set on the server.',
        });
      }

      try {
        const externalId = String(promptlyUserId);

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

        const workPlatformIds = await getWorkPlatformIds();
        let sdk;
        try {
          sdk = await createSdkToken({ userId: phylloUser.id, workPlatformIds });
        } catch (err) {
          const status = err.response?.status;
          const data = err.response?.data;
          let details = data || err.message;
          if (status === 401) {
            console.error('[Phyllo] createSdkToken auth misconfiguration (Basic Auth invalid)', details);
            details = 'Basic Auth failed; verify PHYLLO_CLIENT_ID/PHYLLO_CLIENT_SECRET';
          } else if (status === 400 && (data?.code === 'incorrect_user_id' || data?.error_code === 'incorrect_user_id')) {
            console.error('[Phyllo] createSdkToken failed because the Phyllo user is missing; ensure getOrCreatePhylloUser ran first', data);
            details = 'Phyllo user missing; ensure getOrCreatePhylloUser ran before requesting SDK token';
          } else {
            console.error('[Phyllo] createSdkToken failed', status, details);
          }

          return sendJson(res, 200, {
            ok: false,
            error: 'phyllo_create_sdk_token_failed',
            status,
            details,
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

  if (parsed.pathname === '/api/phyllo/connect-config' && req.method === 'GET') {
    (async () => {
      try {
        const user = await ensureAnalyticsRequestUser(req);
        if (!user) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        return sendJson(res, 410, {
          ok: false,
          error: 'deprecated_use_sdk_config',
          message: 'Use /api/phyllo/sdk-config for Phyllo Connect initialization.',
        });
      } catch (err) {
        console.error('[Phyllo] connect-config error', err);
        return sendJson(res, 500, { ok: false, error: 'server_error' });
      }
    })();
    return;
  }

  // Mock analytics endpoints (no Supabase/OpenAI yet)
  if (parsed.pathname === '/api/phyllo/account-connected' && req.method === 'POST') {
    readJsonBody(req)
      .then(async (body) => {
        try {
          await ensureAnalyticsRequestUser(req);
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
            logServerError('phyllo_accounts_upsert_error', error, {
              route: '/api/phyllo/account-connected',
              userId: promptlyUserId,
              query: 'phyllo_accounts_upsert',
            });
            return sendJson(res, 500, { ok: false, error: 'db_error', error_code: 'db_error' });
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

  if (parsed.pathname === '/api/phyllo/accounts/connect' && req.method === 'POST') {
    readJsonBody(req)
      .then(async (body) => {
        try {
          const user = await ensureAnalyticsRequestUser(req);
          if (!user) {
            return sendJson(res, 401, { ok: false, error: 'unauthorized' });
          }
          const {
            userId: phylloUserId,
            accountId,
            workPlatformId,
            platform,
            handle,
            displayName,
            avatarUrl,
          } = body || {};
          if (!phylloUserId || !accountId || !workPlatformId) {
            return sendJson(res, 400, { ok: false, error: 'missing_fields' });
          }
          if (!supabaseAdmin || !upsertPhylloAccount) {
            return sendJson(res, 500, { ok: false, error: 'supabase_not_configured' });
          }
          const { error } = await upsertPhylloAccount({
            userId: user.id,
            phylloUserId,
            platform: platform || 'unknown',
            accountId,
            workPlatformId,
            handle,
            displayName,
            avatarUrl,
          });
          if (error) {
            logServerError('phyllo_accounts_upsert_error', error, {
              route: '/api/phyllo/accounts/connect',
              userId: user.id,
              query: 'phyllo_accounts_upsert',
            });
            return sendJson(res, 500, { ok: false, error: 'db_error', error_code: 'db_error' });
          }
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          console.error('[Phyllo] accounts/connect error', err);
          return sendJson(res, 500, { ok: false, error: 'server_error' });
        }
      })
      .catch((err) => {
        console.error('[Phyllo] accounts/connect parse error', err);
        sendJson(res, 500, { ok: false, error: 'parse_error' });
      });
    return;
  }

  if (parsed.pathname === '/api/phyllo/accounts/disconnect' && req.method === 'POST') {
    readJsonBody(req)
      .then(async (body) => {
        try {
          const user = await ensureAnalyticsRequestUser(req);
          if (!user) {
            return sendJson(res, 401, { ok: false, error: 'unauthorized' });
          }
          const { userId: phylloUserId, accountId } = body || {};
          if (!phylloUserId || !accountId) {
            return sendJson(res, 400, { ok: false, error: 'missing_fields' });
          }
          if (!supabaseAdmin) {
            return sendJson(res, 500, { ok: false, error: 'supabase_not_configured' });
          }
          const { error } = await supabaseAdmin
            .from('phyllo_accounts')
            .update({ status: 'disconnected' })
            .eq('promptly_user_id', user.id)
            .eq('phyllo_user_id', phylloUserId)
            .eq('phyllo_account_id', accountId);
          if (error) {
            logServerError('phyllo_accounts_disconnect_error', error, {
              route: '/api/phyllo/accounts/disconnect',
              userId: user.id,
              query: 'phyllo_accounts_update',
            });
            return sendJson(res, 500, { ok: false, error: 'db_error', error_code: 'db_error' });
          }
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          console.error('[Phyllo] accounts/disconnect error', err);
          return sendJson(res, 500, { ok: false, error: 'server_error' });
        }
      })
      .catch((err) => {
        console.error('[Phyllo] accounts/disconnect parse error', err);
        sendJson(res, 500, { ok: false, error: 'parse_error' });
      });
    return;
  }

  if (parsed.pathname === '/api/phyllo/accounts' && req.method === 'GET') {
    handlePhylloAccounts(req, res);
    return;
  }

  if (parsed.pathname === '/api/analytics/data' && req.method === 'GET') {
    (async () => {
      try {
        await ensureAnalyticsRequestUser(req);
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
          .eq('promptly_user_id', promptlyUserId)
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
      const requestId = generateRequestId('phyllo_sync_posts');
      try {
        const user = await ensureAnalyticsRequestUser(req);
        if (!user || !supabaseAdmin) {
          return sendJson(res, 401, {
            ok: false,
            error: 'unauthorized',
            error_code: 'unauthorized',
            requestId,
          });
        }

        const missingPhyllo = getMissingPhylloEnvVars();
        if (missingPhyllo.length) {
          logServerError('phyllo_env_missing', new Error('Missing Phyllo environment variables'), {
            requestId,
            route: '/api/phyllo/sync-posts',
            missing: missingPhyllo,
          });
          return sendJson(res, 502, {
            ok: false,
            error: 'phyllo_env_missing',
            error_code: 'phyllo_env_missing',
            requestId,
          });
        }

        const { accounts, error: accountsError } = await getConnectedPhylloAccounts(
          user.id,
          requestId,
          '/api/phyllo/sync-posts'
        );
        if (accountsError) {
          return sendJson(res, 502, {
            ok: false,
            error: 'phyllo_accounts_db_error',
            error_code: 'phyllo_accounts_db_error',
            requestId,
          });
        }
        if (!accounts.length) {
          return sendJson(res, 400, {
            ok: false,
            error: 'no_connected_accounts',
            error_code: 'no_connected_accounts',
            requestId,
          });
        }
        if (DEBUG_ANALYTICS) {
          console.log('[Analytics][Debug] sync-posts accounts', {
            requestId,
            userId: user.id,
            count: accounts.length,
          });
        }

        const windowThresholdMs = 24 * 60 * 60 * 1000;
        const refreshCutoff = new Date(Date.now() - windowThresholdMs);
        const eligibleAccounts = accounts.filter((acc) => {
          const lastUpdated = acc?.updated_at || acc?.connected_at;
          if (!lastUpdated) return true;
          const ts = new Date(lastUpdated);
          if (!ts || Number.isNaN(ts.getTime())) return true;
          return ts.getTime() < refreshCutoff.getTime();
        });
        if (!eligibleAccounts.length) {
          return sendJson(res, 200, {
            ok: true,
            synced_accounts: 0,
            posts_written: 0,
            requestId,
          });
        }

        let totalSynced = 0;
        let upstreamOk = true;
        const analyticsSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const analyticsUntil = new Date();

        for (const acc of eligibleAccounts) {
          const accountId = acc.account_id || acc.phyllo_account_id;
          if (!accountId) continue;

          let postsResp;
          try {
            postsResp = await getPhylloPosts(accountId, { requestId, userId: user.id });
          } catch (err) {
            upstreamOk = false;
            logServerError('phyllo_sync_posts_fetch_failed', err, {
              requestId,
              route: '/api/phyllo/sync-posts',
              userId: user.id,
              accountId,
            });
            continue;
          }

          const posts = postsResp?.data || [];
          for (const p of posts) {
            try {
              const { data: postRows, error: postErr } = await upsertPhylloPost({
                phylloAccountId: accountId,
                promptlyUserId: user.id,
                phylloContentId: p.id,
                platform: acc.platform || p.platform,
                platformPostId: p.id,
                title: p.title || null,
                caption: p.caption || null,
                url: p.url || null,
                publishedAt: p.published_at || null,
              });

              if (postErr) {
                logServerError('phyllo_upsert_post_error', postErr, {
                  requestId,
                  route: '/api/phyllo/sync-posts',
                });
                continue;
              }

              let metricsResp;
              try {
                metricsResp = await getPhylloPostMetrics(p.id, { requestId, userId: user.id });
              } catch (err) {
                upstreamOk = false;
                logServerError('phyllo_sync_post_metrics_failed', err, {
                  requestId,
                  route: '/api/phyllo/sync-posts',
                  postId: p.id,
                });
                continue;
              }

              const m = metricsResp?.data || {};
              const views = m.views || 0;
              const likes = m.likes || 0;
              const comments = m.comments || 0;
              const shares = m.shares || 0;
              const saves = m.saves || 0;
              const watchTimeSeconds = m.watch_time_seconds || 0;
              const retentionPct = m.retention_pct || null;

              const { error: metricsErr } = await insertPhylloPostMetrics({
                phylloContentId: p.id,
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
                logServerError('phyllo_insert_metrics_error', metricsErr, {
                  requestId,
                  route: '/api/phyllo/sync-posts',
                });
                continue;
              }

              totalSynced += 1;
            } catch (err) {
              logServerError('phyllo_sync_post_error', err, {
                requestId,
                route: '/api/phyllo/sync-posts',
                accountId,
              });
              upstreamOk = false;
            }
          }

          try {
            await supabaseAdmin
              .from('phyllo_accounts')
              .update({ updated_at: new Date().toISOString() })
              .eq('phyllo_account_id', accountId);
          } catch (err) {
            console.warn('[Phyllo] failed to update refreshed timestamp', err);
          }

          await syncAccountMetricsForAnalytics(
            {
              ...acc,
              phyllo_account_id: acc.phyllo_account_id || accountId,
              promptly_user_id: acc.promptly_user_id || acc.user_id || user.id,
            },
            analyticsSince,
            analyticsUntil
          );
          await wait(60);
        }

        try {
          await updateCachedAnalyticsForUser(user.id);
        } catch (err) {
          console.warn('[Phyllo] updateCachedAnalyticsForUser failed', err);
        }

        if (!upstreamOk) {
          return sendJson(res, 502, {
            ok: false,
            error: 'upstream_failed',
            error_code: 'upstream_failed',
            synced_accounts: eligibleAccounts.length,
            posts_written: totalSynced,
            requestId,
          });
        }
        return sendJson(res, 200, {
          ok: true,
          synced_accounts: eligibleAccounts.length,
          posts_written: totalSynced,
          requestId,
        });
      } catch (err) {
        logServerError('phyllo_sync_posts_error', err, {
          requestId,
          route: '/api/phyllo/sync-posts',
          userId: req.user?.id,
        });
        return sendJson(res, 502, {
          ok: false,
          error: 'phyllo_sync_posts_failed',
          error_code: 'phyllo_sync_posts_failed',
          requestId,
        });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/phyllo/test-posts' && req.method === 'GET') {
    (async () => {
      try {
        await ensureAnalyticsRequestUser(req);
        const userId = req.user && req.user.id;
        if (!userId) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

        const { data: accounts } = await supabaseAdmin
          .from('phyllo_accounts')
          .select('*')
          .eq('promptly_user_id', userId)
          .eq('status', 'connected');

        if (!accounts || accounts.length === 0) {
          return sendJson(res, 200, { ok: true, data: [] });
        }

        const first = accounts[0];
        const posts = await getPhylloPosts(first.phyllo_account_id || first.account_id);

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
          await ensureAnalyticsRequestUser(req);
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
      const requestId = generateRequestId('analytics_insights');
      try {
        const user = await ensureAnalyticsRequestUser(req);
        const isPro = isUserPro(req);
        if (!user || !supabaseAdmin) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized', error_code: 'unauthorized', requestId });
        }

        const { accounts, error: accountsError } = await getConnectedPhylloAccounts(
          user.id,
          requestId,
          '/api/analytics/insights'
        );
        if (accountsError) {
          return sendJson(res, 502, {
            ok: false,
            error: 'phyllo_accounts_db_error',
            error_code: 'phyllo_accounts_db_error',
            requestId,
          });
        }
        if (!accounts.length) {
          return sendJson(res, 400, {
            ok: false,
            error: 'no_connected_accounts',
            error_code: 'no_connected_accounts',
            requestId,
          });
        }

        const { data, error } = await supabaseAdmin
          .from('analytics_insights')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(1);
        if (error) {
          logServerError('analytics_insights_fetch_failed', error, {
            requestId,
            route: '/api/analytics/insights',
            userId: user.id,
          });
          return sendJson(res, 502, {
            ok: false,
            error: 'insights_fetch_failed',
            error_code: 'insights_fetch_failed',
            requestId,
          });
        }
        let insights = (data && data[0] && data[0].insights) || [];
        if (!isPro && Array.isArray(insights)) {
          insights = insights.slice(0, 2);
        }
        return sendJson(res, 200, { ok: true, insights, requestId });
      } catch (err) {
        logServerError('analytics_insights_fetch_error', err, {
          requestId,
          route: '/api/analytics/insights',
        });
        return sendJson(res, 502, {
          ok: false,
          error: 'analytics_insights_failed',
          error_code: 'analytics_insights_failed',
          requestId,
        });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/engagement' && req.method === 'GET') {
    (async () => {
      try {
        await ensureAnalyticsRequestUser(req);
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
    handleAnalyticsAlerts(req, res);
    return;
  }

  if (parsed.pathname === '/api/analytics/report/latest' && req.method === 'GET') {
    (async () => {
      try {
        await ensureAnalyticsRequestUser(req);
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
        await ensureAnalyticsRequestUser(req);
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
        await ensureAnalyticsRequestUser(req);
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
    handleAnalyticsHeatmap(req, res);
    return;
  }

  if (parsed.pathname === '/api/analytics/full' && req.method === 'GET') {
    handleAnalyticsFull(req, res);
    return;
  }

  if (parsed.pathname === '/api/analytics/followers' && req.method === 'GET') {
    handleAnalyticsFollowers(req, res);
    return;
  }

  if (parsed.pathname === '/api/analytics/demographics' && req.method === 'GET') {
    handleAnalyticsDemographics(req, res);
    return;
  }

  if (parsed.pathname === '/api/analytics/sync-status' && req.method === 'GET') {
    (async () => {
      try {
        await ensureAnalyticsRequestUser(req);
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
        await ensureAnalyticsRequestUser(req);
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
        await ensureAnalyticsRequestUser(req);
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
      const requestId = generateRequestId('phyllo_sync_demographics');
      try {
        const user = await ensureAnalyticsRequestUser(req);
        if (!user || !supabaseAdmin) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized', requestId });
        }

        const missingPhyllo = getMissingPhylloEnvVars();
        if (missingPhyllo.length) {
          logServerError('phyllo_env_missing', new Error('Missing Phyllo environment variables'), {
            requestId,
            route: '/api/phyllo/sync-demographics',
            missing: missingPhyllo,
          });
          return sendJson(res, 502, {
            ok: false,
            error: 'phyllo_env_missing',
            error_code: 'phyllo_env_missing',
            requestId,
          });
        }

        const { accounts, error: accountsError } = await getConnectedPhylloAccounts(
          user.id,
          requestId,
          '/api/phyllo/sync-demographics'
        );
        if (accountsError) {
          return sendJson(res, 502, {
            ok: false,
            error: 'phyllo_accounts_db_error',
            error_code: 'phyllo_accounts_db_error',
            requestId,
          });
        }
        if (!accounts.length) {
          return sendJson(res, 400, {
            ok: false,
            error: 'no_connected_accounts',
            error_code: 'no_connected_accounts',
            requestId,
          });
        }

        let upstreamOk = true;
        const audience = await getAudienceDemographics(accounts, { requestId, userId: user.id });
        const platformMap = new Map();
        if (Array.isArray(audience)) {
          audience.forEach((row) => {
            if (!row) return;
            const key = String(row.platform || 'unknown').toLowerCase();
            if (!platformMap.has(key)) platformMap.set(key, row.audience || row);
          });
        }

        for (const acc of accounts) {
          try {
            const platformKey = String(acc.platform || acc.work_platform_id || 'unknown').toLowerCase();
            const payload = Array.isArray(audience)
              ? platformMap.get(platformKey) || {}
              : audience || {};

            const age_groups = payload.age || payload.age_groups || {};
            const countries = payload.location || payload.countries || {};
            const languages = payload.language || payload.languages || {};
            const genders = payload.gender || payload.genders || {};

            const { error: upsertErr } = await supabaseAdmin.from('phyllo_demographics').upsert({
              user_id: user.id,
              phyllo_user_id: acc.phyllo_user_id,
              account_id: acc.account_id || acc.phyllo_account_id,
              platform: acc.platform || acc.work_platform_id || 'unknown',
              age_groups,
              countries,
              languages,
              genders,
              updated_at: new Date().toISOString(),
            });

            if (upsertErr) {
              logServerError('phyllo_demographics_upsert_error', upsertErr, {
                requestId,
                route: '/api/phyllo/sync-demographics',
              });
            }
          } catch (err) {
            upstreamOk = false;
            logServerError('phyllo_sync_demographics_account_error', err, {
              requestId,
              route: '/api/phyllo/sync-demographics',
            });
          }
        }

        if (!upstreamOk) {
          return sendJson(res, 502, {
            ok: false,
            error: 'upstream_failed',
            error_code: 'upstream_failed',
            requestId,
          });
        }
        return sendJson(res, 200, {
          ok: true,
          synced_accounts: accounts.length,
          demographics_written: accounts.length,
          requestId,
        });
      } catch (err) {
        logServerError('phyllo_sync_demographics_error', err, {
          requestId,
          route: '/api/phyllo/sync-demographics',
          userId: req.user?.id,
        });
        return sendJson(res, 502, {
          ok: false,
          error: 'phyllo_sync_demographics_failed',
          error_code: 'phyllo_sync_demographics_failed',
          requestId,
        });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/analytics/sync-status/update' && req.method === 'POST') {
    (async () => {
      try {
        await ensureAnalyticsRequestUser(req);
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
        await ensureAnalyticsRequestUser(req);
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
          await ensureAnalyticsRequestUser(req);
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
        await ensureAnalyticsRequestUser(req);
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
        await ensureAnalyticsRequestUser(req);
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
        await ensureAnalyticsRequestUser(req);
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
        await ensureAnalyticsRequestUser(req);
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
        await ensureAnalyticsRequestUser(req);
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

  if (parsed.pathname === '/internal/phyllo/webhook-config' && req.method === 'POST') {
    (async () => {
      try {
        if (!isUserAdmin(req)) {
          return sendJson(res, 403, { ok: false, error: 'forbidden' });
        }
        const payload = await configurePhylloWebhook();
        return sendJson(res, 200, { ok: true, data: payload });
      } catch (err) {
        console.error('[Phyllo] webhook config failed', err);
        return sendJson(res, 500, { ok: false, error: 'phyllo_webhook_config_failed', details: err.message });
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
          await syncAccountMetricsForAnalytics(acct, since, until);
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

  if (isBrandKitPath(normalizedPath) && req.method === 'GET') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        if (!user || !user.id) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }

        let kit = null;
        let source = 'file';

        if (supabaseAdmin) {
          try {
            const { data, error } = await supabaseAdmin
              .from('brand_brains')
              .select('primary_color, secondary_color, accent_color, heading_font, body_font, logo_url, updated_at')
              .eq('user_id', user.id)
              .maybeSingle();
            if (error) throw error;
            if (data) {
              kit = {
                brand_name: '',
                brand_color: data.primary_color || '',
                primary_color: data.primary_color || '',
                secondary_color: data.secondary_color || '',
                accent_color: data.accent_color || '',
                heading_font: data.heading_font || '',
                body_font: data.body_font || '',
                logo_url: data.logo_url || '',
                updated_at: data.updated_at || null,
              };
              source = 'supabase';
            }
          } catch (err) {
            const msg = String(err?.message || err);
            if (!msg.includes('brand_brains') && !msg.includes('42P01') && !msg.includes('schema cache')) {
              console.error('[BrandKit] fetch failed', err);
              return sendJson(res, 500, { error: 'brandkit_fetch_failed' });
            }
          }
        }

        if (!kit) {
          const brand = loadBrand(user.id);
          if (brand?.kit) {
            kit = {
              ...brand.kit,
              brand_name: brand?.name || '',
              brand_color: brand.kit.primaryColor || '',
              logo_url: brand.kit.logoDataUrl || brand.kit.logoUrl || '',
              updated_at: brand.kit.updatedAt || brand.updatedAt || null,
            };
          }
        }

        return sendJson(res, 200, { ok: true, brandKit: kit || null, source });
      } catch (err) {
        console.error('[BrandKit] handler error', err);
        return sendJson(res, 500, { error: 'brandkit_fetch_failed' });
      }
    })();
    return;
  }

  if (isBrandKitPath(normalizedPath) && req.method === 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }

  if (parsed.pathname === '/api/brand-brain/settings' && req.method === 'GET') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        req.user = user;
        if (!supabaseAdmin) {
          return sendJson(res, 500, { ok: false, error: 'supabase_not_configured' });
        }
        const settings = (await fetchBrandBrainSettings(user.id)) || BRAND_BRAIN_DEFAULT_SETTINGS;
        return sendJson(res, 200, { ok: true, settings });
      } catch (err) {
        console.error('[BrandBrain] settings GET failed', err);
        return sendJson(res, 500, { ok: false, error: 'brand_brain_settings_fetch_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/brand-brain/settings' && req.method === 'POST') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        req.user = user;
        if (!supabaseAdmin) {
          return sendJson(res, 500, { ok: false, error: 'supabase_not_configured' });
        }
        try {
          const response = await supabaseAdmin
            .from('profiles')
            .select('tier')
            .eq('id', user.id)
            .single();
          if (response?.data?.tier) {
            const rawTier = String(response.data.tier).toLowerCase().trim();
            const mappedTier = rawTier === 'paid' || rawTier === 'premium' ? 'pro' : rawTier;
            req.user.tier = mappedTier;
            req.user.plan = mappedTier;
          }
        } catch (planErr) {
          console.warn('[BrandBrain] failed to resolve tier', {
            userId: user.id,
            error: planErr?.message || planErr,
          });
        }
        const isProUser = isUserPro(req);
        const body = await readJsonBody(req);
        const normalized = normalizeBrandBrainSettings(body || {});
        if (normalized.enabled && !isProUser) {
          return sendJson(res, 402, {
            ok: false,
            error: 'upgrade_required',
            feature: 'brand_brain',
          });
        }
        const saved = await upsertBrandBrainSettings(user.id, {
          ...normalized,
          enabled: normalized.enabled && isProUser,
        });
        return sendJson(res, 200, { ok: true, settings: saved || normalized });
      } catch (err) {
        console.error('[BrandBrain] settings POST failed', err);
        return sendJson(res, 500, { ok: false, error: 'brand_brain_settings_save_failed' });
      }
    })();
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
          .select('promptly_user_id')
          .eq('status', 'connected');

        if (error || !rows || !rows.length) {
          console.error('[Cron] No accounts or error:', error);
          return;
        }

        const userIds = [...new Set(rows.map((r) => r.promptly_user_id))];

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
  ensureSuggestedAudioForPosts,
};

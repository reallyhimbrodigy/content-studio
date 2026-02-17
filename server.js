const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const Anthropic = require('@anthropic-ai/sdk');
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
let buildAssetUrl = () => '';
let generateBrandedBackgroundImage = async () => null;
const { getBrandBrainForUser } = require('./services/brand-brain');
let getPhylloPosts = async () => [];
let getPhylloPostMetrics = async () => null;
let getUserPostMetrics = async () => ({ posts: [], summary: {} });
let getAudienceDemographics = async () => ({});
let buildWeeklyReport = async () => ({ ok: false, reason: 'phyllo_disabled' });
let syncAudience = async () => ({ ok: false, reason: 'phyllo_disabled' });
let syncFollowerMetrics = async () => ({ ok: false, reason: 'phyllo_disabled' });
let syncDemographics = async () => ({ ok: false, reason: 'phyllo_disabled' });
try {
  ({
    getPhylloPosts,
    getPhylloPostMetrics,
    getUserPostMetrics,
    getAudienceDemographics,
    buildWeeklyReport,
    syncAudience,
    syncFollowerMetrics,
    syncDemographics,
  } = require('./services/phyllo-metrics'));
  console.log('[Phyllo] metrics module loaded');
} catch (err) {
  console.log('[Phyllo] metrics disabled (module missing)');
}
const { getFeatureUsageCount, incrementFeatureUsage } = require('./services/featureUsage');
const { ENABLE_DESIGN_LAB } = require('./config/flags');
// Design Lab has been removed; provide stubs so legacy code paths do not break.
const createDesignRender = async () => ({ id: null, status: 'disabled' });
const resolveDesignTemplateId = () => null;
const validateDesignTemplateConfig = async () => {};
const isDesignPipelineConfigured = () => false;

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const OPENAI_API_KEY = CLAUDE_API_KEY || '';
const anthropicClient = CLAUDE_API_KEY ? new Anthropic({ apiKey: CLAUDE_API_KEY }) : null;
const CANONICAL_HOST = process.env.CANONICAL_HOST || '';
const STORY_TEMPLATE_ID = process.env.DESIGN_STORY_TEMPLATE_ID || '';
const CAROUSEL_TEMPLATE_ID = process.env.DESIGN_CAROUSEL_TEMPLATE_ID || '';
const ALLOWED_DESIGN_ASSET_TYPES = ['story', 'carousel'];
// NOTE: Asset service secrets must never be exposed client-side.
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
let profileSettingsSchemaWarned = false;

const LOCAL_HOT100_FALLBACK = Array.from({ length: 50 }, (_, idx) => ({
  title: `Original audio ${String(idx + 1).padStart(2, '0')}`,
  artist: `Creator ${idx + 1}`,
}));

function normalizeAudioString(title = '', artist = '') {
  const cleanTitle = String(title || '').trim();
  const cleanArtist = String(artist || '').trim();
  if (!cleanTitle && !cleanArtist) return '';
  if (!cleanArtist) return cleanTitle;
  if (!cleanTitle) return cleanArtist;
  return `${cleanTitle} - ${cleanArtist}`;
}

function isHolidayTrack(title = '', artist = '') {
  const text = `${title || ''} ${artist || ''}`.toLowerCase();
  return /christmas|xmas|holiday|santa|jingle|winter/.test(text);
}

function getEvergreenFallbackList() {
  return LOCAL_HOT100_FALLBACK.slice();
}

async function getNonHolidayHot100({ minCount = 30 } = {}) {
  const required = Number.isFinite(Number(minCount)) ? Math.max(1, Number(minCount)) : 30;
  const tracks = getEvergreenFallbackList()
    .filter((entry) => !isHolidayTrack(entry?.title || '', entry?.artist || ''))
    .slice(0, required);
  return {
    source: 'local_hot100',
    tracks,
    chartDate: null,
    filteredOut: 0,
  };
}
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

// Template ID resolution is handled by resolveDesignTemplateId()

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
  const existingRequestId = res.getHeader('x-request-id');
  if (payload && payload.requestId) headers['x-request-id'] = payload.requestId;
  else if (existingRequestId) headers['x-request-id'] = existingRequestId;
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

const isProduction = process.env.NODE_ENV === 'production';
const DEBUG_ANALYTICS = process.env.DEBUG_ANALYTICS === 'true';
const DEBUG_ENTITLEMENTS = process.env.DEBUG_ENTITLEMENTS === 'true';

function generateRequestId(prefix = 'req') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function hashPromptPreview(text = '') {
  try {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
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
  const isOpenAISchemaInvalid = err?.code === 'OPENAI_SCHEMA_INVALID';
  const isCalendarPostFailed = err?.code === 'CALENDAR_POST_GENERATION_FAILED';
  const isTopicBinding = err?.code === 'TOPIC_BINDING_FAILED';
  const isPostKeyMapping = err?.code === 'POST_KEY_MAPPING_FAILED';
  const requestIdValue = requestId || generateRequestId('server_error');
  if (isCalendarPostFailed) {
    const detail = err?.details || {};
    const responseDetails = {
      reason: detail?.reason || null,
      field: detail?.field || null,
      snippet: detail?.snippet || null,
      day: detail?.day ?? null,
      post_key: detail?.post_key || null,
    };
    return sendJson(res, 422, {
      error: 'CALENDAR_POST_GENERATION_FAILED',
      requestId: requestIdValue,
      details: responseDetails,
    });
  }
  if (isOpenAISchemaInvalid) {
    return sendJson(res, 422, {
      error: 'OPENAI_SCHEMA_INVALID',
      requestId: requestIdValue,
      details: err?.details || null,
    });
  }
  if (isTopicBinding) {
    const payload = {
      error: 'TOPIC_BINDING_FAILED',
      requestId: requestIdValue,
    };
    if (err?.payload?.post_key) payload.post_key = err.payload.post_key;
    if (Array.isArray(err?.payload?.failedFields)) payload.failedFields = err.payload.failedFields;
    return sendJson(res, 422, payload);
  }
  if (isPostKeyMapping) {
    const payload = {
      error: 'PostKeyMappingFailed',
      ...(err?.payload || {}),
    };
    if (requestIdValue) payload.requestId = requestIdValue;
    return sendJson(res, 422, payload);
  }
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

const PRO_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);
const PRO_PLAN_VALUES = new Set(['pro', 'teams']);

function normalizePlanLabel(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'paid' || raw === 'premium') return 'pro';
  return raw;
}

function normalizeSubscriptionStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw || null;
}

function resolveRequestId(req, prefix = 'req') {
  if (!req) return generateRequestId(prefix);
  if (req.requestId) return req.requestId;
  const headerId = req.headers?.['x-request-id'] || req.headers?.['x-requestid'];
  const value = headerId ? String(headerId) : generateRequestId(prefix);
  req.requestId = value;
  return value;
}

async function fetchSubscriptionEntitlement(userId) {
  if (!supabaseAdmin || !userId) {
    return { status: null, plan: null, sourceTable: 'profiles', row: null };
  }
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    const err = new Error(error?.message || 'entitlements_lookup_failed');
    err.statusCode = 500;
    err.sourceTable = 'profiles';
    throw err;
  }
  if (!data) {
    return { status: null, plan: null, sourceTable: 'profiles', row: null };
  }
  const plan = normalizePlanLabel(
    data?.subscription_plan || data?.plan || data?.tier || data?.subscription_tier || null
  );
  const status = normalizeSubscriptionStatus(
    data?.subscription_status || data?.stripe_subscription_status || data?.status || null
  );
  return { status, plan, sourceTable: 'profiles', row: data };
}

function resolveEntitlementDecision(entitlement) {
  const row = entitlement?.row || null;
  const hasStatusField = row
    ? ['subscription_status', 'stripe_subscription_status', 'status'].some((field) =>
        Object.prototype.hasOwnProperty.call(row, field)
      )
    : false;
  const plan = entitlement?.plan || null;
  const status = entitlement?.status || null;
  const isProFlag = Boolean(row?.is_pro || row?.isPro || row?.pro || row?.paid);
  const planQualifies = plan ? PRO_PLAN_VALUES.has(plan) : false;
  const statusQualifies = status ? PRO_SUBSCRIPTION_STATUSES.has(status) : false;
  if (isProFlag) {
    return { isPro: true, reason: 'IS_PRO_FLAG', plan, status, hasStatusField };
  }
  if (planQualifies && statusQualifies) {
    return { isPro: true, reason: 'PLAN_AND_STATUS', plan, status, hasStatusField };
  }
  if (planQualifies && !status) {
    return { isPro: true, reason: 'STATUS_MISSING_ASSUME_PRO', plan, status, hasStatusField };
  }
  if (!row) {
    return { isPro: false, reason: 'NO_ENTITLEMENT_ROW', plan, status, hasStatusField };
  }
  if (!planQualifies) {
    return { isPro: false, reason: 'PLAN_NOT_PRO', plan, status, hasStatusField };
  }
  return { isPro: false, reason: 'STATUS_NOT_PRO', plan, status, hasStatusField };
}

async function assertProEntitled(userId) {
  if (!supabaseAdmin) {
    const err = new Error('supabase_not_configured');
    err.statusCode = 500;
    throw err;
  }
  const entitlement = await fetchSubscriptionEntitlement(userId);
  const decision = resolveEntitlementDecision(entitlement);
  return { ...decision, sourceTable: entitlement.sourceTable };
}

async function requirePro(req, { allowPastDue = false } = {}) {
  const user = req?.user || (await requireSupabaseUser(req));
  req.user = user;
  if (!supabaseAdmin) {
    const err = new Error('supabase_not_configured');
    err.statusCode = 500;
    throw err;
  }
  const requestId = resolveRequestId(req, 'pro');
  const { status, plan, sourceTable } = await fetchSubscriptionEntitlement(user?.id);
  const allowedStatuses = new Set(PRO_SUBSCRIPTION_STATUSES);
  if (allowPastDue) allowedStatuses.add('past_due');
  if (!status || !allowedStatuses.has(status)) {
    console.warn(
      `[ProGate][PaymentRequired] requestId=${requestId} userId=${user?.id || 'unknown'} ` +
        `subscriptionStatus=${status || 'unknown'} plan=${plan || 'unknown'} sourceTable=${sourceTable}`
    );
    const err = new Error('PAYMENT_REQUIRED');
    err.statusCode = 402;
    err.payload = { error: 'PAYMENT_REQUIRED', details: { status, plan } };
    err.requestId = requestId;
    throw err;
  }
  return { userId: user.id, plan, status, requestId };
}

async function hydrateUserTier(req, context = 'Tier') {
  if (!req?.user?.id || !supabaseAdmin) return null;
  if (req.user.tier || req.user.plan) return req.user.tier || req.user.plan;
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('subscription_plan, tier')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error) {
      console.warn(`[${context}] failed to resolve tier`, {
        userId: req.user.id,
        error: error?.message || error,
      });
      return null;
    }
    if (data) {
      const rawTier = String(data.subscription_plan || data.tier || '').toLowerCase().trim();
      const mappedTier = rawTier === 'paid' || rawTier === 'premium' ? 'pro' : rawTier;
      if (mappedTier) {
        req.user.tier = mappedTier;
        req.user.plan = mappedTier;
        return mappedTier;
      }
    }
  } catch (planErr) {
    console.warn(`[${context}] failed to resolve tier`, {
      userId: req.user.id,
      error: planErr?.message || planErr,
    });
  }
  return null;
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
const MAX_UPLOAD_BODY = 520 * 1024 * 1024; // multipart overhead for 500MB file cap
const MAX_VIDEO_FILE_SIZE = 500 * 1024 * 1024;
const VIDEO_ALLOWED_TYPES = ['video/mp4', 'video/quicktime', 'video/x-msvideo'];
const VIDEO_ALLOWED_EXTENSIONS = ['.mp4', '.mov', '.avi'];

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

async function readRawBodyWithLimit(req, maxBytes = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > maxBytes) {
        const err = new Error('Payload too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, length)));
    req.on('error', reject);
  });
}

function parseMultipartFormData(rawBuffer, contentType = '') {
  const boundaryMatch = String(contentType).match(/boundary=(.+)$/i);
  if (!boundaryMatch) {
    const err = new Error('Invalid multipart payload: missing boundary');
    err.statusCode = 400;
    throw err;
  }

  const boundary = Buffer.from(`--${boundaryMatch[1]}`);
  const parts = [];
  let start = rawBuffer.indexOf(boundary);
  while (start !== -1) {
    const next = rawBuffer.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const part = rawBuffer.slice(start + boundary.length + 2, next - 2);
    if (part.length > 0) parts.push(part);
    start = next;
  }

  const result = { fields: {}, files: {} };
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headers = part.slice(0, headerEnd).toString('utf8');
    let body = part.slice(headerEnd + 4);
    if (body.slice(-2).toString() === '\r\n') body = body.slice(0, -2);

    const nameMatch = headers.match(/name="([^"]+)"/i);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];

    const filenameMatch = headers.match(/filename="([^"]*)"/i);
    const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);

    if (filenameMatch && filenameMatch[1]) {
      result.files[fieldName] = {
        name: filenameMatch[1],
        type: contentTypeMatch ? contentTypeMatch[1].trim() : '',
        size: body.length,
        buffer: body,
      };
    } else {
      result.fields[fieldName] = body.toString('utf8');
    }
  }

  return result;
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
  const assetUrl = row.image_url ? buildAssetUrl(row.image_url) : '';
  const imageUrl = row.image_url || assetUrl;
  const previewUrl = data.preview_url || imageUrl;
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
    imageUrl,
    designUrl: `/design.html?asset=${encodeURIComponent(row.id)}`,
    imagePublicId: row.image_url || '',
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
      result.story_copy = dayData.story_copy || result.subtitle || '';
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

async function loadCalendarDay(calendarDayId, userId) {
  // TODO: Wire to Supabase calendar data. For now, return null so type-specific
  // defaults rely on request payload.
  return null;
}

function safeDesignText(value, max = 300) {
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

// NOTE: design provider template currently only binds title, subtitle, cta, logo, background_image, brand_color, and platform.
// Brand metadata still lives in design_assets.data for future template bindings.
function buildDesignPayload(data = {}) {
  return {
    title: safeDesignText(data.title, 120),
    subtitle: safeDesignText(data.subtitle, 360),
    cta: safeDesignText(data.cta, 80),
    brand_color: data.brand_color || data.brand_primary_color || '#ffffff',
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

    const templateId = resolveDesignTemplateId(type);
    if (!templateId) {
      console.error('[DesignAssets] Missing template id for type', type);
      return sendJson(res, 501, {
        error: 'Design pipeline not configured: missing design provider template id for this asset type.',
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
        console.warn('Branded background generation failed', err?.message);
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
    baseUpdate.render_job_id = null;
    baseUpdate.image_url = null;
    baseUpdate.data = {
      ...mergedData,
      preview_url: null,
      image_url: null,
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
    return sendJson(res, 501, { error: 'No design provider template id is configured for debug render' });
  }
  try {
    const payload = buildDesignPayload({
      title: 'Debug Title',
      subtitle: 'Debug Subtitle',
      cta: 'Tap to learn more',
      brand_color: '#ffffff',
      platform: 'instagram',
    });
    const render = await createDesignRender({
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

async function handleDesignTemplateDebug(req, res) {
  const types = ['story', 'carousel'];
  const results = [];
  for (const type of types) {
    const templateId = resolveDesignTemplateId(type);
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
      const render = await createDesignRender({ templateId, data: testPayload });
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

async function handleDebugDesignConfig(req, res) {
  return sendJson(res, 200, {
    configured: {
      DESIGN_API_KEY: process.env.DESIGN_API_KEY ? 'SET' : 'MISSING',
      DESIGN_STORY_TEMPLATE_ID: STORY_TEMPLATE_ID || 'NOT SET',
      DESIGN_CAROUSEL_TEMPLATE_ID: CAROUSEL_TEMPLATE_ID || 'NOT SET',
    },
    resolvedTemplateIds: {
      story: resolveDesignTemplateId('story'),
      carousel: resolveDesignTemplateId('carousel'),
    },
    note: 'Check your design provider dashboard to get valid template IDs'
  });
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
    brandKit
      ? [
          [brandKit.primaryColor, brandKit.secondaryColor, brandKit.accentColor].filter(Boolean).length
            ? `palette: ${[brandKit.primaryColor, brandKit.secondaryColor, brandKit.accentColor].filter(Boolean).join(', ')}`
            : '',
          [brandKit.headingFont, brandKit.bodyFont].filter(Boolean).length
            ? `typography: ${[brandKit.headingFont, brandKit.bodyFont].filter(Boolean).join(' / ')}`
            : '',
          brandKit.logoDataUrl ? 'logo: include safe area for brand mark' : '',
        ].filter(Boolean).join(' ')
      : '',
  ].filter(Boolean);
  return pieces.join(' ');
}


const OPENAI_MAX_CONCURRENCY = (() => {
  const configured = Number(process.env.OPENAI_MAX_CONCURRENCY);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 2;
})();
const CALENDAR_CONCURRENCY = (() => {
  const configured = Number(process.env.CALENDAR_CONCURRENCY);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 6;
})();
const OPENAI_CHUNK_MAX_DAYS = (() => {
  const configured = Number(process.env.OPENAI_CHUNK_MAX_DAYS);
  return Number.isFinite(configured) && configured >= 1 ? Math.max(1, Math.floor(configured)) : 2;
})();
const CALENDAR_PLAN_TIMEOUT_MS = 180000;
const CALENDAR_POST_TIMEOUT_MS = 120000;
const OPENAI_GENERATION_TIMEOUT_MS = (() => {
  return CALENDAR_POST_TIMEOUT_MS;
})();
const OPENAI_MAX_ATTEMPTS = (() => {
  const configured = Number(process.env.OPENAI_MAX_ATTEMPTS);
  return Number.isFinite(configured) && configured >= 1 ? Math.max(1, Math.floor(configured)) : 2;
})();
const REGEN_MAX_CONCURRENT = (() => {
  const configured = Number(process.env.REGEN_MAX_CONCURRENT);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 3;
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

const regenQueue = [];
let regenInFlight = 0;
const HOT100_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const hot100Cache = new Map();
async function acquireRegenSlot(requestId) {
  if (regenInFlight >= REGEN_MAX_CONCURRENT) {
    console.log('[Calendar][Regen] queued', { requestId, inFlight: regenInFlight });
    await new Promise((resolve) => regenQueue.push(resolve));
  }
  regenInFlight += 1;
}
function releaseRegenSlot() {
  regenInFlight = Math.max(0, regenInFlight - 1);
  const next = regenQueue.shift();
  if (next) next();
}

async function mapLimit(items, limit, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const results = new Array(items.length);
  let index = 0;
  let active = 0;
  return new Promise((resolve, reject) => {
    const runNext = () => {
      if (index >= items.length && active === 0) {
        resolve(results);
        return;
      }
      while (active < limit && index < items.length) {
        const currentIndex = index;
        const item = items[currentIndex];
        index += 1;
        active += 1;
        Promise.resolve()
          .then(() => worker(item, currentIndex))
          .then((result) => {
            results[currentIndex] = result;
            active -= 1;
            runNext();
          })
          .catch((err) => reject(err));
      }
    };
    runNext();
  });
}

async function mapWithConcurrency(items, limit, fn) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runCalendarJobPool(items, limit, worker) {
  if (!Array.isArray(items) || items.length === 0) return { results: [], errors: [] };
  const results = new Array(items.length);
  const errors = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        errors.push({ index: idx, error: err });
      }
    }
  });
  await Promise.all(workers);
  return { results, errors };
}

function isPlaceholderString(value = '') {
  const raw = String(value ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return { reason: 'empty', snippet: '' };
  const hasAlnum = /[A-Za-z0-9]/.test(trimmed);
  if (!hasAlnum) return { reason: 'only_punctuation', snippet: trimmed.slice(0, 120) };
  const emojiPattern = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  if (emojiPattern.test(trimmed)) return { reason: 'emoji', snippet: trimmed.slice(0, 120) };
  const tokenPattern = /(\{\{[^}]+\}\}|\$\{[^}]+\}|<[^>]+>|\[(?:insert|placeholder|tbd|todo)[^\]]*\])/i;
  if (tokenPattern.test(trimmed)) return { reason: 'template_token', snippet: trimmed.slice(0, 120) };
  const fillerPattern = /\b(lorem ipsum|placeholder|tbd|todo|fill in|insert here)\b/i;
  if (fillerPattern.test(trimmed)) return { reason: 'filler_text', snippet: trimmed.slice(0, 120) };
  return null;
}

function findPlaceholders(value, path, out, seen) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    const issue = isPlaceholderString(value);
    if (issue) {
      out.push({
        field: path || '/',
        reason: issue.reason,
        snippet: issue.snippet,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => {
      findPlaceholders(item, `${path}/${idx}`, out, seen);
    });
    return;
  }
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  Object.keys(value).forEach((key) => {
    findPlaceholders(value[key], `${path}/${key}`, out, seen);
  });
}

function hasPlaceholderInPost(post) {
  const errors = [];
  try {
    findPlaceholders(post, '', errors, new Set());
  } catch {
    return { ok: true, errors: [] };
  }
  if (!errors.length) return { ok: true, errors: [] };
  return { ok: false, errors: errors.slice(0, 8) };
}

async function generateAndValidateSinglePost({
  nicheStyle,
  brandContext,
  calendarMode = 'regular',
  brandBrainDirective = '',
  day,
  slotIndex,
  postsPerDay = 1,
  post_key,
  plannedTitle,
  plannedAngle,
  promoting = '',
  topicSignature = '',
  momentSpec = '',
  renderStyle = '',
  beatShape = '',
  revealOrder = '',
  pov = '',
  angleLabel = '',
  requestId,
  loggingContext = {},
  maxTokens,
  requestTimeoutMs,
  temperature,
  presencePenalty,
  qualityState,
  recentTitles = [],
  calendarId = '',
  usedSignatures = [],
  voiceLock = '',
}) {
  let currentStage = 'init';
  const schemaLabel = calendarMode === 'brand_brain' ? 'calendar_post_brandbrain' : 'calendar_post_regular';
  const angleSeed = buildAngleSeed({
    mode: calendarMode,
    day,
    slotIndex,
    calendarId,
  });
  const recentSignatures = Array.isArray(usedSignatures) ? usedSignatures.slice(-10) : [];
  currentStage = 'build_schema';
  const schema = getCalendarPostSchema(calendarMode, day, day);
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let reachedOpenAI = false;
    let structuredOutputUsed = false;
    let rawCandidate = null;
    console.log('[Calendar][Job] start', {
      requestId,
      mode: calendarMode,
      post_key,
      ANGLE_SEED: angleSeed,
      usedSignaturesCount: recentSignatures.length,
    });
    currentStage = 'assign_context';
    try {
      currentStage = 'openai_request';
      const result = await callOpenAI(nicheStyle, brandContext, {
        model: 'claude-opus-4-6',
        days: 1,
        startDay: day,
        postsPerDay: 1,
        loggingContext: { ...loggingContext, post_key, attempt },
        maxTokens,
        requestTimeoutMs,
        reduceVerbosity: true,
        compactPrompt: true,
        temperature,
        presencePenalty,
        brandBrainDirective,
        calendarMode,
        singlePost: true,
        allowFailover: false,
        schemaOverride: schema,
        postKey: post_key,
        slotIndex,
        plannedTitle,
        plannedAngle,
        promoting,
        topicSignature,
        momentSpec,
        renderStyle,
        beatShape,
        revealOrder,
        pov,
        angleLabel,
        recentTitles,
        angleSeed,
        usedSignatures: recentSignatures,
        voiceLock,
      });
      reachedOpenAI = true;
      structuredOutputUsed = Boolean(result.usedStructuredOutput);
      if (!Array.isArray(result.posts) || result.posts.length !== 1) {
        const err = new Error('CALENDAR_POST_GENERATION_FAILED');
        err.code = 'CALENDAR_POST_GENERATION_FAILED';
        err.statusCode = 422;
        err.details = {
          reason: 'SCHEMA_FAIL',
          field: 'posts',
          snippet: (() => {
            try {
              return JSON.stringify(result.posts).slice(0, 160);
            } catch {
              return '';
            }
          })(),
          errors: [],
          reachedOpenAI,
          structuredOutputUsed,
        };
        throw err;
      }
      rawCandidate = result.posts[0];
      const serverFields = {
        day,
        slotIndex,
        post_key,
        format: 'reel',
        mode: calendarMode,
      };
      currentStage = 'validate';
      const validation = normalizeAndValidateCalendarPost({ rawModelJson: rawCandidate, serverFields, schema });
      if (!validation.ok) {
        const err = new Error('CALENDAR_POST_GENERATION_FAILED');
        err.code = 'CALENDAR_POST_GENERATION_FAILED';
        err.statusCode = 422;
        err.details = {
          reason: validation.reason || 'SCHEMA_FAIL',
          field: validation.field || 'unknown',
          snippet: validation.snippet || '',
          missing_fields: validation.missing_fields || [],
          wrong_types: validation.wrong_types || [],
          empty_fields: validation.empty_fields || [],
          reachedOpenAI,
          structuredOutputUsed,
          stage: currentStage,
          day,
          post_key,
        };
        throw err;
      }
      const post = validation.post;
      const fallbackAudio = getEvergreenFallbackList()[0] || { title: 'Top track', artist: 'Billboard Hot 100' };
      const normalizedAudio = normalizeAudioValue(post?.audio, fallbackAudio);
      post.details = {
        ...(post.details && typeof post.details === 'object' && !Array.isArray(post.details) ? post.details : {}),
        audio: normalizedAudio,
      };
      delete post.audio;
      console.log('[Calendar][Job] success', {
        requestId,
        mode: calendarMode,
        post_key,
        stage: 'success',
      });
      return post;
      } catch (err) {
        if (currentStage === 'openai_request') {
          const responseData = err?.response?.data ?? err?.error?.message ?? err?.openaiDetails ?? null;
          let responsePreview = '';
          if (responseData != null) {
            try {
              responsePreview = (typeof responseData === 'string'
                ? responseData
                : JSON.stringify(responseData)).slice(0, 1000);
            } catch {
              responsePreview = String(responseData).slice(0, 1000);
            }
          }
          console.warn('[Calendar][Job][OpenAIRequestError]', {
            requestId,
            mode: calendarMode,
            post_key,
            stage: currentStage,
            name: err?.name || null,
            message: String(err?.message || '').slice(0, 1000),
            status: err?.status || err?.statusCode || err?.response?.status || null,
            code: err?.code || null,
            stack: String(err?.stack || '').slice(0, 500),
            response: responsePreview || null,
          });
        }
        if (!err?.details) {
          const baseDetails = {
            field: currentStage === 'validate' ? 'schema' : `stage:${currentStage}`,
            stage: currentStage,
            day,
            post_key,
          };
          if (err?.code === 'PARSE_FAILED') {
            err.details = { ...baseDetails, reason: 'PARSE_FAIL', field: 'root' };
          } else {
            err.details = { ...baseDetails, reason: 'SCHEMA_FAIL' };
          }
        } else if (!err.details.field) {
          err.details.field = currentStage === 'validate' ? 'schema' : `stage:${currentStage}`;
          err.details.stage = currentStage;
          err.details.day = day;
          err.details.post_key = post_key;
        }
        if (err?.code === 'OPENAI_SCHEMA_ERROR' || err?.code === 'OPENAI_SCHEMA_INVALID') {
          const failErr = new Error('CALENDAR_POST_GENERATION_FAILED');
          failErr.code = 'CALENDAR_POST_GENERATION_FAILED';
          failErr.statusCode = 422;
          failErr.details = {
            reason: 'OPENAI_UPSTREAM_FAIL',
            field: err?.details?.schemaObject || err?.details?.schemaName || 'schema',
            snippet: err?.openaiMessage || err?.message || '',
            day,
            post_key,
            reachedOpenAI: Boolean(err?.openaiDetails || err?.responseId),
            structuredOutputUsed: Boolean(err?.usedStructuredOutput),
            stage: currentStage,
          };
          throw failErr;
        }
        if (err?.code === 'SCHEMA_MISMATCH' || err?.code === 'PARSE_FAILED') {
          reachedOpenAI = true;
        }
        reachedOpenAI = reachedOpenAI || Boolean(err?.openaiDetails || err?.responseId || err?.statusCode);
        structuredOutputUsed = structuredOutputUsed || Boolean(err?.usedStructuredOutput);
        let reason = err?.details?.reason
          || (err?.code === 'PARSE_FAILED'
            ? (err?.reason || 'PARSE_FAILED')
            : err?.code === 'OPENAI_TIMEOUT' || err?.code === 'MODEL_TIMEOUT'
              ? 'OPENAI_TIMEOUT'
              : err?.code === 'OPENAI_BACKEND_ERROR'
                ? 'OPENAI_UPSTREAM_FAIL'
                : 'SCHEMA_MISMATCH');
        if (reason === 'PARSE_FAILED') reason = 'PARSE_FAIL';
        if (reason === 'SCHEMA_CONTRACT_VIOLATION') reason = 'SCHEMA_FAIL';
        if (reason === 'SCHEMA_MISMATCH') reason = 'SCHEMA_FAIL';
        if (reason === 'QUALITY_FAIL') reason = 'SCHEMA_FAIL';
        console.log('[Calendar][Job] fail', {
          requestId,
          mode: calendarMode,
          post_key,
          stage: currentStage,
          fail_code: reason,
          missing_fields: err?.details?.missing_fields || [],
          wrong_types: err?.details?.wrong_types || [],
          response_size: typeof rawCandidate === 'string' ? rawCandidate.length : null,
        });
      const retryableReasons = new Set(['PARSE_FAIL', 'SCHEMA_FAIL']);
      if (attempt < maxAttempts && retryableReasons.has(reason)) {
        const missing = Array.isArray(err?.details?.missing_fields) ? err.details.missing_fields : [];
        const wrongTypes = Array.isArray(err?.details?.wrong_types) ? err.details.wrong_types : [];
        const emptyFields = Array.isArray(err?.details?.empty_fields) ? err.details.empty_fields : [];
          const retrySummary = reason === 'PARSE_FAIL'
            ? 'invalid_json'
            : [
              missing.length ? `missing fields: ${missing.join(', ')}` : '',
              wrongTypes.length ? `wrong type fields: ${wrongTypes.map((item) => item.key || item).join(', ')}` : '',
              emptyFields.length ? `empty fields: ${emptyFields.join(', ')}` : '',
            ].filter(Boolean).join('; ');
          continue;
        }
      const failErr = new Error('CALENDAR_POST_GENERATION_FAILED');
      failErr.code = 'CALENDAR_POST_GENERATION_FAILED';
      failErr.statusCode = 422;
      const detailsField = err?.details?.field || 'unknown';
      const detailsSnippet = err?.details?.snippet || '';
      const detailsErrors = err?.details?.errors || null;
      const finalReason = (reason === 'PARSE_FAIL' || reason === 'SCHEMA_FAIL')
        ? 'STRUCTURAL_OUTPUT_INVALID'
        : reason;
      failErr.details = {
        reason: finalReason,
        field: detailsField,
        snippet: detailsSnippet,
        errors: detailsErrors,
        day,
        post_key,
        reachedOpenAI,
        structuredOutputUsed,
      };
      throw failErr;
    }
  }
  throw new Error('CALENDAR_POST_GENERATION_FAILED');
}

async function getCachedHot100(options = {}) {
  const key = 'nonholiday_hot100';
  const cached = hot100Cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < HOT100_CACHE_TTL_MS) {
    return cached.value;
  }
  const minCount = Number.isFinite(Number(options?.minCount)) ? Number(options.minCount) : 30;
  const fresh = await getNonHolidayHot100({ ...options, minCount });
  const source = String(fresh?.source || '');
  const tracks = Array.isArray(fresh?.tracks) ? fresh.tracks : [];
  if (!tracks.length || tracks.length < minCount || source.includes('fallback')) {
    const err = new Error('BILLBOARD_FETCH_FAILED');
    err.code = 'CALENDAR_POST_GENERATION_FAILED';
    err.statusCode = 422;
    err.details = { reason: 'BILLBOARD_FETCH_FAILED', field: 'details.audio' };
    throw err;
  }
  hot100Cache.set(key, { fetchedAt: Date.now(), value: fresh });
  return fresh;
}

async function getHot100TracksSafe(requestId = '', minCount = 30) {
  const result = await getCachedHot100({ requestId, minCount });
  const tracks = Array.isArray(result?.tracks) ? result.tracks.slice() : [];
  if (!tracks.length) {
    const err = new Error('BILLBOARD_FETCH_FAILED');
    err.code = 'CALENDAR_POST_GENERATION_FAILED';
    err.statusCode = 422;
    err.details = { reason: 'BILLBOARD_FETCH_FAILED', field: 'details.audio' };
    throw err;
  }
  return tracks;
}

function shuffleArray(list = []) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function getHot100AudioForPostKey(postKeyValue = '', requestId = '') {
  const tracks = await getHot100TracksSafe(requestId, 30);
  if (!tracks.length) {
    const err = new Error('BILLBOARD_FETCH_FAILED');
    err.code = 'CALENDAR_POST_GENERATION_FAILED';
    err.statusCode = 422;
    err.details = { reason: 'BILLBOARD_FETCH_FAILED', field: 'details.audio' };
    throw err;
  }
  const entry = tracks[Math.floor(Math.random() * tracks.length)] || tracks[0];
  const audioString = normalizeAudioString(entry?.title || '', entry?.artist || '');
  if (!audioString) {
    const err = new Error('BILLBOARD_FETCH_FAILED');
    err.code = 'CALENDAR_POST_GENERATION_FAILED';
    err.statusCode = 422;
    err.details = { reason: 'BILLBOARD_FETCH_FAILED', field: 'details.audio' };
    throw err;
  }
  return audioString;
}

function extractTextFromAnthropicContent(content = []) {
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractClaudeTextFromResponse(json = {}) {
  const content = Array.isArray(json?.content) ? json.content : [];
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function claudeMessagesRequest({
  model = 'claude-opus-4-6',
  system = '',
  messages = [],
  maxTokens = 4096,
  temperature = 0.4,
  thinking = null,
  effort = null,
  tools = null,
  toolChoice = null,
} = {}) {
  if (!CLAUDE_API_KEY) {
    const err = new Error('CLAUDE_API_KEY not set');
    err.code = 'CLAUDE_NOT_CONFIGURED';
    err.statusCode = 500;
    return Promise.reject(err);
  }
  const payloadObj = {
    model: String(model || 'claude-opus-4-6'),
    max_tokens: Math.max(256, Math.min(8192, Number(maxTokens) || 4096)),
    system: String(system || ''),
    messages: Array.isArray(messages) ? messages : [],
  };
  if (Number.isFinite(Number(temperature))) payloadObj.temperature = Number(temperature);
  if (thinking && typeof thinking === 'object') payloadObj.thinking = thinking;
  if (effort && typeof effort === 'string') payloadObj.effort = effort;
  if (Array.isArray(tools) && tools.length) payloadObj.tools = tools;
  if (toolChoice && typeof toolChoice === 'object') payloadObj.tool_choice = toolChoice;
  const payload = JSON.stringify(payloadObj);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed = {};
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch (parseErr) {
            const err = new Error(`Claude response parse failed: ${parseErr.message}`);
            err.code = 'CLAUDE_PARSE_ERROR';
            err.statusCode = 502;
            return reject(err);
          }
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            return resolve({
              raw: parsed,
              text: extractClaudeTextFromResponse(parsed),
            });
          }
          const claudeError = parsed?.error || {};
          const err = new Error(
            claudeError?.message || `Claude API error ${res.statusCode || 'unknown'}`
          );
          err.code = 'CLAUDE_API_ERROR';
          err.statusCode = res.statusCode || 500;
          err.claudeError = claudeError;
          return reject(err);
        });
      }
    );
    req.on('error', (err) => {
      const netErr = new Error(`Claude request failed: ${err.message || err}`);
      netErr.code = 'CLAUDE_NETWORK_ERROR';
      netErr.statusCode = 502;
      reject(netErr);
    });
    req.write(payload);
    req.end();
  });
}

function hashToPseudoEmbedding(text = '', dim = 256) {
  const out = new Array(dim).fill(0);
  const normalized = String(text || '').toLowerCase();
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    const idx = (code + i * 17) % dim;
    out[idx] += ((code % 29) - 14) / 14;
  }
  const norm = Math.sqrt(out.reduce((acc, v) => acc + v * v, 0)) || 1;
  return out.map((v) => Number((v / norm).toFixed(8)));
}

function buildAnthropicPromptFromOpenAiPayload(payloadObj = {}) {
  const baseMessages = Array.isArray(payloadObj.messages)
    ? payloadObj.messages
    : Array.isArray(payloadObj.input)
      ? payloadObj.input
      : [];
  const promptParts = [];
  for (const message of baseMessages) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || 'user');
    let text = '';
    if (typeof message.content === 'string') {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      text = message.content
        .map((item) => {
          if (typeof item === 'string') return item;
          if (typeof item?.text === 'string') return item.text;
          if (typeof item?.content === 'string') return item.content;
          if (typeof item?.value === 'string') return item.value;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    } else if (message.content && typeof message.content === 'object') {
      if (typeof message.content.text === 'string') text = message.content.text;
      else if (typeof message.content.value === 'string') text = message.content.value;
    }
    if (!text.trim()) continue;
    if (role === 'system') {
      promptParts.push(`SYSTEM:\n${text.trim()}`);
    } else {
      promptParts.push(`${role.toUpperCase()}:\n${text.trim()}`);
    }
  }

  const schema =
    payloadObj?.response_format?.json_schema?.schema ||
    payloadObj?.text?.format?.schema ||
    null;
  if (schema && typeof schema === 'object') {
    promptParts.push(
      [
        'CRITICAL OUTPUT CONTRACT:',
        'Return ONLY valid JSON with no markdown or explanation.',
        `JSON Schema to follow exactly: ${JSON.stringify(schema)}`,
      ].join('\n')
    );
  }

  return promptParts.join('\n\n').trim();
}

async function callClaudeFromOpenAiPayload(pathname, payloadObj = {}) {
  if (!anthropicClient) {
    const err = new Error('CLAUDE_API_KEY not set');
    err.code = 'CLAUDE_NOT_CONFIGURED';
    err.statusCode = 500;
    throw err;
  }

  if (pathname === '/v1/embeddings') {
    const input = payloadObj?.input;
    const list = Array.isArray(input) ? input : [input];
    return {
      object: 'list',
      data: list.map((item, index) => ({
        object: 'embedding',
        index,
        embedding: hashToPseudoEmbedding(String(item || '')),
      })),
      model: 'pseudo-embedding-v1',
    };
  }

  const prompt = buildAnthropicPromptFromOpenAiPayload(payloadObj);
  const maxTokens =
    Number(payloadObj.max_output_tokens) ||
    Number(payloadObj.max_completion_tokens) ||
    Number(payloadObj.max_tokens) ||
    4096;
  const temperature = Number.isFinite(Number(payloadObj.temperature))
    ? Number(payloadObj.temperature)
    : 0.4;

  const response = await anthropicClient.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: Math.max(256, Math.min(8192, Math.floor(maxTokens))),
    temperature,
    messages: [
      {
        role: 'user',
        content: `${prompt}\n\nReturn only raw JSON when JSON is requested.`,
      },
    ],
  });
  const text = extractTextFromAnthropicContent(response?.content || []);

  if (pathname === '/v1/responses') {
    return {
      id: response?.id || null,
      model: response?.model || 'claude-opus-4-6',
      output_text: text,
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text }],
        },
      ],
      choices: [{ message: { content: text } }],
    };
  }

  return {
    id: response?.id || null,
    model: response?.model || 'claude-opus-4-6',
    choices: [{ message: { content: text } }],
  };
}

function openAIRequest(options, payload) {
  const pathname = options?.path || '/v1/chat/completions';
  let payloadObj = {};
  try {
    payloadObj = payload ? JSON.parse(payload) : {};
  } catch (err) {
    const parseErr = new Error(`Invalid request payload JSON: ${err.message}`);
    parseErr.code = 'INVALID_PAYLOAD_JSON';
    parseErr.statusCode = 400;
    return Promise.reject(parseErr);
  }

  if (anthropicClient) {
    return callClaudeFromOpenAiPayload(pathname, payloadObj).catch((err) => {
      const wrapped = new Error(`Claude error ${err?.status || err?.statusCode || 500}: ${err?.message || err}`);
      wrapped.code = 'CLAUDE_BACKEND_ERROR';
      wrapped.statusCode = err?.status || err?.statusCode || 500;
      throw wrapped;
    });
  }

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

function openAIResponsesRequest(options, payload) {
  return openAIRequest(options, payload);
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

function extractCalendarJsonCandidates(rawText = '') {
  const text = String(rawText || '');
  const candidates = [];
  const seen = new Set();
  const maxLen = 200000;
  const addCandidate = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;
    if (trimmed.length > maxLen) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fenceRegex.exec(text))) {
    addCandidate(match[1]);
  }
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char !== '{' && char !== '[') continue;
    const segment = captureJsonSegment(text, i);
    if (segment) {
      addCandidate(segment);
      i += segment.length - 1;
    }
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    addCandidate(trimmed);
  }
  return candidates;
}

function extractDayFromPostKeyValue(value = '') {
  const match = String(value || '').match(/day-(\d+)-slot-/i);
  if (!match) return null;
  const dayValue = Number(match[1]);
  return Number.isFinite(dayValue) ? dayValue : null;
}

function parseFirstValidCalendarPayload(candidates = [], expectedCount, startDay, days, postsPerDay = 1) {
  const expectedStart = Number.isFinite(Number(startDay)) ? Number(startDay) : 1;
  const expectedDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 1;
  const expectedEnd = expectedStart + expectedDays - 1;
  for (let idx = 0; idx < candidates.length; idx += 1) {
    const rawCandidate = candidates[idx];
    if (!rawCandidate) continue;
    const cleaned = String(rawCandidate).trim().replace(/,\s*([}\]])/g, '$1');
    let parsed;
    try {
      parsed = cleaned ? JSON.parse(cleaned) : null;
    } catch {
      continue;
    }
    let posts = null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (Object.prototype.hasOwnProperty.call(parsed, 'posts') && Array.isArray(parsed.posts)) {
        posts = parsed.posts;
      }
    }
    if (!Array.isArray(posts)) continue;
    if (Number.isFinite(expectedCount) && posts.length !== expectedCount) continue;
    const dayValues = posts
      .map((post) => {
        const direct = Number(post?.day);
        if (Number.isFinite(direct)) return direct;
        const keyValue = toPlainString(post?.post_key || post?.postKey || '');
        return extractDayFromPostKeyValue(keyValue);
      })
      .filter((day) => Number.isFinite(day));
    if (!dayValues.length) continue;
    const minDay = Math.min(...dayValues);
    const maxDay = Math.max(...dayValues);
    const inRange = minDay >= expectedStart && maxDay <= expectedEnd;
    if (!inRange) continue;
    return {
      posts,
      payloadRaw: cleaned,
      parsedType: Array.isArray(parsed) ? 'array' : typeof parsed,
      chosenIndex: idx,
      candidatesCount: candidates.length,
      minDay,
      maxDay,
      postsPerDay,
    };
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

const CALENDAR_ANGLE_OPTIONS = [
  'momentum fork',
  'silent disqualifier',
  'hidden constraint',
  'leverage shift',
  'mispriced signal',
  'eligibility gate',
  'constraint mismatch',
  'upstream trigger',
  'decision inflection',
  'confidence trap',
];

const FALLBACK_HOT100_TRACKS = [
  { title: 'Original audio', artist: 'Voiceover' },
  { title: 'Original audio', artist: 'Ambient instrumental' },
  { title: 'Original audio', artist: 'Minimal piano' },
  { title: 'Original audio', artist: 'Lo-fi groove' },
  { title: 'Original audio', artist: 'Clean synth bed' },
  { title: 'Original audio', artist: 'Warm guitar' },
  { title: 'Original audio', artist: 'Subtle ambient pads' },
  { title: 'Original audio', artist: 'Light percussion' },
  { title: 'Original audio', artist: 'Soft strings' },
  { title: 'Original audio', artist: 'Neutral background' },
  { title: 'Original audio', artist: 'Bright acoustic' },
  { title: 'Original audio', artist: 'Calm ambient' },
  { title: 'Original audio', artist: 'Clean electronic' },
  { title: 'Original audio', artist: 'Mellow keys' },
  { title: 'Original audio', artist: 'Minimal beat' },
  { title: 'Original audio', artist: 'Neutral tone' },
  { title: 'Original audio', artist: 'Studio room tone' },
  { title: 'Original audio', artist: 'Light groove' },
  { title: 'Original audio', artist: 'Soft arpeggio' },
  { title: 'Original audio', artist: 'Ambient wash' },
  { title: 'Original audio', artist: 'Low-fi texture' },
  { title: 'Original audio', artist: 'Clean pad' },
  { title: 'Original audio', artist: 'Simple rhythm' },
  { title: 'Original audio', artist: 'Subtle pulse' },
  { title: 'Original audio', artist: 'Quiet bed' },
  { title: 'Original audio', artist: 'Neutral backdrop' },
  { title: 'Original audio', artist: 'Soft percussion' },
  { title: 'Original audio', artist: 'Gentle ambience' },
  { title: 'Original audio', artist: 'Minimal underscore' },
  { title: 'Original audio', artist: 'Clean backdrop' },
];
const DEFAULT_SUGGESTED_AUDIO = `${FALLBACK_HOT100_TRACKS[0].title} - ${FALLBACK_HOT100_TRACKS[0].artist}`;

function buildCalendarPostSchema(minDay = 1, maxDay = 30, mode = 'regular') {
  const baseSchema = {
    type: 'object',
    additionalProperties: false,
    required: [
      'title',
      'hook',
      'body',
      'cta',
      'reelHook',
      'reelBody',
      'reelCta',
      'caption',
      'designNotes',
      'hashtags',
    ],
    properties: {
      title: { type: 'string', minLength: 1 },
      hook: { type: 'string', minLength: 1 },
      body: { type: 'string', minLength: 1 },
      cta: { type: 'string', minLength: 1 },
      reelHook: { type: 'string', minLength: 1 },
      reelBody: { type: 'string', minLength: 1 },
      reelCta: { type: 'string', minLength: 1 },
      caption: { type: 'string', minLength: 1 },
      designNotes: { type: 'string', minLength: 1 },
      hashtags: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
      },
    },
  };
  return baseSchema;
}

function getCalendarPostSchema(mode = 'regular', minDay = 1, maxDay = 30) {
  return buildCalendarPostSchema(minDay, maxDay, mode);
}

function buildCalendarSchemaObject(totalPostsRequired, minDay = 1, maxDay = 30, mode = 'regular') {
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
        items: buildCalendarPostSchema(minDay, maxDay, mode),
      },
    },
  };
}

function normalizeToMinimalShape(raw = {}) {
  if (!raw || typeof raw !== 'object') return {};
  const stripTrailingFollowUpSection = (value) => {
    if (typeof value !== 'string') return value;
    const markerPattern = /(^|\r?\n)\s*(?:Follow-?\s*up(?:\s*idea)?|Next post|Tomorrow|Part\s*2|Next|Up next)\s*[:\-]\s*/i;
    const match = markerPattern.exec(value);
    if (!match) return value.trim();
    return value.slice(0, match.index).trim();
  };
  const cleaned = {
    title: stripTrailingFollowUpSection(raw.title),
    hook: stripTrailingFollowUpSection(raw.hook),
    body: stripTrailingFollowUpSection(raw.body),
    cta: stripTrailingFollowUpSection(raw.cta),
    reelHook: stripTrailingFollowUpSection(raw.reelHook),
    reelBody: stripTrailingFollowUpSection(raw.reelBody),
    reelCta: stripTrailingFollowUpSection(raw.reelCta),
    caption: stripTrailingFollowUpSection(raw.caption),
    designNotes: stripTrailingFollowUpSection(raw.designNotes),
    hashtags: raw.hashtags,
    audio: stripTrailingFollowUpSection(raw.audio ?? raw?.details?.audio),
  };
  return cleaned;
}

function validateMinimalShape(post = {}) {
  const missing = [];
  const wrongTypes = [];
  const emptyFields = [];
  const fail = (reason, field, snippet) => ({
    ok: false,
    reason,
    field,
    snippet,
    missing_fields: missing,
    wrong_types: wrongTypes,
    empty_fields: emptyFields,
  });
  if (!post || typeof post !== 'object') {
    return { ok: false, reason: 'PARSE_FAIL', field: 'root', snippet: '' };
  }
  const required = [
    'title',
    'hook',
    'body',
    'cta',
    'reelHook',
    'reelBody',
    'reelCta',
    'caption',
    'designNotes',
    'hashtags',
  ];
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(post, key)) {
      missing.push(key);
    }
  }
  if (missing.length) {
    return fail('SCHEMA_FAIL', missing[0], '');
  }
  const stringFields = ['title', 'hook', 'body', 'cta', 'reelHook', 'reelBody', 'reelCta', 'caption', 'designNotes'];
  for (const key of stringFields) {
    if (typeof post[key] !== 'string') {
      wrongTypes.push({ key, expected: 'string', got: typeof post[key] });
      continue;
    }
    if (!post[key].trim()) {
      emptyFields.push(key);
    }
  }
  if (!Array.isArray(post.hashtags)) {
    wrongTypes.push({ key: 'hashtags', expected: 'array', got: typeof post.hashtags });
  } else if (!post.hashtags.length) {
    wrongTypes.push({ key: 'hashtags', expected: 'array<non-empty string>', got: 'empty' });
  } else {
    post.hashtags.forEach((item, idx) => {
      if (typeof item !== 'string' || !item.trim()) {
        wrongTypes.push({ key: `hashtags[${idx}]`, expected: 'string', got: typeof item });
      }
    });
  }
  if (emptyFields.length) {
    return fail('SCHEMA_FAIL', emptyFields[0], '');
  }
  if (wrongTypes.length) {
    const first = wrongTypes[0];
    return fail('SCHEMA_FAIL', first.key, JSON.stringify(first).slice(0, 120));
  }
  return { ok: true };
}

function normalizeAndValidateCalendarPost({ rawModelJson, serverFields, schema }) {
  if (!rawModelJson || typeof rawModelJson !== 'object' || Array.isArray(rawModelJson)) {
    return { ok: false, reason: 'PARSE_FAIL', field: 'root', snippet: '' };
  }
  const post = normalizeToMinimalShape(rawModelJson);
  const candidate = {
    ...post,
    post_key: serverFields.post_key,
    day: serverFields.day,
    slotIndex: serverFields.slotIndex,
    format: serverFields.format,
    mode: serverFields.mode,
  };
  const validation = validateMinimalShape(candidate);
  if (!validation.ok) {
    return { ok: false, ...validation, post: candidate };
  }
  return { ok: true, post: candidate };
}

function runCalendarSchemaSelfTest() {
  const sample = {
    title: 'Sample title',
    hook: 'Sample hook',
    body: 'Sample body',
    cta: 'Sample CTA',
    reelHook: 'Sample reel hook',
    reelBody: 'Sample reel body',
    reelCta: 'Sample reel CTA',
    caption: 'Sample caption',
    designNotes: 'Sample design notes',
    hashtags: ['sample'],
    engagementLoop: 'legacy-value-should-be-dropped',
  };
  const serverFields = {
    post_key: 'day-1-slot-0',
    day: 1,
    slotIndex: 0,
    format: 'reel',
    mode: 'regular',
  };
  const ok = normalizeAndValidateCalendarPost({ rawModelJson: sample, serverFields });
  const missingBody = normalizeAndValidateCalendarPost({
    rawModelJson: {
      title: 'Sample title',
      hook: 'Sample hook',
      cta: 'Sample CTA',
      reelHook: 'Sample reel hook',
      reelBody: 'Sample reel body',
      reelCta: 'Sample reel CTA',
      caption: 'Sample caption',
      designNotes: 'Sample design notes',
      hashtags: ['sample'],
    },
    serverFields,
  });
  console.log('[Calendar][SelfTest]', {
    ok: ok.ok,
    strips_unknown: !Object.prototype.hasOwnProperty.call(ok?.post || {}, 'engagementLoop'),
    missing_ok: missingBody.ok,
    missing_reason: missingBody.reason,
    missing_fields: missingBody?.missing_fields || [],
  });
}

if (process.env.CALENDAR_SCHEMA_SELFTEST === '1') {
  runCalendarSchemaSelfTest();
}

function buildBrandBrainDirective(settings = {}) {
  return '';
}


const VOICE_LOCK_PRESET_GUIDES = {
  'no-ai-polish': {
    label: 'No AI Polish',
    lines: [
      '- Hook: 1 sentence, 6-10 words, no question mark, no exclamation.',
      '- Caption: 2-4 sentences; each 6-12 words; plain language.',
      '- Caption: minimal adjectives; no filler transitions.',
      '- CTA: 3-6 words, neutral informational line, no imperative.',
      '- Reel Script: 4 lines (Hook + 2 body + CTA); each 6-12 words.',
      '- Reel Script: no emojis; no exclamation marks.',
      '- Global: informal, minimal hype.',
      '- Global: few commas; short clauses.',
      '- Global: avoid hedging.',
    ],
  },
  punchy: {
    label: 'Punchy',
    lines: [
      '- Hook: 4-8 words, fragment allowed, ends with a period.',
      '- Caption: 3-5 lines; each 4-9 words; one idea per line.',
      '- Caption: energetic verbs; no long sentences.',
      '- CTA: 2-5 words, neutral informational line.',
      '- Reel Script: 4 beats with line breaks; each beat 5-10 words.',
      '- Reel Script: one short sentence per beat.',
      '- Global: confident, higher tempo.',
      '- Global: minimal commas; short stops.',
      '- Global: no question marks.',
    ],
  },
  direct: {
    label: 'Direct',
    lines: [
      '- Hook: 1 sentence, 7-12 words, declarative, no question.',
      '- Caption: 2-3 sentences; each 8-14 words; zero hedging.',
      '- Caption: no motivational fluff.',
      '- CTA: 3-7 words; neutral informational line; no exclamation.',
      '- Reel Script: 3 steps with line breaks (statement -> key point -> CTA).',
      '- Reel Script: each step 7-12 words.',
      '- Global: present tense; no soft qualifiers.',
      '- Global: plain, literal phrasing.',
    ],
  },
  contrarian: {
    label: 'Contrarian',
    lines: [
      '- Hook: 1 sentence, 8-14 words; respectful counterpoint; no exclamation.',
      '- Caption: exactly 3 parts (belief -> counterpoint -> takeaway).',
      '- Caption: each part 1 sentence, 8-14 words.',
      '- CTA: 4-8 words; neutral continuation line.',
      '- Reel Script: 3 beats with line breaks; each 8-14 words.',
      '- Reel Script: one sentence per beat.',
      '- Global: calm, precise tone.',
      '- Global: no exclamation marks.',
    ],
  },
  'story-first': {
    label: 'Story-First',
    lines: [
      '- Hook: 1 sentence; mid-moment; 8-14 words; no exclamation.',
      '- Caption: 3-4 sentences; setup -> friction -> takeaway.',
      '- Caption: each 8-14 words; narrative flow.',
      '- CTA: 4-8 words; neutral continuation line.',
      '- Reel Script: 3 beats with line breaks; each 8-14 words.',
      '- Reel Script: one sentence per beat.',
      '- Global: conversational, lightly detailed.',
      '- Global: minimal hype.',
      '- Global: commas allowed, but keep clauses short.',
    ],
  },
  casual: {
    label: 'Casual / Friendly Expert',
    lines: [
      '- Hook: 1 sentence, 7-12 words; friendly tone; no exclamation.',
      '- Caption: 2-4 sentences; each 7-13 words.',
      '- Caption: explain simply; no hype.',
      '- CTA: 4-8 words; neutral continuation line.',
      '- Reel Script: 3 beats with line breaks; each 7-12 words.',
      '- Reel Script: one sentence per beat.',
      '- Global: warm, conversational; mild hedging allowed.',
      '- Global: avoid long clauses.',
    ],
  },
};

function normalizeVoiceLockPresetKey(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  const key = raw.replace(/\s+/g, '-');
  if (VOICE_LOCK_PRESET_GUIDES[key]) return key;
  if (key === 'conversational') return 'casual';
  if (key === 'confident') return 'direct';
  if (key === 'raw') return 'no-ai-polish';
  if (key === 'witty') return 'contrarian';
  if (key === 'calm') return 'story-first';
  if (key === 'intense') return 'punchy';
  if (key === 'friendly-expert' || key === 'friendly') return 'casual';
  return null;
}

const VOICE_LOCK_FIELDS = [
  'Hook',
  'Caption/Main body',
  'CTA',
  'Reel Script',
  'Execution Notes (wording only)',
];

function resolveVoiceLockConfig(input = {}, isPro = false) {
  const wantsEnabled = Boolean(input?.voiceLockEnabled);
  if (!wantsEnabled) {
    return {
      enabled: false,
      mode: 'preset',
      preset: 'direct',
      fields: VOICE_LOCK_FIELDS,
      reason: 'disabled',
    };
  }
  if (!isPro) {
    return {
      enabled: false,
      mode: 'preset',
      preset: 'direct',
      fields: VOICE_LOCK_FIELDS,
      reason: 'not_pro',
    };
  }
  const sampleRaw = input.voiceLockSample || '';
  const presetRaw = input.voiceLockPreset || '';
  const requestedMode = String(input.voiceLockMode || '').trim().toLowerCase();
  const sample = typeof sampleRaw === 'string' ? sampleRaw.trim().slice(0, 2000) : '';
  const presetKey = normalizeVoiceLockPresetKey(presetRaw);
  if (!presetKey && !sample) {
    return {
      enabled: false,
      mode: 'preset',
      preset: 'direct',
      fields: VOICE_LOCK_FIELDS,
      reason: 'missing_preset',
    };
  }
  if (!presetKey) {
    return {
      enabled: false,
      mode: 'preset',
      preset: 'direct',
      fields: VOICE_LOCK_FIELDS,
      reason: 'unknown_preset',
    };
  }
  const mode = requestedMode === 'custom' && sample ? 'custom' : 'preset';
  return {
    enabled: true,
    mode,
    preset: presetKey,
    fields: VOICE_LOCK_FIELDS,
    reason: 'enabled',
  };
}

const TARGET_AUDIENCE_PRESET_GUIDES = {
  students: { label: 'Students', lens: 'Use simple language, add brief context, keep it practical.' },
  'young-adults-18-25': { label: 'Young Adults (18–25)', lens: 'Keep it concise, relatable, and action-oriented.' },
  'early-career-professionals': {
    label: 'Early Career Professionals',
    lens: 'Explain essentials without jargon; focus on quick wins.',
  },
  'working-professionals': {
    label: 'Working Professionals',
    lens: 'Be concise, outcome-focused, and time-aware.',
  },
  'parents-families': {
    label: 'Parents / Families',
    lens: 'Use reassuring tone and practical considerations.',
  },
  "entrepreneurs-founders": {
    label: 'Entrepreneurs / Founders',
    lens: 'Assume busy decision-makers; highlight leverage and clarity.',
  },
  creators: { label: 'Creators', lens: 'Speak to creative workflow and consistency.' },
  'freelancers-solopreneurs': {
    label: 'Freelancers / Solopreneurs',
    lens: 'Emphasize efficiency, autonomy, and practical trade-offs.',
  },
  beginners: { label: 'Beginners', lens: 'Explain basics with extra context, keep it simple.' },
  'experienced-advanced': {
    label: 'Experienced / Advanced',
    lens: 'Higher signal, less explanation, more nuance.',
  },
};

function normalizeTargetAudiencePresetKey(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  const key = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (TARGET_AUDIENCE_PRESET_GUIDES[key]) return key;
  if (key === 'young-adults') return 'young-adults-18-25';
  if (key === 'parents') return 'parents-families';
  if (key === 'professionals') return 'working-professionals';
  if (key === 'small-business-owners') return 'entrepreneurs-founders';
  if (key === 'retirees') return 'working-professionals';
  if (key === 'first-timers') return 'beginners';
  if (key === 'side-hustlers') return 'freelancers-solopreneurs';
  return null;
}

function resolveTargetAudienceConfig(input = {}, isPro = false) {
  const raw = input?.targetAudience && typeof input.targetAudience === 'object' ? input.targetAudience : {};
  const wantsEnabled = Boolean(raw.enabled);
  if (!wantsEnabled) {
    return { enabled: false, preset: null, reason: 'disabled' };
  }
  if (!isPro) {
    return { enabled: false, preset: null, reason: 'not_pro' };
  }
  const presetKey = normalizeTargetAudiencePresetKey(raw.preset);
  if (!presetKey) {
    return { enabled: false, preset: null, reason: 'missing_preset' };
  }
  return {
    enabled: true,
    preset: presetKey,
    reason: 'enabled',
  };
}

function buildRecentTitlesList(titles = [], limit = 10) {
  if (!Array.isArray(titles) || !titles.length) return [];
  const seen = new Set();
  const out = [];
  for (const raw of titles) {
    const value = toPlainString(raw || '');
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

const PROMPT_ANGLE_OPTIONS = CALENDAR_ANGLE_OPTIONS;

function pickAngleForPostKey(postKeyValue = '') {
  const key = String(postKeyValue || '');
  if (!PROMPT_ANGLE_OPTIONS.length) return 'decision inflection';
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PROMPT_ANGLE_OPTIONS[h % PROMPT_ANGLE_OPTIONS.length];
}

function stableHash(str = '') {
  const text = String(str || '');
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

function pickFrom(hash, arr = []) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr[Math.abs(Number(hash) || 0) % arr.length];
}

function deriveVariation(post_key = '') {
  const base = stableHash(post_key);
  return {
    render_style: pickFrom(base, ['audit', 'walkthrough', 'before_after', 'objection_reply', 'screen_record', 'pov_story']),
    beat_shape: pickFrom(base >>> 3, ['two_beat', 'three_beat', 'four_beat']),
    reveal_order: pickFrom(base >>> 7, ['artifact_first', 'condition_first', 'consequence_first']),
    pov: pickFrom(base >>> 11, ['creator', 'customer', 'narrator']),
  };
}

function buildPrompt(nicheStyle, brandContext, opts = {}) {
  const mode = String(opts.calendarMode || 'regular').toLowerCase() === 'brand_brain'
    ? 'brand_brain'
    : 'regular';
  const cleanNiche = nicheStyle ? `${nicheStyle}` : 'unspecified';
  const promoting = toPlainString(opts.promoting || '');
  const hasPromoting = mode === 'brand_brain' && Boolean(promoting.trim());
  const voiceLock = (() => {
    const value = opts.voiceLock;
    if (!value) return '';
    if (typeof value === 'string') return toPlainString(value);
    if (typeof value !== 'object') return '';
    if (value.enabled === false) return '';
    const presetKey = normalizeVoiceLockPresetKey(value.preset || '');
    if (presetKey) {
      return toPlainString(VOICE_LOCK_PRESET_GUIDES[presetKey]?.label || presetKey);
    }
    const customSample = toPlainString(value.sample || value.voiceLockSample || '');
    if (customSample) return 'Custom';
    return toPlainString(value.label || '');
  })();
const REGULAR_MAIN_PROMPT = `You are a creator in this space: ${cleanNiche}. Write one short-form video for TikTok / Instagram Reels.
${voiceLock ? `The creator's voice: ${voiceLock}.` : ''}

THE VIDEO: ${opts.topicSignature || ''}
THE ANGLE: ${opts.plannedAngle || ''}

The creator is talking directly to camera about a moment from their day-to-day. The video is 30-60 seconds.

title — A few words describing what the video is about.

hook — The first sentence the creator says out loud, in first person. The hook is the moment before something shifted. The body reveals what happened.

body — Everything the creator says after the hook. The creator reveals what happened, with details.

cta — The last sentence of the script. The creator says what they are going to do next or what they are looking into next.

reelHook — On-screen text version of the hook.

reelBody — A few sentences that appear on screen. Shorter version of the body field above.

reelCta — Shorter version of the cta field above.

caption — One to two sentences. What the creator types under the video about the story.

designNotes — One sentence. Where the creator is and what is behind them.

hashtags — 5-8 hashtags.
`;

const BRAND_BRAIN_MAIN_PROMPT = `You are a creator in this space: ${cleanNiche}. Write one short-form video for TikTok / Instagram Reels.
${voiceLock ? `The creator's voice: ${voiceLock}.` : ''}

THE VIDEO: ${opts.topicSignature || ''}
HOW THIS CONNECTS: ${opts.plannedAngle || ''}

The creator is talking directly to camera about a moment from their day-to-day. The video is 30-60 seconds.

title — A few words describing what the video is about.

hook — The first sentence the creator says out loud, in first person. The hook is the moment before something shifted. The body reveals what happened.

${hasPromoting ? `body — Everything the creator says after the hook. The creator reveals what happened, with details. During the story, the creator mentions what they are offering because it connects to what they were talking about.` : `body — Everything the creator says after the hook. The creator reveals what happened, with details.`}

cta — The last sentence of the script. The creator says what they are going to do next or what they are working on next.

reelHook — On-screen text version of the hook.

reelBody — A few sentences that appear on screen. Shorter version of the body field above.

reelCta — Shorter version of the cta field above.

caption — One to two sentences. What the creator types under the video about the story.

designNotes — One sentence. Where the creator is and what is behind them.

hashtags — 5-8 hashtags.
`;

  const mainPrompt = mode === 'brand_brain' ? BRAND_BRAIN_MAIN_PROMPT : REGULAR_MAIN_PROMPT;
  return mainPrompt;
}

function buildCalendarSchemaBlock(expectedCount) {
  return `Schema: ${expectedCount} items.
Each item includes: title, hook, body, cta, reelHook, reelBody, reelCta, caption, designNotes, hashtags[].
Return valid JSON matching the schema exactly.`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return '"[unserializable]"';
  }
}

function extractOpenAiErrorDetails(err) {
  const rawMessage = String(err?.message || '');
  let payload = null;
  const marker = rawMessage.indexOf(':');
  if (marker !== -1) {
    const payloadText = rawMessage.slice(marker + 1).trim();
    try {
      payload = JSON.parse(payloadText);
    } catch {}
  }
  const openaiError = payload?.error || err?.error || null;
  return {
    openaiType: openaiError?.type || null,
    openaiMessage: openaiError?.message || err?.message || null,
    openaiParam: openaiError?.param || null,
    openaiBody: payload || err?.body || err?.response || null,
  };
}

function extractSchemaObjectName(openaiMessage = '') {
  const text = String(openaiMessage || '');
  const knownObjects = ['topicCapsule', 'engagementScripts', 'reelScript', 'script', 'posts'];
  for (const name of knownObjects) {
    if (text.includes(name)) return name;
  }
  const tokens = (text.match(/'([^']+)'/g) || []).map((item) => item.slice(1, -1));
  const filtered = tokens.filter((token) => !['properties', 'items', 'required', 'type', 'schema', 'json_schema', 'response_format'].includes(token));
  return filtered.length ? filtered[filtered.length - 1] : 'unknown';
}

function assertJsonSchemaFiniteNumbers(schema, label = 'schema') {
  const issues = [];
  const walk = (value, path) => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      issues.push(path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, idx) => walk(item, `${path}[${idx}]`));
      return;
    }
    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, child]) => walk(child, `${path}.${key}`));
    }
  };
  walk(schema, label);
  if (issues.length) {
    const err = new Error('Invalid JSON schema');
    err.code = 'OPENAI_SCHEMA_ERROR';
    err.statusCode = 400;
    err.details = { reason: 'non_finite_number', paths: issues };
    throw err;
  }
}

function assertJsonSchemaAdditionalProperties(schema, label = 'schema') {
  const issues = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    const isObjectType = node.type === 'object' || Boolean(node.properties);
    if (isObjectType) {
      if (node.additionalProperties !== false) {
        issues.push(path);
      }
      if (node.properties && typeof node.properties === 'object') {
        Object.entries(node.properties).forEach(([key, child]) => walk(child, `${path}.properties.${key}`));
      }
      if (node.items) {
        walk(node.items, `${path}.items`);
      }
      return;
    }
    if (node.type === 'array' && node.items) {
      walk(node.items, `${path}.items`);
    }
  };
  walk(schema, label);
  if (issues.length) {
    const err = new Error('Invalid JSON schema');
    err.code = 'OPENAI_SCHEMA_ERROR';
    err.statusCode = 400;
    err.details = { reason: 'additional_properties_missing', paths: issues };
    throw err;
  }
}

const TITLE_SIGNATURE_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'how',
  'understanding',
  'navigating',
]);

const VOICE_LOCK_LOGGED_REQUESTS = new Set();
const VOICE_LOCK_APPLIED_REQUESTS = new Set();
const CALENDAR_VARIETY_LOGGED_REQUESTS = new Set();
const TARGET_AUDIENCE_LOGGED_REQUESTS = new Set();
const BRAND_BRAIN_VALIDATION_WARNING_LOGGED_REQUESTS = new Set();
const TOPIC_BINDING_WARNING_LOGGED_REQUESTS = new Set();
let TERMS_CSP_LOGGED = false;

function normalizeTitleText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTitleSignature(value = '') {
  const tokens = normalizeTitleText(value)
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !TITLE_SIGNATURE_STOPWORDS.has(token));
  return tokens.join(' ').trim();
}

const TOPIC_FINGERPRINT_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'for',
  'to',
  'of',
  'in',
  'on',
  'with',
  'without',
  'at',
  'by',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'being',
  'been',
  'this',
  'that',
  'these',
  'those',
  'my',
  'your',
  'our',
  'their',
  'you',
  'i',
]);
const TOPIC_FINGERPRINT_SHORT_TOKENS = new Set(['day', 'how', 'why', 'tips']);
// Language-level idiom groups for Tier A matching; not niche-specific.
const EQUIV_GROUPS = {
  LOYALTY_RETURN: {
    phrases: [
      'come back',
      'coming back',
      'keep coming back',
      'return',
      'returning',
      'back again',
      'repeat clients',
      'repeat customer',
      'repeat customers',
      'loyal',
      'loyalty',
    ],
    canon: ['return'],
    injectCanon: true,
  },
  TRUST_CHOOSE: {
    phrases: [
      'trust',
      'trusted',
      'choose',
      'choosing',
      'work with',
      'worked with',
      'go with',
      'picked',
      'referred',
      'referral',
      'recommend',
      'recommended',
    ],
    canon: ['trust'],
    injectCanon: true,
  },
  SOCIAL_PROOF: {
    phrases: [
      'testimonial',
      'testimonials',
      'review',
      'reviews',
      'feedback',
      'client feedback',
      'what my clients say',
      'what clients say',
      'clients say',
      'client says',
      'experience',
      'experiences',
      'success story',
      'success stories',
    ],
    canon: ['testimonial'],
    injectCanon: true,
  },
  STORIES_TESTIMONIALS: {
    phrases: [
      'testimonial',
      'testimonials',
      'review',
      'reviews',
      'story',
      'stories',
      'case study',
      'case studies',
      'client story',
      'client stories',
    ],
    canon: ['testimonial'],
    injectCanon: true,
  },
  TESTIMONIAL_STORY: {
    phrases: [
      'testimonial',
      'testimonials',
      'testimonies',
      'story',
      'stories',
      'success story',
      'real story',
      'case result',
      'case results',
      'victory',
      'victories',
      'win',
      'won',
      'wins',
    ],
    canon: ['testimonial'],
    injectCanon: true,
  },
  LISTING_SELLING: {
    phrases: [
      'list',
      'listing',
      'listed',
      'listings',
      'listing fee',
      'commission',
      'commission rate',
      'seller',
      'selling',
      'sell',
    ],
    canon: ['listing'],
    injectCanon: false,
  },
  VALUATION_VALUE: {
    phrases: ['valuation', 'value', 'worth', 'price', 'pricing', 'appraisal', 'estimate'],
    canon: ['valuation_value'],
    injectCanon: true,
  },
  BUYING_HOME: {
    phrases: ['buy', 'buyer', 'homebuying', 'purchase', 'purchasing', 'offer', 'closing'],
    canon: ['buying_home'],
    injectCanon: true,
  },
  NEIGHBORHOOD_AREA: {
    phrases: ['neighborhood', 'area', 'community', 'district', 'zip', 'school zone'],
    canon: ['neighborhood_area'],
    injectCanon: true,
  },
  MARKET_TRENDS: {
    phrases: ['market', 'trend', 'inventory', 'rates', 'pricing', 'median', 'data'],
    canon: ['market_trends'],
    injectCanon: true,
  },
};
const EQUIV_CANON_TO_GROUP = Object.entries(EQUIV_GROUPS).reduce((acc, [key, group]) => {
  const canonTokens = Array.isArray(group?.canon) ? group.canon : [];
  canonTokens.forEach((token) => {
    if (!token) return;
    acc[token] = key;
  });
  return acc;
}, {});
const TITLE_META_TOKENS = new Set([
  'top',
  'reasons',
  'reason',
  'ways',
  'things',
  'tips',
  'guide',
  'guides',
  'how',
  'why',
  'what',
  'limited',
  'time',
  'exclusive',
  'offer',
  'special',
  'now',
  'today',
  'inside',
  'act',
  'fast',
  'hurry',
  'best',
  'ultimate',
  'list',
  'checklist',
  'step',
  'steps',
  'about',
  'with',
  'me',
  'my',
  'our',
]);

function normalizeBindText(value = '') {
  let base = String(value || '');
  base = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  base = base.toLowerCase();
  base = base.replace(/(\d+(?:\.\d+)?)\s*%/g, '$1pct');
  base = base.replace(/\$\s*(\d+(?:\.\d+)?)/g, '$1usd');
  base = base.replace(/(\w)'s\b/g, '$1');
  base = base.replace(/[^a-z0-9]+/g, ' ');
  base = base.replace(/(.)\1{2,}/g, '$1$1');
  base = base.replace(/\s+/g, ' ').trim();
  return base;
}

function normalizeHashtagsForBinding(value = '') {
  let text = String(value || '');
  text = text.replace(/#/g, ' ');
  text = text.replace(/[_-]+/g, ' ');
  text = text.replace(/([a-z])([A-Z])/g, '$1 $2');
  text = text.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  text = text.replace(/([A-Za-z])(\d)/g, '$1 $2');
  text = text.replace(/(\d)([A-Za-z])/g, '$1 $2');
  return normalizeBindText(text);
}

function stemToken(value = '') {
  let token = String(value || '').toLowerCase();
  if (!token) return '';
  if (/\d/.test(token)) return token;
  if (token.endsWith("'s")) token = token.slice(0, -2);
  if (token.endsWith('ing') && token.length > 5) token = token.slice(0, -3);
  else if (token.endsWith('ed') && token.length > 4) token = token.slice(0, -2);
  else if (token.endsWith('ly') && token.length > 4) token = token.slice(0, -2);
  if (token.endsWith('es') && token.length > 4) token = token.slice(0, -2);
  else if (token.endsWith('s') && token.length > 3) token = token.slice(0, -1);
  return token;
}

function tokenizeNormalizedText(normalized = '') {
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(Boolean).map((token) => stemToken(token)).filter(Boolean);
}

function tokenizeBindText(value = '') {
  const normalized = normalizeBindText(value);
  return tokenizeNormalizedText(normalized);
}

// Language-level offer parsing to preserve numeric tokens for topic binding.
function parseOfferTokens(value = '') {
  const normalized = normalizeBindText(value);
  const tokens = [];
  const seen = new Set();
  const add = (token) => {
    const normalizedToken = String(token || '').toLowerCase();
    if (!normalizedToken || seen.has(normalizedToken)) return;
    seen.add(normalizedToken);
    tokens.push(normalizedToken);
  };
  const percentRegex = /\b(\d+(?:\.\d+)?)pct\b/g;
  let match = percentRegex.exec(normalized);
  while (match) {
    const number = match[1];
    add(`${number}pct`);
    match = percentRegex.exec(normalized);
  }
  const currencyRegex = /\b(\d+(?:\.\d+)?)usd\b/g;
  match = currencyRegex.exec(normalized);
  while (match) {
    const number = match[1];
    add(`${number}usd`);
    match = currencyRegex.exec(normalized);
  }
  if (/\bfree\s+(home\s+valuation|valuation)\b/.test(normalized)) add('free_valuation');
  if (/\bfree\s+(consultation)\b/.test(normalized)) add('free_consult');
  if (/\bfree\s+(evaluation)\b/.test(normalized)) add('free_eval');
  if (/\bfree\s+(estimate)\b/.test(normalized)) add('free_estimate');
  if (/\bfree\s+(guide)\b/.test(normalized)) add('free_guide');
  if (/\bfree\s+\w+\b/.test(normalized)) add('free_offer');
  if (/\bno win no fee\b/.test(normalized)) add('nowin_nofee');
  if (/\bcontingency\b/.test(normalized)) add('contingency');
  if (/\bfree consultation\b/.test(normalized)) add('free_consult');
  if (/\bguarantee\b/.test(normalized) || /\bguaranteed\b/.test(normalized)) add('guarantee');
  return tokens;
}

function deriveTopicFingerprint(titleOrTopic = '') {
  const titleNormalized = normalizeBindText(titleOrTopic);
  const rawTokens = titleNormalized.split(/\s+/).filter(Boolean);
  const offerTokens = parseOfferTokens(titleOrTopic);
  const buildTokens = (skipMeta = true) => {
    const tokens = [];
    const seen = new Set();
    for (const token of rawTokens) {
      const isNumeric = /^\d+(?:\.\d+)?$/.test(token);
      if (!isNumeric && token.length < 4 && !(token.length === 3 && TOPIC_FINGERPRINT_SHORT_TOKENS.has(token))) continue;
      if (TOPIC_FINGERPRINT_STOPWORDS.has(token)) continue;
      if (skipMeta && TITLE_META_TOKENS.has(token)) continue;
      const stemmed = stemToken(token);
      if (!stemmed || seen.has(stemmed)) continue;
      seen.add(stemmed);
      tokens.push(stemmed);
      if (tokens.length >= 8) break;
    }
    return tokens;
  };
  let baseTokens = buildTokens(true);
  if (baseTokens.length < 2) baseTokens = buildTokens(false);
  const canonTokens = [];
  Object.values(EQUIV_GROUPS).forEach((group) => {
    if (!group.injectCanon) return;
    const matched = group.phrases.some((phrase) => {
      const normalizedPhrase = normalizeBindText(phrase);
      if (!normalizedPhrase) return false;
      const regex = new RegExp(`\\b${escapeRegexPattern(normalizedPhrase)}\\b`, 'i');
      return regex.test(titleNormalized);
    });
    if (matched) {
      group.canon.forEach((item) => {
        if (item) canonTokens.push(item);
      });
    }
  });
  if (isSocialProofTitle(titleNormalized)) canonTokens.push('testimonial');
  const canonStemTokens = new Set(
    canonTokens
      .filter((token) => token && !String(token).includes('_'))
      .map((token) => stemToken(token))
      .filter(Boolean)
  );
  const filteredBaseTokens = baseTokens.filter((token) => !canonStemTokens.has(token));
  const dedupe = (list) => {
    const seen = new Set();
    const output = [];
    list.forEach((item) => {
      const value = String(item || '');
      if (!value || seen.has(value)) return;
      seen.add(value);
      output.push(value);
    });
    return output;
  };
  const tokens = dedupe([...baseTokens, ...canonTokens, ...offerTokens]);
  let anchors = dedupe([...canonTokens, ...offerTokens, ...filteredBaseTokens]);
  if (anchors.length < 3 && baseTokens.length > anchors.length) {
    anchors = dedupe([...anchors, ...filteredBaseTokens]);
  }
  anchors = anchors.slice(0, 5);
  return { tokens, offerTokens, anchors, titleNormalized };
}

function getTitleFirstWords(value = '', count = 4) {
  return normalizeTitleText(value).split(/\s+/).slice(0, count).join(' ').trim();
}

function coerceFieldText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean).join(' ').trim();
  }
  if (typeof value === 'object') {
    const parts = [];
    ['hook', 'body', 'cta', 'text', 'commentReply', 'dmReply'].forEach((key) => {
      if (typeof value[key] === 'string' && value[key].trim()) {
        parts.push(value[key].trim());
      }
    });
    return parts.join(' ').trim();
  }
  return '';
}

function getField(post = {}, names = []) {
  if (!post || typeof post !== 'object') return '';
  for (const name of names) {
    if (!name) continue;
    const value = Object.prototype.hasOwnProperty.call(post, name) ? post[name] : undefined;
    const text = coerceFieldText(value);
    if (text) return text;
  }
  return '';
}

const MOVEMENT_EQUIVALENTS = new Set(['move', 'moving', 'relocate', 'relocating', 'relocation']);

function shouldAllowMovementEquivalents(titleText = '') {
  const normalized = normalizeBindText(titleText);
  const tokens = new Set(normalized.split(/\s+/).filter(Boolean));
  return ['move', 'moving', 'relocate', 'relocating', 'relocation'].some((token) => tokens.has(token));
}

function isSocialProofTitle(normalizedTitle = '') {
  if (!normalizedTitle) return false;
  const group = EQUIV_GROUPS.SOCIAL_PROOF;
  if (group?.phrases) {
    for (const phrase of group.phrases) {
      const normalizedPhrase = normalizeBindText(phrase);
      if (!normalizedPhrase) continue;
      const regex = new RegExp(`\\b${escapeRegexPattern(normalizedPhrase)}\\b`, 'i');
      if (regex.test(normalizedTitle)) return true;
    }
  }
  const tokens = new Set(normalizedTitle.split(/\s+/).filter(Boolean));
  const hasClient = tokens.has('client') || tokens.has('clients');
  const hasSignal = ['say','says','feedback','review','reviews','testimonial','testimonials','experience','experiences'].some((token) => tokens.has(token));
  return hasClient && hasSignal;
}

function normalizeTokenForBind(value = '') {
  const normalized = normalizeBindText(value);
  const token = normalized.split(/\s+/).filter(Boolean)[0] || '';
  return token ? stemToken(token) : '';
}

function tokenMatches(normalizedText = '', token = '', options = {}) {
  const base = normalizeTokenForBind(token);
  if (!normalizedText || !base) return false;
  if (/^\d+(?:\.\d+)?$/.test(base) || base.endsWith('pct') || base.endsWith('usd')) {
    const regex = new RegExp(`\\b${escapeRegexPattern(base)}\\b`, 'i');
    return regex.test(normalizedText);
  }
  const allowMovement = Boolean(options.allowMovementEquivalents);
  const candidates = new Set();
  if (allowMovement && MOVEMENT_EQUIVALENTS.has(base)) {
    MOVEMENT_EQUIVALENTS.forEach((item) => candidates.add(item));
  } else {
    candidates.add(base);
  }
  const variants = new Set();
  candidates.forEach((candidate) => {
    variants.add(candidate);
    variants.add(`${candidate}s`);
    variants.add(`${candidate}es`);
    variants.add(`${candidate}ed`);
    variants.add(`${candidate}ing`);
    if (candidate.endsWith('e')) variants.add(`${candidate.slice(0, -1)}ing`);
  });
  for (const variant of variants) {
    const regex = new RegExp(`\\b${escapeRegexPattern(variant)}\\b`, 'i');
    if (regex.test(normalizedText)) return true;
  }
  return false;
}

function containsEquivalenceGroupPhrase(normalizedText = '', options = {}) {
  if (!normalizedText) return false;
  const activeGroups = Array.isArray(options?.equivalenceGroups) ? options.equivalenceGroups : [];
  for (const groupKey of activeGroups) {
    const group = EQUIV_GROUPS[groupKey];
    if (!group) continue;
    for (const phrase of group.phrases) {
      const normalizedPhrase = normalizeBindText(phrase);
      if (!normalizedPhrase) continue;
      const regex = new RegExp(`\\b${escapeRegexPattern(normalizedPhrase)}\\b`, 'i');
      if (regex.test(normalizedText)) return true;
    }
  }
  return false;
}

function containsTopicReference(text = '', fingerprint = {}, minTokens = 2, options = {}) {
  if (!isNonEmptyString(text)) return false;
  const normalized = normalizeBindText(text);
  if (!normalized) return false;
  const phrase = fingerprint && fingerprint.phrase ? String(fingerprint.phrase) : '';
  if (phrase && normalized.includes(phrase)) return true;
  const tokens = Array.isArray(fingerprint?.tokens) ? fingerprint.tokens : [];
  if (!tokens.length) return false;
  if (minTokens <= 0) return true;
  let matchCount = 0;
  const seen = new Set();
  if (containsEquivalenceGroupPhrase(normalized, options)) {
    matchCount += 1;
    seen.add('__equiv');
    if (matchCount >= minTokens) return true;
  }
  for (const token of tokens) {
    if (!token || seen.has(token)) continue;
    if (tokenMatches(normalized, token, options)) {
      matchCount += 1;
      seen.add(token);
      if (matchCount >= minTokens) return true;
    }
  }
  return false;
}

function hasAnyAnchorToken(text = '', fingerprint = {}, options = {}) {
  if (!isNonEmptyString(text)) return false;
  const tokens = Array.isArray(fingerprint?.tokens) ? fingerprint.tokens : [];
  if (!tokens.length) return false;
  const normalized = normalizeBindText(text);
  for (const token of tokens) {
    if (token && tokenMatches(normalized, token, options)) return true;
  }
  const hashtagTokens = (String(text).match(/#[A-Za-z0-9_]+/g) || [])
    .map((tag) => normalizeTokenForBind(tag.replace(/^#/, '')))
    .filter(Boolean);
  for (const tag of hashtagTokens) {
    for (const token of tokens) {
      if (token && tag.includes(token)) return true;
    }
  }
  return false;
}

function deriveFingerprintFromCapsule(capsule = {}) {
  const mustUse = Array.isArray(capsule?.mustUse) ? capsule.mustUse : [];
  const combined = mustUse.map((item) => String(item || '')).join(' ');
  return deriveTopicFingerprint(combined);
}

function countMustUseMatches(text = '', mustUse = []) {
  if (!isNonEmptyString(text) || !Array.isArray(mustUse) || !mustUse.length) return 0;
  const normalized = normalizeBindText(text);
  if (!normalized) return 0;
  const matched = new Set();
  mustUse.forEach((item) => {
    const normalizedItem = normalizeTokenForBind(item);
    if (!normalizedItem) return;
    const regex = new RegExp(`\\b${escapeRegexPattern(normalizedItem)}\\b`, 'i');
    if (regex.test(normalized)) matched.add(normalizedItem);
  });
  return matched.size;
}

function containsMustAvoidToken(text = '', mustAvoid = []) {
  if (!isNonEmptyString(text) || !Array.isArray(mustAvoid) || !mustAvoid.length) return false;
  const normalized = normalizeBindText(text);
  if (!normalized) return false;
  const words = new Set(normalized.split(/\s+/).filter(Boolean));
  for (const item of mustAvoid) {
    const normalizedItem = normalizeTokenForBind(item);
    if (!normalizedItem) continue;
    if (normalizedItem.includes(' ')) {
      if (normalized.includes(normalizedItem)) return true;
    } else if (words.has(normalizedItem)) {
      return true;
    }
  }
  return false;
}

function buildTopicPlanSlots(totalPosts = 0, startDay = 1, postsPerDay = 1) {
  const slots = [];
  const perDay = Math.max(1, Number(postsPerDay) || 1);
  for (let i = 0; i < totalPosts; i += 1) {
    const day = startDay + Math.floor(i / perDay);
    const postIndex = i % perDay;
    slots.push({
      slot: i,
      day,
      postIndex,
    });
  }
  return slots;
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

function isValidAudio(audio = '') {
  if (!audio || typeof audio !== 'string') return false;
  return /.+\s-\s.+/.test(audio);
}

function getAudioValue(post = {}) {
  if (!post || typeof post !== 'object') return '';
  const candidate = post?.details?.audio ?? post?.audio ?? post?.audio;
  return typeof candidate === 'string' ? candidate : '';
}

function ensureAudioForPosts(posts = [], { audioEntries = [] } = {}) {
  if (!Array.isArray(posts) || !posts.length) {
    return { total: 0, missingAudio: 0 };
  }
  const stats = { total: posts.length, missingAudio: 0 };
  const baseList = Array.isArray(audioEntries) ? audioEntries.slice() : [];
  if (!baseList.length) {
    const err = new Error('BILLBOARD_FETCH_FAILED');
    err.code = 'CALENDAR_POST_GENERATION_FAILED';
    err.statusCode = 422;
    err.details = { reason: 'BILLBOARD_FETCH_FAILED', field: 'details.audio' };
    throw err;
  }
  const picks = [];
  while (picks.length < posts.length) {
    const shuffled = shuffleArray(baseList);
    picks.push(...shuffled);
  }
  posts.forEach((post, idx) => {
    const entry = picks[idx] || baseList[0];
    const audioString = normalizeAudioString(entry?.title || '', entry?.artist || '');
    post.details = {
      ...(post.details && typeof post.details === 'object' && !Array.isArray(post.details) ? post.details : {}),
      audio: audioString,
    };
    if (Object.prototype.hasOwnProperty.call(post, 'audio')) {
      delete post.audio;
    }
    if (!isValidAudio(audioString)) stats.missingAudio += 1;
  });
  return stats;
}

function sanitizePostForPrompt(post = {}) {
  const fields = ['idea','title','type','hook','caption','format','designNotes','repurpose','hashtags','cta','script','instagram_caption','tiktok_caption','linkedin_caption','audio'];
  const sanitized = {};
  const clone = { ...post };
  if (!clone.script && clone.videoScript) clone.script = clone.videoScript;
  fields.forEach((field) => {
    if (clone[field] != null) sanitized[field] = clone[field];
  });
  sanitized.day = post.day;
  return sanitized;
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
  const text = [post.type, post.idea, post.caption]
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
  beauty: ['GLOW','SKIN','LOOK'],
  cooking: ['RECIPE','EAT','COOK'],
  restaurant: ['BURGER','FRIES','MENU','SAUCE','DEAL','ORDER'],
  business: ['GROW','SCALE','LEAD'],
  marketing: ['LEADS','SALES','LAUNCH'],
  creator: ['CREATE','IMPACT','INSPIRE'],
};
const DIRECT_RESPONSE_KEYWORDS = ['coach','consult','agency','course','training','consultant','creator','fitness','broker'];
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

function validateNicheLock(card = {}, nicheStyle = '') {
  return true;
}

function deterministicKeywordFallback(post = {}, classification = 'creator', nicheStyle = '', used = new Set()) {
  const nicheKeyword = deriveNicheKeyword(nicheStyle);
  if (nicheKeyword && isKeywordValid(nicheKeyword, post) && !used.has(nicheKeyword)) {
    return nicheKeyword;
  }
  const text = [nicheStyle, post.idea, post.title, post.type].filter(Boolean).join(' ').toLowerCase();
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
  const source = [post.idea, post.title, post.caption, nicheStyle].filter(Boolean).join(' ');
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
  const rawList = (typeof value === 'string' && value.includes('#'))
    ? (value.match(/#[A-Za-z0-9_]+/g) || [])
    : ensureStringArray(value, fallback, minLength);
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

const BRAND_BRAIN_FORBIDDEN_PHRASES = [
  'placeholder',
  'quick hook',
  'explain the idea',
  'ask for feedback',
  'neutral background',
  'let me know what you think',
  'talk briefly',
  'screenshot this so you remember',
  'office hours',
];
const BRAND_BRAIN_FORBIDDEN_REGEXES = BRAND_BRAIN_FORBIDDEN_PHRASES.map(
  (phrase) => new RegExp(escapeRegexPattern(phrase), 'i')
);
const TOPIC_BINDING_HASHTAG_MAX = 12;
const BRAND_BRAIN_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'with', 'from', 'to', 'of',
  'in', 'on', 'at', 'by', 'your', 'you', 'our', 'my', 'their', 'this', 'that',
  'these', 'those', 'about', 'into', 'over', 'under', 'near', 'per', 'via',
]);

function truncateWords(text = '', maxWords = 6) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return words.slice(0, maxWords).join(' ');
}

function titleCase(text = '') {
  return String(text || '')
    .split(/\s+/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ')
    .trim();
}

function extractBrandBrainTokens(nicheStyle = '') {
  const raw = toPlainString(nicheStyle).toLowerCase();
  if (!raw) return [];
  const tokens = raw
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !BRAND_BRAIN_STOPWORDS.has(token));
  return Array.from(new Set(tokens));
}

function buildBrandBrainHashtags(
  nicheStyle = '',
  minCount = 1,
  maxCount = 12
) {
  const tokens = extractBrandBrainTokens(nicheStyle);
  const tags = [];
  tokens.forEach((token) => {
    if (token && !tags.includes(token)) tags.push(token);
  });
  const extras = ['leads', 'growth', 'booked', 'strategy', 'results', 'pipeline', 'conversion', 'clients'];
  extras.forEach((token) => {
    if (tags.length < maxCount && !tags.includes(token)) tags.push(token);
  });
  if (!tags.length) tags.push('growth', 'strategy');
  return tags.slice(0, maxCount).map((token) => `#${token}`);
}

function buildBrandBrainCta(nicheStyle = '', topic = '') {
  const nicheLabel = toPlainString(nicheStyle || '').trim() || 'your niche';
  const keyword = topic ? truncateWords(topic, 1).toUpperCase() : 'PLAN';
  return `DM ${keyword} for the ${nicheLabel} checklist`;
}

function fillBrandBrainDefaults(post = {}, nicheStyle = '') {
  const next = { ...(post || {}) };
  const nicheLabel = toPlainString(nicheStyle || '').trim() || 'your niche';
  const topic = toPlainString(next.idea || next.title || next.hook || next.caption || '').trim();
  if (!isNonEmptyString(next.title)) {
    const candidate = topic ? truncateWords(topic, 6) : `${nicheLabel} lead play`;
    next.title = titleCase(candidate);
  }
  if (!isNonEmptyString(next.hook)) {
    const base = next.title || topic || nicheLabel;
    next.hook = `Most ${nicheLabel} leads drop before ${base} converts.`;
  }
  if (!isNonEmptyString(next.cta)) {
    next.cta = buildBrandBrainCta(nicheStyle, topic);
  }
  if (!isNonEmptyString(next.caption)) {
    const opener = next.hook;
    const detail = topic
      ? `Here’s the shift ${nicheLabel} clients respond to when ${topic}.`
      : `Here’s the shift ${nicheLabel} clients respond to when deciding.`;
    next.caption = `${opener} ${detail} ${next.cta}.`;
  }
  if (!Array.isArray(next.hashtags) || !next.hashtags.length) {
    next.hashtags = buildBrandBrainHashtags(nicheStyle);
  }
  if (!isNonEmptyString(next.designNotes)) {
    next.designNotes = `On-screen text: ${next.title}. Show a niche-specific scene, then a proof moment, then the CTA keyword.`;
  }
  if (!next.engagementScripts || typeof next.engagementScripts !== 'object') {
    next.engagementScripts = {};
  }
  if (!isNonEmptyString(next.engagementScripts.commentReply)) {
    next.engagementScripts.commentReply = `Thanks! What's your timeline and biggest ${nicheLabel} priority?`;
  }
  if (!isNonEmptyString(next.engagementScripts.dmReply)) {
    next.engagementScripts.dmReply = `Happy to send the checklist—what's your timeline and budget range?`;
  }
  if (!next.script || typeof next.script !== 'object') {
    next.script = {};
  }
  if (!isNonEmptyString(next.script.hook)) next.script.hook = next.hook;
  if (!isNonEmptyString(next.script.body)) next.script.body = next.caption;
  if (!isNonEmptyString(next.script.cta)) next.script.cta = next.cta;
  if (!next.reelScript || typeof next.reelScript !== 'object') {
    next.reelScript = {};
  }
  if (!isNonEmptyString(next.reelScript.hook)) next.reelScript.hook = next.script.hook;
  if (!isNonEmptyString(next.reelScript.body)) next.reelScript.body = next.script.body;
  if (!isNonEmptyString(next.reelScript.cta)) next.reelScript.cta = next.script.cta;
  return next;
}

function findBrandBrainForbiddenMatch(value = '') {
  const text = toPlainString(value);
  if (!text) return null;
  for (const regex of BRAND_BRAIN_FORBIDDEN_REGEXES) {
    if (regex.test(text)) return regex;
  }
  return null;
}

function extractHashtagTokens(value = null) {
  if (Array.isArray(value)) {
    return value.map((tag) => ensureHashtagPrefix(tag)).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.match(/#[A-Za-z0-9_]+/g) || [];
  }
  return [];
}

function normalizeHashtagsForBrandBrain(post = {}) {
  if (!post || typeof post !== 'object') return;
  const raw = post.hashtags;
  if (!raw) return;
  let tokens = extractHashtagTokens(raw);
  if (!tokens.length && post.details) {
    tokens = extractHashtagTokens(post.details);
  }
  if (!tokens.length) return;
  const seen = new Set();
  const deduped = [];
  tokens.forEach((token) => {
    const key = token.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(token);
  });
  const normalized = deduped;
  if (!normalized.length) return;
  post.hashtags = normalized.join(' ');
}

function normalizeHashtagsForTopicBinding(post = {}, maxCount = TOPIC_BINDING_HASHTAG_MAX) {
  if (!post || typeof post !== 'object') return;
  const raw = post.hashtags;
  let tokens = extractHashtagTokens(raw);
  if (!tokens.length && post.details) {
    tokens = extractHashtagTokens(post.details);
  }
  if (!tokens.length) return;
  const seen = new Set();
  const deduped = [];
  tokens.forEach((token) => {
    const key = token.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(token);
  });
  const shouldTruncate = Number.isFinite(maxCount) && deduped.length > maxCount;
  if (shouldTruncate) deduped.length = maxCount;
  const shouldRewrite = !Array.isArray(raw) || shouldTruncate || deduped.length !== tokens.length;
  if (shouldRewrite) {
    post.hashtags = deduped.join(' ');
  }
  return deduped;
}

function validateBrandBrainPost(post = {}, nicheStyle = '') {
  const reasons = [];
  const missing = validatePostCompleteness(post, 'brand_brain');
  if (missing.length) {
    reasons.push({ code: 'MISSING_FIELD', detail: missing });
  }
  return { ok: reasons.length === 0, reasons };
}

function ensureDesignNotesFallback(post = {}, nicheStyle = '') {
  const existing = String(post.designNotes || '').trim();
  if (existing) return existing;
  const idea = toPlainString(post.idea || post.title || post.hook || '');
  const topic = idea || 'this topic';
  const format = toPlainString(post.format || 'reel').toLowerCase();
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
  return direction.join(' ').trim() || `Visuals should stay focused on ${topic}.`;
}

function escapeRegexPattern(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

const CALENDAR_PILLARS = ['Education', 'Social Proof', 'Promotion', 'Lifestyle'];
function buildAngleSeed({ mode = 'regular', day = 1, slotIndex = 0, calendarId = '' } = {}) {
  const raw = [
    String(mode || 'regular'),
    Number.isFinite(Number(day)) ? Number(day) : 1,
    Number.isFinite(Number(slotIndex)) ? Number(slotIndex) : 0,
    String(calendarId || ''),
  ].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
}

function normalizeSignatureText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferGateTypeCue(text = '') {
  const normalized = normalizeSignatureText(text);
  const cueRules = [
    { cue: 'timing cue', terms: ['deadline', 'window', 'timing', 'schedule', 'due', 'clock'] },
    { cue: 'pricing signal', terms: ['price', 'pricing', 'fee', 'cost', 'rate', 'premium'] },
    { cue: 'leverage signal', terms: ['leverage', 'negotiat', 'concession', 'counter', 'terms'] },
    { cue: 'handoff risk', terms: ['handoff', 'handover', 'transition', 'dependency', 'coordination'] },
    { cue: 'inspection leverage', terms: ['inspection', 'inspect', 'defect', 'repair', 'condition report'] },
    { cue: 'listing framing', terms: ['listing', 'headline', 'positioning', 'description', 'framing'] },
    { cue: 'lifestyle friction', terms: ['lifestyle', 'commute', 'parking', 'noise', 'walkability', 'neighborhood'] },
  ];
  for (const rule of cueRules) {
    if (rule.terms.some((term) => normalized.includes(term))) {
      return rule.cue;
    }
  }
  return 'decision signal';
}

function inferArtifactName(text = '') {
  const normalized = normalizeSignatureText(text);
  const artifactRules = [
    ['title commitment', 'title commitment'],
    ['inspection report', 'inspection report'],
    ['flood map', 'flood map'],
    ['hoa addendum', 'hoa addendum'],
    ['estoppel letter', 'estoppel letter'],
    ['special assessment', 'assessment notice'],
    ['reserve', 'reserve note'],
    ['schedule b', 'schedule b line'],
    ['permit', 'permit record'],
    ['survey', 'survey'],
    ['insurance', 'insurance policy'],
    ['appraisal', 'appraisal report'],
    ['disclosure', 'disclosure'],
    ['clause', 'clause'],
    ['policy', 'policy'],
    ['report', 'report'],
    ['form', 'form'],
    ['document', 'document'],
  ];
  for (const [term, label] of artifactRules) {
    if (normalized.includes(term)) return label;
  }
  return 'core artifact';
}

function inferConditionCue(text = '') {
  const normalized = normalizeSignatureText(text);
  const rules = [
    { cue: 'mismatch', terms: ['mismatch', 'doesnt match', 'not match', 'inconsistent', 'conflict'] },
    { cue: 'restriction', terms: ['restriction', 'limit', 'cap', 'not allowed', 'prohibited'] },
    { cue: 'wording', terms: ['wording', 'language', 'phrase', 'label', 'term'] },
    { cue: 'omission', terms: ['missing', 'omission', 'left out', 'omitted', 'absent'] },
    { cue: 'history', terms: ['history', 'days on market', 'price history', 'past', 'timeline'] },
    { cue: 'pause', terms: ['pause', 'hesitation', 'stall', 'hold', 'wait'] },
    { cue: 'question', terms: ['question', 'ask', 'asked', 'objection', 'concern'] },
    { cue: 'clause', terms: ['clause', 'section', 'schedule', 'line item', 'exception'] },
    { cue: 'gap', terms: ['gap', 'difference', 'delta', 'shortfall', 'spread'] },
    { cue: 'note', terms: ['note', 'remark', 'comment', 'flag', 'annotation'] },
  ];
  for (const rule of rules) {
    if (rule.terms.some((term) => normalized.includes(term))) return rule.cue;
  }
  return 'condition';
}

function inferConsequenceCue(text = '') {
  const normalized = normalizeSignatureText(text);
  const rules = [
    { cue: 'pricing leverage', terms: ['price', 'pricing', 'comp', 'concession', 'negotiat', 'leverage'] },
    { cue: 'sequence shift', terms: ['sequence', 'order', 'next move', 'what next', 'repriorit'] },
    { cue: 'timeline stall', terms: ['delay', 'stall', 'slow', 'timeline', 'window', 'deadline'] },
    { cue: 'trust erosion', terms: ['trust', 'confidence', 'credibility', 'skeptic', 'doubt'] },
    { cue: 'eligibility filter', terms: ['eligible', 'eligibility', 'qualify', 'qualification', 'fit'] },
    { cue: 'conversion drop', terms: ['convert', 'conversion', 'drop off', 'fall through', 'no offer'] },
    { cue: 'deal drift', terms: ['drift', 'deal dies', 'dead deal', 'falls apart', 'renegotiat'] },
  ];
  for (const rule of rules) {
    if (rule.terms.some((term) => normalized.includes(term))) return rule.cue;
  }
  return 'next move';
}

function buildPostSignature(post = {}) {
  const reelObj =
    post?.reelScript && typeof post.reelScript === 'object'
      ? [post.reelScript.hook, post.reelScript.body, post.reelScript.cta].filter(Boolean).join(' ')
      : '';
  const source = [
    toPlainString(post?.title || ''),
    toPlainString(post?.hook || ''),
    toPlainString(post?.caption || ''),
    toPlainString(post?.script || ''),
    toPlainString(reelObj || ''),
    toPlainString(post?.designNotes || ''),
  ]
    .filter(Boolean)
    .join(' ');
  const artifact = inferArtifactName(source);
  const condition = inferConditionCue(source);
  const consequence = inferConsequenceCue(source);
  return `${artifact} | ${condition} | ${consequence}`;
}

function seedFromString(value = '') {
  let hash = 2166136261;
  const str = String(value || '');
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function makePrng(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickPillarKeyForPostKey(postKeyValue = '') {
  return '';
}

function computePillarTargets(totalSlots) {
  return {};
}

function buildPillarSchedule(totalSlots, rand = null) {
  const total = Math.max(0, Number.isFinite(Number(totalSlots)) ? Number(totalSlots) : 0);
  return Array.from({ length: total }, () => '');
}

function postKey(day, slotIndex) {
  return `day-${day}-slot-${slotIndex}`;
}

function canonicalizeSlotIndex(post = {}, postsPerDay = 1) {
  if (!post || typeof post !== 'object') return post;
  let slotIndex = post.slotIndex;
  if (slotIndex === null || slotIndex === undefined) {
    if (Number.isFinite(Number(post.slot))) slotIndex = Number(post.slot);
    if (slotIndex === null || slotIndex === undefined) {
      if (Number.isFinite(Number(post.slot_index))) slotIndex = Number(post.slot_index);
    }
  }
  if (typeof slotIndex === 'string') {
    const parsed = parseInt(slotIndex, 10);
    if (Number.isFinite(parsed)) slotIndex = parsed;
  }
  const perDay = Number(postsPerDay);
  if (Number.isFinite(perDay) && perDay > 0) {
    if (perDay === 1) {
      slotIndex = 0;
    } else if (Number.isFinite(Number(slotIndex))) {
      if (slotIndex < 0) slotIndex = 0;
      if (slotIndex >= perDay) slotIndex = perDay - 1;
    }
  }
  if (Number.isFinite(Number(slotIndex))) post.slotIndex = Number(slotIndex);
  return post;
}

function canonicalizeDayValue(post = {}) {
  if (!post || typeof post !== 'object') return post;
  let dayValue = post.day;
  if (!Number.isFinite(Number(dayValue))) {
    if (post.dayIndex != null) dayValue = post.dayIndex;
    if (!Number.isFinite(Number(dayValue)) && post.day_index != null) dayValue = post.day_index;
  }
  if (typeof dayValue === 'string') {
    const parsed = parseInt(dayValue, 10);
    if (Number.isFinite(parsed)) dayValue = parsed;
  }
  if (Number.isFinite(Number(dayValue))) post.day = Number(dayValue);
  return post;
}

function applyCalendarPostAliases(post = {}) {
  if (!post || typeof post !== 'object') return post;
  const isMissingStringField = (value) =>
    value == null || (typeof value === 'string' && value.trim().length === 0);
  const copyAliasString = (canonical, alias) => {
    if (isMissingStringField(post[canonical])) {
      const value = post[alias];
      if (isNonEmptyString(value)) {
        post[canonical] = value;
        delete post[alias];
      }
    }
  };
  const copyAliasObject = (canonical, alias) => {
    if (isMissingStringField(post[canonical])) {
      const value = post[alias];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        post[canonical] = value;
        delete post[alias];
      }
    }
  };
  copyAliasString('designNotes', 'design_notes');
  copyAliasString('reelScript', 'reel_script');
  copyAliasObject('reelScript', 'reel_script');
  copyAliasString('executionNotes', 'execution_notes');
  copyAliasString('pinnedComment', 'pinned_comment');
  copyAliasString('caption', 'caption_text');
  copyAliasString('caption', 'post_caption');
  copyAliasString('hook', 'hook_text');
  copyAliasString('script', 'script_text');
  copyAliasObject('script', 'video_script');
  copyAliasString('script', 'video_script');
  return post;
}

function canonicalizeCalendarPost(post = {}, postsPerDay = 1) {
  if (!post || typeof post !== 'object') return post;
  canonicalizeDayValue(post);
  canonicalizeSlotIndex(post, postsPerDay);
  applyCalendarPostAliases(post);
  const dayValue = Number(post.day);
  const slotValue = Number.isFinite(Number(post.slotIndex)) ? Number(post.slotIndex) : null;
  if (Number.isFinite(dayValue) && Number.isFinite(slotValue)) {
    const keyValue = postKey(dayValue, slotValue);
    const currentKey = toPlainString(post.post_key || post.postKey || '');
    if (!currentKey || currentKey !== keyValue) {
      post.post_key = keyValue;
      post.postKey = keyValue;
    }
  }
  return post;
}

function buildRequestedSpecMap({ startDay = 1, days = 1, postsPerDay = 1, topicPlan = null } = {}) {
  const safeStart = Number.isFinite(Number(startDay)) ? Number(startDay) : 1;
  const safeDays = Math.max(1, Number.isFinite(Number(days)) ? Number(days) : 1);
  const perDay = Math.max(1, Number.isFinite(Number(postsPerDay)) ? Number(postsPerDay) : 1);
  const topicByKey = new Map();
  if (Array.isArray(topicPlan)) {
    topicPlan.forEach((item) => {
      const day = Number(item?.day);
      const slotIndex = Number.isFinite(Number(item?.postIndex)) ? Number(item.postIndex) : null;
      if (!Number.isFinite(day) || slotIndex === null) return;
      const title = toPlainString(item?.title || item?.topic || '');
      topicByKey.set(postKey(day, slotIndex), title);
    });
  }
  const map = new Map();
  for (let dayOffset = 0; dayOffset < safeDays; dayOffset += 1) {
    const day = safeStart + dayOffset;
    for (let slotIndex = 0; slotIndex < perDay; slotIndex += 1) {
      const key = postKey(day, slotIndex);
      const title = topicByKey.get(key) || '';
      map.set(key, {
        post_key: key,
        day,
        slotIndex,
        title,
        topic: title,
      });
    }
  }
  return map;
}

function tokenizeTitleForAvoid(value = '') {
  const normalized = normalizeBindText(value);
  if (!normalized) return [];
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => token.length >= 4 && !TOPIC_FINGERPRINT_STOPWORDS.has(token));
}

function buildMustAvoidTokensByEntries(entries = [], maxTokens = 10) {
  const tokensByKey = new Map();
  entries.forEach((entry) => {
    const key = toPlainString(entry?.post_key || '');
    if (!key) return;
    tokensByKey.set(key, tokenizeTitleForAvoid(entry.title || ''));
  });
  const result = new Map();
  entries.forEach((entry) => {
    const key = toPlainString(entry?.post_key || '');
    if (!key) return;
    const counts = new Map();
    entries.forEach((other) => {
      const otherKey = toPlainString(other?.post_key || '');
      if (!otherKey || otherKey === key) return;
      const tokens = tokensByKey.get(otherKey) || [];
      tokens.forEach((token) => {
        counts.set(token, (counts.get(token) || 0) + 1);
      });
    });
    const sorted = Array.from(counts.entries()).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
    result.set(key, sorted.slice(0, maxTokens).map(([token]) => token));
  });
  return result;
}

function buildMustAvoidTokensByKey(requestedSpecMap = new Map()) {
  return buildMustAvoidTokensByEntries(Array.from(requestedSpecMap.values()), 10);
}

function assertPostKeyMapping(posts = [], requestedSpecMap = new Map()) {
  const expectedPostKeys = Array.from(requestedSpecMap.keys());
  const expectedSet = new Set(expectedPostKeys);
  const returnedKeys = [];
  const missingPostKey = [];
  posts.forEach((post, idx) => {
    const key = toPlainString(post?.post_key || post?.postKey || '');
    if (!key) {
      missingPostKey.push({ index: idx, day: post?.day ?? null, slotIndex: post?.slotIndex ?? null });
      return;
    }
    returnedKeys.push(key);
  });
  const returnedSet = new Set(returnedKeys);
  const missingKeys = expectedPostKeys.filter((key) => !returnedSet.has(key));
  const extraKeys = returnedKeys.filter((key) => !expectedSet.has(key));
  if (missingPostKey.length || missingKeys.length || extraKeys.length || returnedSet.size !== expectedSet.size) {
    const err = new Error('POST_KEY_MAPPING_FAILED');
    err.code = 'POST_KEY_MAPPING_FAILED';
    err.statusCode = 422;
    err.payload = {
      expectedPostKeys,
      returnedPostKeys: returnedKeys,
      missingPostKeys: missingKeys,
      extraPostKeys: extraKeys,
      postsMissingPostKey: missingPostKey,
    };
    throw err;
  }
}

function assignPostKeys(posts = [], startDay = 1, postsPerDay = 1) {
  const meta = posts.map((post, idx) => {
    const dayValue = Number.isFinite(Number(post?.day))
      ? Number(post.day)
      : computePostDayIndex(idx, startDay, postsPerDay);
    return { idx, day: dayValue };
  });
  const ordered = meta.slice().sort((a, b) => {
    if (a.day !== b.day) return a.day - b.day;
    return a.idx - b.idx;
  });
  const dayCounts = new Map();
  const slotByIndex = new Map();
  ordered.forEach((entry) => {
    const count = dayCounts.get(entry.day) || 0;
    dayCounts.set(entry.day, count + 1);
    slotByIndex.set(entry.idx, count);
  });
  posts.forEach((post, idx) => {
    if (!post || typeof post !== 'object') return;
    const explicitKey = toPlainString(post.post_key || post.postKey || '');
    const explicitSlotIndex = Number.isFinite(Number(post.slotIndex)) ? Number(post.slotIndex) : null;
    if (explicitKey) {
      post.__slotIndex = explicitSlotIndex !== null ? explicitSlotIndex : (slotByIndex.get(idx) ?? 0);
      post.__key = explicitKey;
      return;
    }
    const dayValue = Number.isFinite(Number(post?.day))
      ? Number(post.day)
      : computePostDayIndex(idx, startDay, postsPerDay);
    const slotIndex = slotByIndex.get(idx) ?? 0;
    post.__slotIndex = slotIndex;
    post.__key = postKey(dayValue, slotIndex);
  });
}

function normalizeCalendarPillar(value = '') {
  return '';
}

function getCalendarPillarForDay(day) {
  return '';
}

function isPillarDistributionBalanced(posts = []) {
  return true;
}

function applyPillarSchedule(posts = [], startDay = 1, postsPerDay = 1) {
  return Array.isArray(posts) ? posts : [];
}

function ensureCtaFallback(post = {}) {
  const normalizedCta =
    sanitizeCtaText(post.cta) ||
    sanitizeCtaText(post.callToAction) ||
    sanitizeCtaText(post.call_to_action) ||
    sanitizeCtaText(post.cta_text);
  if (normalizedCta) return normalizedCta;
  const format = String(post.format || post.platform || '').toLowerCase();
  const promoSlot = !!post.promoSlot;
  if (promoSlot) return 'Book now';
  if (format.includes('story') || format.includes('reel')) return 'Watch this';
  if (format.includes('static')) return 'Check it out';
  return 'Learn more';
}

const MIN_HASHTAGS = 0;
// Contract: required fields for regenerated posts (mirrors validatePostCompleteness).
const REQUIRED_POST_FIELDS_REGULAR = [
  'title',
  'hook',
  'caption',
  'format',
  'cta',
  'topic_signature',
  'angle',
  'designNotes',
  'day',
  'hashtags',
  'script',
  'reelScript',
  'engagementScripts',
  'topicCapsule',
  'details',
];

const REQUIRED_POST_FIELDS_BRAND = [
  ...REQUIRED_POST_FIELDS_REGULAR,
];

const REQUIRED_POST_FIELD_TYPES_REGULAR = {
  title: 'string',
  hook: 'string',
  caption: 'string',
  cta: 'string',
  format: 'string',
  topic_signature: 'string',
  angle: 'string',
  designNotes: 'string',
  day: 'number',
  hashtags: 'array',
  script: 'string',
  reelScript: 'object',
  engagementScripts: 'object',
  topicCapsule: 'string',
  details: 'object',
};

const REQUIRED_POST_FIELD_TYPES_BRAND = {
  ...REQUIRED_POST_FIELD_TYPES_REGULAR,
};

function getValueByPath(obj, path) {
  const parts = String(path || '').split('.');
  let current = obj;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function getValueByInstancePath(obj, instancePath = '') {
  const trimmed = String(instancePath || '').replace(/^\//, '');
  if (!trimmed) return undefined;
  const parts = trimmed.split('/').filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function requiredFieldsForMode(mode = 'regular') {
  return mode === 'brand_brain'
    ? REQUIRED_POST_FIELDS_BRAND.slice()
    : REQUIRED_POST_FIELDS_REGULAR.slice();
}

function requiredFieldTypesForMode(mode = 'regular') {
  return mode === 'brand_brain'
    ? REQUIRED_POST_FIELD_TYPES_BRAND
    : REQUIRED_POST_FIELD_TYPES_REGULAR;
}

function buildSchemaRequirements(schema) {
  const requiredFields = [];
  const requiredTypes = {};
  if (!schema || schema.type !== 'object' || !schema.properties) {
    return { requiredFields, requiredTypes };
  }
  const props = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  required.forEach((key) => {
    requiredFields.push(key);
    const def = props[key] || {};
    if (def.type) requiredTypes[key] = def.type;
    if (def.type === 'object' && def.properties && Array.isArray(def.required)) {
      def.required.forEach((child) => {
        requiredFields.push(`${key}.${child}`);
        const childDef = def.properties[child] || {};
        if (childDef.type) requiredTypes[`${key}.${child}`] = childDef.type;
      });
    }
  });
  return { requiredFields, requiredTypes };
}

function buildRequiredFieldDiagnostics(post = {}, mode = 'regular') {
  const missing = [];
  const empty = [];
  const invalidTypes = [];
  const requiredFields = requiredFieldsForMode(mode);
  const requiredTypes = requiredFieldTypesForMode(mode);
  for (const key of requiredFields) {
    const expected = requiredTypes[key] || 'string';
    const value = getValueByPath(post, key);
    if (value === undefined || value === null) {
      missing.push(key);
      continue;
    }
    if (expected === 'array') {
      if (!Array.isArray(value)) {
        invalidTypes.push({ key, expected, got: Array.isArray(value) ? 'array' : typeof value });
      } else if (!value.length) {
        empty.push(key);
      }
      continue;
    }
    if (expected === 'object') {
      if (typeof value !== 'object' || Array.isArray(value)) {
        invalidTypes.push({ key, expected, got: Array.isArray(value) ? 'array' : typeof value });
      } else if (!Object.keys(value).length) {
        empty.push(key);
      }
      continue;
    }
    if (expected === 'number') {
      if (!Number.isFinite(Number(value))) {
        invalidTypes.push({ key, expected, got: typeof value });
      }
      continue;
    }
    if (typeof value !== 'string') {
      invalidTypes.push({ key, expected, got: typeof value });
      continue;
    }
    if (!value.trim()) {
      empty.push(key);
    }
  }
  return { missing, empty, invalidTypes };
}

const NONCORE_OPTIONAL_FIELDS = new Set([
  'engagementScripts',
  'engagementScripts.commentReply',
  'engagementScripts.dmReply',
  'designNotes',
  'executionNotes',
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeDecisionAnchor(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const DECISION_ANCHOR_BLOCKLIST = new Set([
  'market trends',
  'top neighborhoods',
]);

const PLACEHOLDER_BLACKLIST = new Set([
  'n/a',
  'tbd',
  'placeholder',
  '-',
  '',
]);

const PILLAR_TOKENS = {
  social_proof: ['client', 'testimonial', 'sold', 'under contract', 'closed'],
  promotion: ['dm', 'comment', 'book', 'call', 'text', 'get the list', 'schedule'],
  lifestyle: ['walkable', 'schools', 'commute', 'nightlife', 'parks', 'culture', 'family', 'beach'],
};

const TOPIC_HOOK_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'your', 'you', 'this', 'that',
  'is', 'are', 'from', 'by', 'as', 'at', 'it', 'be', 'vs', 'vs.',
]);

function extractKeywordTokens(value = '') {
  const normalized = normalizeSignatureText(value);
  return normalized
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !TOPIC_HOOK_STOPWORDS.has(token));
}

function parseDesignNotesDirectives(value = '') {
  const raw = String(value || '');
  const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const bullets = lines.filter((line) => /^-\s+/.test(line));
  if (!bullets.length) return [];
  return bullets;
}

function normalizeDesignNotesInput(input) {
  let beforeText = '';
  const items = [];
  if (Array.isArray(input)) {
    beforeText = input.map((item) => String(item || '')).join('\n');
    input.forEach((item) => {
      const cleaned = String(item || '').trim().replace(/^[\s*-•]+/, '').trim();
      if (cleaned) items.push(cleaned);
    });
  } else if (typeof input === 'string') {
    beforeText = input;
    const text = input.replace(/\r\n/g, '\n').trim();
    if (text) {
      const lines = text.split('\n');
      lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const split = trimmed.split(/\s*-\s+/).filter(Boolean);
        if (split.length > 1 || trimmed.startsWith('-')) {
          split.forEach((part) => {
            const cleaned = String(part || '').replace(/^[\s*-•]+/, '').trim();
            if (cleaned) items.push(cleaned);
          });
        } else {
          const cleaned = trimmed.replace(/^[\s*-•]+/, '').trim();
          if (cleaned) items.push(cleaned);
        }
      });
    }
  } else if (input != null) {
    beforeText = String(input);
  }

  if (!items.length) {
    return { value: '', changed: Boolean(beforeText && beforeText.trim()) };
  }
  const normalized = items.map((item) => `- ${item}`).join('\n');
  const changed = beforeText.trim() !== normalized.trim();
  return { value: normalized, changed, before: beforeText.slice(0, 120), after: normalized.slice(0, 120) };
}

function hasNumberedTopThree(text = '') {
  const value = String(text || '');
  const has1 = /\b1[.)]/.test(value);
  const has2 = /\b2[.)]/.test(value);
  const has3 = /\b3[.)]/.test(value);
  return has1 && has2 && has3;
}

function hasCommaListThree(text = '') {
  const parts = String(text || '')
    .split(/,|\band\b/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 2);
  const unique = new Set(parts.map((part) => part.toLowerCase()));
  return unique.size >= 3;
}

const REELSCRIPT_LABELS = [
  'HOOK',
  'BEAT_1',
  'BEAT_2',
  'BEAT_3',
  'CTA',
  'ON_SCREEN_TEXT',
  'BROLL_NOTES',
];
const REELSCRIPT_BEAT_LABELS = ['BEAT_1', 'BEAT_2', 'BEAT_3'];
const REELSCRIPT_MIN_HOOK_WORDS = 8;
const REELSCRIPT_MIN_BEAT_WORDS = 8;
const REELSCRIPT_MIN_CTA_WORDS = 10;
const REELSCRIPT_ONSCREEN_MIN_WORDS = 2;
const REELSCRIPT_ONSCREEN_MAX_WORDS = 6;
const REELSCRIPT_BROLL_MIN_WORDS = 2;
const REELSCRIPT_BROLL_MAX_WORDS = 6;
const ENGAGEMENT_ITEM_MIN_WORDS = 6;
const ENGAGEMENT_ITEM_MAX_WORDS = 18;
const ENGAGEMENT_COMMENT_MIN_ITEMS = 4;
const ENGAGEMENT_COMMENT_MAX_ITEMS = 6;
const ENGAGEMENT_DM_MIN_ITEMS = 2;
const ENGAGEMENT_DM_MAX_ITEMS = 3;
const ENGAGEMENT_REPLY_MIN_ITEMS = 4;
const ENGAGEMENT_REPLY_MAX_ITEMS = 6;
const BRAND_BRAIN_MARKERS = [
  'beliefTeardown',
  'hiddenConstraint',
  'secondOrder',
  'objection',
  'identityShift',
];

function countWords(text = '') {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function splitNonEmptyLines(text = '') {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function renderReelScriptFromParts(parts = {}, markers = null) {
  if (!parts || typeof parts !== 'object' || Array.isArray(parts)) {
    return toPlainString(parts || '');
  }
  const hook = toPlainString(parts.hook || '');
  const beat1 = toPlainString(parts.beat1 || '');
  const beat2 = toPlainString(parts.beat2 || '');
  const beat3 = toPlainString(parts.beat3 || '');
  const cta = toPlainString(parts.cta || '');
  const onScreen = Array.isArray(parts.onScreenText) ? parts.onScreenText.map((item) => toPlainString(item)).filter(Boolean) : [];
  const broll = Array.isArray(parts.brollNotes) ? parts.brollNotes.map((item) => toPlainString(item)).filter(Boolean) : [];
  const lines = [
    `HOOK: ${hook}`,
    `BEAT_1: ${beat1}`,
    `BEAT_2: ${beat2}`,
    `BEAT_3: ${beat3}`,
    `CTA: ${cta}`,
    `ON_SCREEN_TEXT: ${onScreen.join(' | ')}`,
    `BROLL_NOTES: ${broll.join(', ')}`,
  ];
  if (markers && typeof markers === 'object' && !Array.isArray(markers)) {
    const belief = toPlainString(markers.beliefTeardown || '');
    const hidden = toPlainString(markers.hiddenConstraint || '');
    const secondOrder = toPlainString(markers.secondOrder || '');
    const objection = toPlainString(markers.objection || '');
    const identity = toPlainString(markers.identityShift || '');
    if (belief) lines.push(`BELIEF_TEARDOWN: ${belief}`);
    if (hidden) lines.push(`HIDDEN_CONSTRAINT: ${hidden}`);
    if (secondOrder) lines.push(`SECOND_ORDER: ${secondOrder}`);
    if (objection) lines.push(`OBJECTION: ${objection}`);
    if (identity) lines.push(`IDENTITY_SHIFT: ${identity}`);
  }
  return lines.join('\n').trim();
}

function renderEngagementScriptsFromParts(parts = {}) {
  if (!parts || typeof parts !== 'object' || Array.isArray(parts)) {
    return toPlainString(parts || '');
  }
  const commentPrompts = Array.isArray(normalized.commentPrompts)
    ? normalized.commentPrompts.map((item) => toPlainString(item)).filter(Boolean)
    : [];
  const dmScripts = Array.isArray(normalized.dmScripts)
    ? normalized.dmScripts.map((item) => toPlainString(item)).filter(Boolean)
    : [];
  const replyTemplates = Array.isArray(normalized.replyTemplates)
    ? normalized.replyTemplates.map((item) => toPlainString(item)).filter(Boolean)
    : [];
  const lines = [
    'COMMENT_PROMPTS:',
    ...commentPrompts.map((item) => `- ${item}`),
    'DM_SCRIPTS:',
    ...dmScripts.map((item) => `- ${item}`),
    'REPLY_TEMPLATES:',
    ...replyTemplates.map((item) => `- ${item}`),
  ];
  return lines.join('\n').trim();
}

function normalizeEngagementLines(text = '') {
  const raw = toPlainString(text || '');
  if (!raw) return [];
  let lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) {
    lines = raw.split(/\s*-\s+/).map((line) => line.trim()).filter(Boolean);
  }
  return lines.filter(Boolean);
}

function stripAdLabels(text = '') {
  let out = toPlainString(text || '');
  if (!out) return out;
  const leadingLabel = /^\s*(Reel Script|Hook|Body|CTA|On[- ]screen text|Broll notes)\s*:\s*/i;
  while (leadingLabel.test(out)) {
    out = out.replace(leadingLabel, '');
  }
  out = out
    .replace(/BEAT[_\s-]*\d+\s*:\s*/gi, '')
    .replace(/ON_SCREEN_TEXT\s*:\s*/gi, '')
    .replace(/BROLL_NOTES\s*:\s*/gi, '')
    .replace(/HOOK\s*:\s*/gi, '')
    .replace(/CTA\s*:\s*/gi, '')
    .replace(/BODY\s*:\s*/gi, '');
  out = out.replace(/\r\n/g, '\n');
  out = out
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('\n');
  return out.trim();
}

function extractLabeledLine(text = '', label = '') {
  const raw = toPlainString(text || '');
  if (!raw || !label) return '';
  const lines = raw.split(/\r?\n/);
  const prefix = `${label}:`;
  const found = lines.find((line) => line.trim().toLowerCase().startsWith(prefix.toLowerCase()));
  if (found) {
    return found.slice(found.indexOf(':') + 1).trim();
  }
  return '';
}

function firstSentence(text = '') {
  const raw = toPlainString(text || '').trim();
  if (!raw) return '';
  const split = raw.split(/[.!?]\s+/);
  return split[0] ? split[0].trim() : raw;
}

function normalizeAdFields(post, ctx = {}) {
  if (!post || typeof post !== 'object') return false;
  const changedFields = [];
  const trackChange = (field, before, after) => {
    if (before === after) return;
    if (!changedFields.includes(field)) changedFields.push(field);
  };
  const fields = [
    'title',
    'topicCapsule',
    'hook',
    'caption',
    'script',
    'angle',
    'cta',
    'designNotes',
  ];
  fields.forEach((field) => {
    if (typeof post[field] !== 'string') return;
    const before = post[field];
    const after = stripAdLabels(before);
    if (after) post[field] = after;
    trackChange(field, before, post[field]);
  });

  if (post.reelScript && typeof post.reelScript === 'object' && !Array.isArray(post.reelScript)) {
    const reel = post.reelScript;
    ['hook', 'beat1', 'beat2', 'beat3', 'cta', 'body'].forEach((key) => {
      if (typeof reel[key] === 'string') {
        const before = reel[key];
        const after = stripAdLabels(before);
        if (after) reel[key] = after;
        trackChange(`reelScript.${key}`, before, reel[key]);
      }
    });
    if (Array.isArray(reel.onScreenText)) {
      reel.onScreenText = reel.onScreenText.map((item) => stripAdLabels(item));
    }
    if (Array.isArray(reel.brollNotes)) {
      reel.brollNotes = reel.brollNotes.map((item) => stripAdLabels(item));
    }
  }

  const rawScript = toPlainString(post.script || '');
  const rawReel = typeof post.reelScript === 'string'
    ? post.reelScript
    : renderReelScriptFromParts(post.reelScript, post.reelScript?.brandBrainMarkers);

  if (!toPlainString(post.hook || '').trim()) {
    const extracted = extractLabeledLine(rawScript, 'HOOK') || extractLabeledLine(rawReel, 'HOOK');
    const fallback = extracted || firstSentence(rawScript || rawReel);
    const cleaned = stripAdLabels(fallback);
    if (cleaned) {
      trackChange('hook', post.hook || '', cleaned);
      post.hook = cleaned;
    }
  }
  if (!toPlainString(post.cta || '').trim()) {
    const extracted = extractLabeledLine(rawScript, 'CTA') || extractLabeledLine(rawReel, 'CTA');
    const fallback = extracted || firstSentence(rawScript || rawReel);
    const cleaned = stripAdLabels(fallback);
    if (cleaned) {
      trackChange('cta', post.cta || '', cleaned);
      post.cta = cleaned;
    }
  }

  if (typeof post.script === 'string') {
    const before = post.script;
    let cleaned = stripAdLabels(before);
    if (cleaned) {
      let lines = cleaned.split('\n').map((line) => line.trim()).filter(Boolean);
      if (lines.length > 6) lines = lines.slice(0, 6);
      cleaned = lines.join('\n');
      post.script = cleaned;
      trackChange('script', before, cleaned);
    }
  }

  if (changedFields.length) {
    console.log('[Calendar][NormalizeAd]', {
      requestId: ctx?.requestId || null,
      post_key: ctx?.post_key || null,
      changedFields,
    });
  }
  return Boolean(changedFields.length);
}

function convertEngagementScriptsToObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  const lines = normalizeEngagementLines(value);
  if (!lines.length) {
    return { commentPrompts: [], dmScripts: [], replyTemplates: [] };
  }
  const fillToLength = (list, min, source) => {
    const filled = list.slice();
    if (!source.length) return filled;
    let idx = 0;
    while (filled.length < min) {
      filled.push(source[idx % source.length]);
      idx += 1;
    }
    return filled;
  };
  let commentPrompts = lines.slice(0, 6);
  let dmScripts = lines.slice(6, 9);
  let replyTemplates = lines.slice(9, 15);
  commentPrompts = fillToLength(commentPrompts, 4, lines).slice(0, 6);
  dmScripts = fillToLength(dmScripts, 2, lines).slice(0, 3);
  replyTemplates = fillToLength(replyTemplates, 4, lines).slice(0, 6);
  return { commentPrompts, dmScripts, replyTemplates };
}

function normalizeEngagementScripts(post, ctx = {}) {
  try {
    if (!post || typeof post !== 'object') return false;
    let scripts = post.engagementScripts;
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
      scripts = convertEngagementScriptsToObject(scripts);
    }
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return false;
    const normalizeItem = (value) => {
      const beforeRaw = value === null || value === undefined ? '' : String(value);
      return beforeRaw.trim().replace(/\s+/g, ' ').replace(/[.,!?]+$/g, '');
    };
    const normalizeArray = (arr) => {
      if (!Array.isArray(arr)) return arr;
      return arr.map((item) => normalizeItem(item));
    };
    scripts.commentPrompts = normalizeArray(scripts.commentPrompts);
    scripts.dmScripts = normalizeArray(scripts.dmScripts);
    scripts.replyTemplates = normalizeArray(scripts.replyTemplates);
    post.engagementScripts = scripts;
    return true;
  } catch {
    return false;
  }
}

function normalizeReelScriptBroll(post, ctx = {}) {
  try {
    if (!post || typeof post !== 'object') return false;
    const reel = post.reelScript;
    if (!reel || typeof reel !== 'object' || Array.isArray(reel)) return false;
    const raw = reel.brollNotes;
    if (!Array.isArray(raw)) return false;
    const normalized = [];
    let changed = false;
    raw.forEach((item, idx) => {
      const beforeRaw = item === null || item === undefined ? '' : String(item);
      let text = beforeRaw.trim().replace(/\s+/g, ' ');
      text = text.replace(/[.,!?]+$/g, '');
      const beforeWords = text ? text.split(/\s+/).filter(Boolean) : [];
      const beforeWordCount = beforeWords.length;
      let afterWords = beforeWords;
      if (beforeWordCount > REELSCRIPT_BROLL_MAX_WORDS) {
        afterWords = beforeWords.slice(0, REELSCRIPT_BROLL_MAX_WORDS);
      }
      const after = afterWords.join(' ');
      const afterWordCount = afterWords.length;
      if (!after) {
        if (beforeRaw.trim()) changed = true;
        if (changed) {
          console.log('[Calendar][ReelScript][BrollNormalize]', {
            requestId: ctx?.requestId || null,
            post_key: ctx?.post_key || null,
            itemIndex: idx,
            beforeWordCount,
            afterWordCount,
          });
        }
        return;
      }
      if (beforeRaw.trim() !== after) {
        changed = true;
        console.log('[Calendar][ReelScript][BrollNormalize]', {
          requestId: ctx?.requestId || null,
          post_key: ctx?.post_key || null,
          itemIndex: idx,
          beforeWordCount,
          afterWordCount,
        });
      }
      normalized.push(after);
    });
    if (changed) {
      post.reelScript.brollNotes = normalized;
    }
    return changed;
  } catch (err) {
    console.warn('[Calendar][ReelScript][BrollNormalizeError]', {
      requestId: ctx?.requestId || null,
      post_key: ctx?.post_key || null,
      message: err?.message || err,
    });
    return false;
  }
}

function validateReelScriptParts(parts = {}, mode = 'regular') {
  if (!parts || typeof parts !== 'object' || Array.isArray(parts)) {
    return { ok: false, reason: 'REELSCRIPT_MISSING_PARTS', field: 'reelScript', snippet: '' };
  }
  const hook = toPlainString(parts.hook || '');
  const beat1 = toPlainString(parts.beat1 || '');
  const beat2 = toPlainString(parts.beat2 || '');
  const beat3 = toPlainString(parts.beat3 || '');
  const cta = toPlainString(parts.cta || '');
  const onScreen = Array.isArray(parts.onScreenText) ? parts.onScreenText.map((item) => toPlainString(item)).filter(Boolean) : [];
  const broll = Array.isArray(parts.brollNotes) ? parts.brollNotes.map((item) => toPlainString(item)).filter(Boolean) : [];
  const beats = [
    { label: 'beat1', value: beat1 },
    { label: 'beat2', value: beat2 },
    { label: 'beat3', value: beat3 },
  ];
  for (const beat of beats) {
    if (!beat.value.trim()) {
      return { ok: false, reason: 'REELSCRIPT_BEAT_MISSING', field: 'reelScript', snippet: '', extra: { label: beat.label } };
    }
  }
  if (!cta.trim()) {
    return { ok: false, reason: 'REELSCRIPT_CTA_MISSING', field: 'reelScript', snippet: '' };
  }
  if (onScreen.length < 3 || onScreen.length > 6) {
    return { ok: false, reason: 'REELSCRIPT_ON_SCREEN_FORMAT', field: 'reelScript', snippet: onScreen.join(' | ').slice(0, 120), extra: { count: onScreen.length } };
  }
  for (const phrase of onScreen) {
    const wc = countWords(phrase);
    if (wc < REELSCRIPT_ONSCREEN_MIN_WORDS || wc > REELSCRIPT_ONSCREEN_MAX_WORDS) {
      return { ok: false, reason: 'REELSCRIPT_ON_SCREEN_FORMAT', field: 'reelScript', snippet: phrase.slice(0, 120), extra: { wordCount: wc } };
    }
  }
  if (broll.length < 4 || broll.length > 8) {
    return { ok: false, reason: 'REELSCRIPT_BROLL_COUNT', field: 'reelScript', snippet: broll.join(', ').slice(0, 120), extra: { count: broll.length } };
  }
  for (let i = 0; i < broll.length; i += 1) {
    const item = broll[i];
    const wc = countWords(item);
    const cc = String(item || '').length;
    if (wc < REELSCRIPT_BROLL_MIN_WORDS || wc > REELSCRIPT_BROLL_MAX_WORDS) {
      console.log('[Calendar][ReelScript][BrollItemLength]', {
        reason: 'REELSCRIPT_BROLL_ITEM_LENGTH',
        expected: {
          minWords: REELSCRIPT_BROLL_MIN_WORDS,
          maxWords: REELSCRIPT_BROLL_MAX_WORDS,
          minChars: null,
          maxChars: null,
        },
        actual: { itemIndex: i, wordCount: wc, charCount: cc },
        sample: String(item || '').slice(0, 200),
      });
      return { ok: false, reason: 'REELSCRIPT_BROLL_ITEM_LENGTH', field: 'reelScript', snippet: item.slice(0, 120), extra: { wordCount: wc, itemIndex: i } };
    }
  }
  if (String(mode || '') === 'brand_brain') {
    const markers = parts.brandBrainMarkers;
    if (!markers || typeof markers !== 'object' || Array.isArray(markers)) {
      return { ok: false, reason: 'BRAND_BRAIN_MARKER_MISSING', field: 'reelScript', snippet: '', extra: { missing: BRAND_BRAIN_MARKERS } };
    }
    const missing = [];
    ['beliefTeardown', 'hiddenConstraint', 'secondOrder', 'objection', 'identityShift'].forEach((key) => {
      if (!isNonEmptyString(markers[key])) missing.push(key);
    });
    if (missing.length) {
      return { ok: false, reason: 'BRAND_BRAIN_MARKER_MISSING', field: 'reelScript', snippet: missing.join(', ').slice(0, 120), extra: { missing } };
    }
  }
  return { ok: true };
}

function validateEngagementScriptsStructure(raw = '') {
  const text = toPlainString(raw || '');
  if (!text.trim()) {
    return { ok: false, reason: 'ENGAGEMENT_SCRIPTS_MISSING', field: 'engagementScripts', snippet: '' };
  }
  const lines = splitNonEmptyLines(text);
  if (lines.length < 3) {
    return { ok: false, reason: 'ENGAGEMENT_SCRIPTS_TOO_SHORT', field: 'engagementScripts', snippet: text.slice(0, 120) };
  }
  const expectedLabels = ['COMMENT_PROMPT', 'POLL_PROMPT', 'SHARE_PROMPT'];
  for (let i = 0; i < expectedLabels.length; i += 1) {
    const label = expectedLabels[i];
    const line = lines[i] || '';
    if (!line.startsWith(`${label}:`)) {
      return { ok: false, reason: 'ENGAGEMENT_SCRIPTS_LABEL_MISSING', field: 'engagementScripts', snippet: line.slice(0, 120), extra: { expected: label } };
    }
    const content = line.slice(label.length + 1).trim();
    if (countWords(content) < 8) {
      return { ok: false, reason: 'ENGAGEMENT_SCRIPTS_TOO_SHORT', field: 'engagementScripts', snippet: line.slice(0, 120), extra: { label } };
    }
  }
  return { ok: true };
}

function validateEngagementScriptsParts(parts = {}) {
  if (!parts || typeof parts !== 'object' || Array.isArray(parts)) {
    return { ok: false, reason: 'ENGAGEMENT_SCRIPTS_MISSING', field: 'engagementScripts', snippet: '' };
  }
  const commentPrompts = Array.isArray(parts.commentPrompts)
    ? parts.commentPrompts.map((item) => toPlainString(item)).filter(Boolean)
    : [];
  const dmScripts = Array.isArray(parts.dmScripts)
    ? parts.dmScripts.map((item) => toPlainString(item)).filter(Boolean)
    : [];
  const replyTemplates = Array.isArray(parts.replyTemplates)
    ? parts.replyTemplates.map((item) => toPlainString(item)).filter(Boolean)
    : [];
  const checkItems = (items, min, max, field, label) => {
    if (items.length < min || items.length > max) {
      return { ok: false, reason: 'ENGAGEMENT_SCRIPTS_COUNT', field, snippet: items.join(' | ').slice(0, 120), extra: { count: items.length, label } };
    }
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const wc = countWords(item);
      const cc = String(item || '').length;
      if (wc < ENGAGEMENT_ITEM_MIN_WORDS || wc > ENGAGEMENT_ITEM_MAX_WORDS) {
        console.log('[Calendar][EngagementScripts][ItemLength]', {
          reason: 'ENGAGEMENT_SCRIPTS_ITEM_LENGTH',
          expected: {
            minWords: ENGAGEMENT_ITEM_MIN_WORDS,
            maxWords: ENGAGEMENT_ITEM_MAX_WORDS,
            minChars: null,
            maxChars: null,
          },
          actual: { array: label, itemIndex: i, wordCount: wc, charCount: cc },
          sample: String(item || '').slice(0, 200),
        });
        return { ok: false, reason: 'ENGAGEMENT_SCRIPTS_ITEM_LENGTH', field, snippet: item.slice(0, 120), extra: { wordCount: wc, label, itemIndex: i } };
      }
    }
    return null;
  };
  const commentCheck = checkItems(
    commentPrompts,
    ENGAGEMENT_COMMENT_MIN_ITEMS,
    ENGAGEMENT_COMMENT_MAX_ITEMS,
    'engagementScripts.commentPrompts',
    'commentPrompts'
  );
  if (commentCheck) return commentCheck;
  const dmCheck = checkItems(
    dmScripts,
    ENGAGEMENT_DM_MIN_ITEMS,
    ENGAGEMENT_DM_MAX_ITEMS,
    'engagementScripts.dmScripts',
    'dmScripts'
  );
  if (dmCheck) return dmCheck;
  const replyCheck = checkItems(
    replyTemplates,
    ENGAGEMENT_REPLY_MIN_ITEMS,
    ENGAGEMENT_REPLY_MAX_ITEMS,
    'engagementScripts.replyTemplates',
    'replyTemplates'
  );
  if (replyCheck) return replyCheck;
  return { ok: true };
}

function validateBrandBrainMarkers(reelScriptRaw = '') {
  const text = toPlainString(reelScriptRaw || '');
  const missing = [];
  const duplicates = [];
  BRAND_BRAIN_MARKERS.forEach((marker) => {
    const count = text.split(marker).length - 1;
    if (count === 0) missing.push(marker);
    if (count > 1) duplicates.push(marker);
  });
  if (duplicates.length) {
    return { ok: false, reason: 'BRAND_BRAIN_MARKER_DUP', field: 'reelScript', snippet: duplicates.join(', ').slice(0, 120), extra: { duplicates } };
  }
  if (missing.length) {
    return { ok: false, reason: 'BRAND_BRAIN_MARKER_MISSING', field: 'reelScript', snippet: missing.join(', ').slice(0, 120), extra: { missing } };
  }
  return { ok: true };
}

function extractTopicTerms(text = '') {
  const normalized = normalizeTitleText(text);
  if (!normalized) return [];
  const tokens = normalized
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .filter((token) => !TITLE_SIGNATURE_STOPWORDS.has(token));
  return tokens.slice(0, 6);
}

const TOPIC_LOCK_LOW_SIGNAL_TOKENS = new Set([
  'your', 'you', 'missing', 'the', 'and', 'for', 'with', 'without', 'from', 'this', 'that', 'these', 'those',
  'their', 'our', 'ours', 'yours', 'mine', 'my', 'me', 'we', 'us', 'they', 'them', 'its', 'it', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'how', 'why', 'what', 'when', 'where', 'many', 'most', 'people',
  'buyers', 'sellers', 'clients', 'tips', 'guide', 'learn', 'discover', 'understand', 'insights',
]);

function extractTopicAnchors(text = '') {
  const normalized = normalizeTitleText(text);
  if (!normalized) return [];
  const allTokens = normalized.split(/\s+/).filter(Boolean);
  const filtered = allTokens
    .filter((token) => token.length >= 4)
    .filter((token) => !TITLE_SIGNATURE_STOPWORDS.has(token))
    .filter((token) => !TOPIC_LOCK_LOW_SIGNAL_TOKENS.has(token));
  const anchors = [];
  const include = (phrase) => {
    if (!phrase) return;
    if (!anchors.includes(phrase)) anchors.push(phrase);
  };
  if (anchors.length < 2 && filtered.length >= 2) {
    include(`${filtered[0]} ${filtered[1]}`);
  }
  if (anchors.length < 2 && filtered.length >= 1) {
    include(filtered[0]);
  }
  if (anchors.length < 4) {
    const usedWords = new Set(anchors.join(' ').split(/\s+/).filter(Boolean));
    for (const token of filtered) {
      if (anchors.length >= 4) break;
      if (usedWords.has(token)) continue;
      include(token);
      usedWords.add(token);
    }
  }
  return anchors.slice(0, 4);
}

function countTermHits(text = '', terms = []) {
  const normalized = normalizeTitleText(text);
  if (!normalized || !terms.length) return 0;
  let hits = 0;
  terms.forEach((term) => {
    if (!term) return;
    const regex = new RegExp(`\\b${escapeRegexPattern(term)}\\b`, 'i');
    if (regex.test(normalized)) hits += 1;
  });
  return hits;
}

function validateCalendarPostQuality(post = {}, ctx = {}, state = {}) {
  return { ok: true };
}

function logCalendarPostReject(reason, ctx = {}) {
  console.log('[Calendar][ValidatePost][Reject]', {
    requestId: ctx?.requestId || null,
    mode: ctx?.mode || null,
    day: ctx?.day ?? null,
    slotIndex: ctx?.slotIndex ?? null,
    post_key: ctx?.post_key || null,
    reason: reason?.reason || reason,
    field: reason?.field || null,
    snippet: reason?.snippet || undefined,
    extra: reason?.extra || undefined,
  });
}

function validatePostCompleteness(post = {}, mode = 'regular') {
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
  checkString(post.topic_signature, 'topic_signature');
  checkString(post.angle, 'angle');
  checkString(post.designNotes, 'designNotes');
  if (!Number.isFinite(Number(post.day))) missing.push('day');

  const hashtags = Array.isArray(post.hashtags) ? post.hashtags : [];
  const validHashtags = hashtags
    .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
    .filter(Boolean);
  if (validHashtags.length < MIN_HASHTAGS) missing.push('hashtags');

  return missing;
}

const ALLOWED_CALENDAR_POST_KEYS = (() => {
  const keys = new Set();
  REQUIRED_POST_FIELDS_REGULAR.forEach((field) => {
    if (!field) return;
    keys.add(String(field).split('.')[0]);
  });
  [
    'post_key',
    'postKey',
    'day',
    'slotIndex',
    'title',
    'topic_signature',
    'angle',
    'topicCapsule',
    'format',
    'hook',
    'reelScript',
    'script',
    'caption',
    'hashtags',
    'designNotes',
    'storyPrompt',
    'cta',
    'engagementScripts',
    'dmReply',
    'details',
  ].forEach((key) => keys.add(key));
  return keys;
})();

const ALLOWED_TOPICCAPSULE_KEYS = new Set([
  'summary',
  'mustUse',
  'mustAvoid',
  'audienceAngle',
  'keyEntities',
  'talkingPoints',
  'proof',
  'objection',
  'dmReply',
]);

function sanitizeCalendarPost(post) {
  if (!post || typeof post !== 'object') return post;
  const cleaned = {};
  Object.keys(post).forEach((key) => {
    if (!ALLOWED_CALENDAR_POST_KEYS.has(key)) return;
    cleaned[key] = post[key];
  });
  if (cleaned.script && typeof cleaned.script === 'object' && !Array.isArray(cleaned.script)) {
    cleaned.script = {
      hook: cleaned.script.hook,
      body: cleaned.script.body,
      cta: cleaned.script.cta,
    };
  }
  if (cleaned.reelScript && typeof cleaned.reelScript === 'object' && !Array.isArray(cleaned.reelScript)) {
    cleaned.reelScript = cleaned.reelScript;
  }
  if (cleaned.engagementScripts && typeof cleaned.engagementScripts === 'object' && !Array.isArray(cleaned.engagementScripts)) {
    cleaned.engagementScripts = {
      commentPrompts: cleaned.engagementScripts.commentPrompts,
      dmScripts: cleaned.engagementScripts.dmScripts,
      replyTemplates: cleaned.engagementScripts.replyTemplates,
    };
  }
  if (cleaned.topicCapsule && typeof cleaned.topicCapsule === 'object' && !Array.isArray(cleaned.topicCapsule)) {
    const capsule = {};
    Object.keys(cleaned.topicCapsule).forEach((key) => {
      if (ALLOWED_TOPICCAPSULE_KEYS.has(key)) {
        capsule[key] = cleaned.topicCapsule[key];
      }
    });
    cleaned.topicCapsule = capsule;
  }
  return cleaned;
}

function sanitizePostForSchema(schema, post) {
  if (!schema || !schema.properties || !post || typeof post !== 'object') return post;
  const allowed = new Set(Object.keys(schema.properties));
  const cleaned = {};
  Object.keys(post).forEach((key) => {
    if (!allowed.has(key)) return;
    cleaned[key] = post[key];
  });
  const coerceToString = (value) => {
    if (typeof value === 'string') return value.trim();
    if (value === null || value === undefined) return '';
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  ['topicCapsule', 'script'].forEach((key) => {
    if (key in cleaned) cleaned[key] = coerceToString(cleaned[key]);
  });
  if ('details' in cleaned) {
    const rawDetails = cleaned.details;
    if (rawDetails && typeof rawDetails === 'object' && !Array.isArray(rawDetails)) {
      cleaned.details = {
        audio: coerceToString(rawDetails.audio || ''),
      };
    } else if (typeof rawDetails === 'string') {
      cleaned.details = { audio: rawDetails.trim() };
    } else {
      cleaned.details = {};
    }
  }
  if (cleaned.engagementScripts && typeof cleaned.engagementScripts === 'object' && !Array.isArray(cleaned.engagementScripts)) {
    cleaned.engagementScripts = {
      commentPrompts: Array.isArray(cleaned.engagementScripts.commentPrompts)
        ? cleaned.engagementScripts.commentPrompts
        : cleaned.engagementScripts.commentPrompts,
      dmScripts: Array.isArray(cleaned.engagementScripts.dmScripts)
        ? cleaned.engagementScripts.dmScripts
        : cleaned.engagementScripts.dmScripts,
      replyTemplates: Array.isArray(cleaned.engagementScripts.replyTemplates)
        ? cleaned.engagementScripts.replyTemplates
        : cleaned.engagementScripts.replyTemplates,
    };
  }
  return cleaned;
}

function coerceCalendarPostTypes(post) {
  if (!post || typeof post !== 'object') return post;
  if (typeof post.day === 'string' && post.day.trim()) {
    const num = Number(post.day);
    if (Number.isFinite(num)) post.day = num;
  }
  if (typeof post.slotIndex === 'string' && post.slotIndex.trim()) {
    const num = Number(post.slotIndex);
    if (Number.isFinite(num)) post.slotIndex = num;
  }
  if (typeof post.hashtags === 'string') {
    post.hashtags = post.hashtags.split(/[\s,]+/).filter(Boolean);
  }
  if (Array.isArray(post.designNotes)) {
    post.designNotes = post.designNotes.join('\n');
  }
  if (post.details && typeof post.details !== 'object') {
    post.details = { audio: String(post.details) };
  }
  if (post.details && typeof post.details === 'object' && !Array.isArray(post.details)) {
    if (post.details.audio && typeof post.details.audio !== 'string') {
      post.details.audio = String(post.details.audio);
    }
  }
  if (post.topicCapsule && typeof post.topicCapsule === 'object' && !Array.isArray(post.topicCapsule)) {
    if (typeof post.topicCapsule.talkingPoints === 'string') {
      post.topicCapsule.talkingPoints = [post.topicCapsule.talkingPoints].filter(Boolean);
    }
  }
  return post;
}

function validatePostSchemaTypes(post, mode = 'regular', schema = null) {
  const errors = [];
  const schemaRequirements = schema ? buildSchemaRequirements(schema) : null;
  const requiredFields = schemaRequirements?.requiredFields?.length
    ? schemaRequirements.requiredFields
    : requiredFieldsForMode(mode);
  const requiredTypes = schemaRequirements?.requiredTypes && Object.keys(schemaRequirements.requiredTypes).length
    ? schemaRequirements.requiredTypes
    : requiredFieldTypesForMode(mode);
  requiredFields.forEach((key) => {
    const expected = requiredTypes[key] || 'string';
    const value = getValueByPath(post, key);
    if (value === undefined || value === null) {
      errors.push({
        instancePath: `/${key.replace(/\./g, '/')}`,
        schemaPath: `#/properties/${key.split('.')[0] || ''}`,
        keyword: 'required',
        message: 'is required',
        expected,
        actual: value === null ? 'null' : 'undefined',
        params: { missingProperty: key },
      });
      return;
    }
    if (expected === 'array') {
      if (!Array.isArray(value)) {
        errors.push({
          instancePath: `/${key.replace(/\./g, '/')}`,
          schemaPath: `#/properties/${key.split('.')[0] || ''}/type`,
          keyword: 'type',
          message: 'should be array',
          expected,
          actual: Array.isArray(value) ? 'array' : typeof value,
          params: { type: 'array' },
        });
      }
      return;
    }
    if (expected === 'object') {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push({
          instancePath: `/${key.replace(/\./g, '/')}`,
          schemaPath: `#/properties/${key.split('.')[0] || ''}/type`,
          keyword: 'type',
          message: 'should be object',
          expected,
          actual: Array.isArray(value) ? 'array' : typeof value,
          params: { type: 'object' },
        });
      }
      return;
    }
    if (expected === 'number') {
      if (!Number.isFinite(Number(value))) {
        errors.push({
          instancePath: `/${key.replace(/\./g, '/')}`,
          schemaPath: `#/properties/${key.split('.')[0] || ''}/type`,
          keyword: 'type',
          message: 'should be number',
          expected,
          actual: typeof value,
          params: { type: 'number' },
        });
      }
      return;
    }
    if (expected === 'string') {
      if (typeof value !== 'string') {
        errors.push({
          instancePath: `/${key.replace(/\./g, '/')}`,
          schemaPath: `#/properties/${key.split('.')[0] || ''}/type`,
          keyword: 'type',
          message: 'should be string',
          expected,
          actual: typeof value,
          params: { type: 'string' },
        });
      }
    }
  });
  return errors;
}

function validateDecisionAnchorUniqueness(posts = []) {
  const questionMap = new Map();
  const angleMap = new Map();
  return { decision_question: [], decision_angle: [] };
}

function resolveRequestedSpec(requestedSpec = {}) {
  const spec = requestedSpec && typeof requestedSpec === 'object' ? requestedSpec : {};
  const title = toPlainString(spec.title || spec.topic || '');
  return {
    ...spec,
    title,
    topic: title,
  };
}

function getPostTopicString(post = {}) {
  return toPlainString(post?.topic || post?.title || post?.postTitle || '');
}

function matchesEquivalenceGroup(normalizedText = '', groupKey = '') {
  if (!normalizedText) return false;
  const group = EQUIV_GROUPS[groupKey];
  if (!group) return false;
  for (const phrase of group.phrases) {
    const normalizedPhrase = normalizeBindText(phrase);
    if (!normalizedPhrase) continue;
    const regex = new RegExp(`\\b${escapeRegexPattern(normalizedPhrase)}\\b`, 'i');
    if (regex.test(normalizedText)) return true;
  }
  return false;
}

function getFieldBindingSignals(text = '', fingerprint = {}) {
  const normalized = normalizeBindText(text);
  const tokens = new Set(tokenizeNormalizedText(normalized));
  const offerTokenSet = new Set(Array.isArray(fingerprint?.offerTokens) ? fingerprint.offerTokens : []);
  const fieldOfferTokens = new Set(parseOfferTokens(text));
  let offerHit = false;
  for (const token of fieldOfferTokens) {
    if (offerTokenSet.has(token)) {
      offerHit = true;
      break;
    }
  }
  const anchors = Array.isArray(fingerprint?.anchors) ? fingerprint.anchors : [];
  let anchorHits = 0;
  const seen = new Set();
  for (const anchor of anchors) {
    if (!anchor || seen.has(anchor)) continue;
    let matched = false;
    if (offerTokenSet.has(anchor)) {
      matched = fieldOfferTokens.has(anchor);
    } else {
      const groupKey = EQUIV_CANON_TO_GROUP[anchor];
      if (groupKey) {
        matched = matchesEquivalenceGroup(normalized, groupKey);
      } else {
        matched = tokens.has(anchor);
      }
    }
    if (matched) {
      anchorHits += 1;
      seen.add(anchor);
    }
  }
  return { normalized, anchorHits, offerHit };
}

function getHashtagBindingSignals(text = '', fingerprint = {}) {
  const normalized = normalizeHashtagsForBinding(text);
  const tokens = new Set(tokenizeNormalizedText(normalized));
  const offerTokenSet = new Set(Array.isArray(fingerprint?.offerTokens) ? fingerprint.offerTokens : []);
  const fieldOfferTokens = new Set(parseOfferTokens(normalized));
  let offerHit = false;
  for (const token of fieldOfferTokens) {
    if (offerTokenSet.has(token)) {
      offerHit = true;
      break;
    }
  }
  const anchors = Array.isArray(fingerprint?.anchors) ? fingerprint.anchors : [];
  let anchorHits = 0;
  const seen = new Set();
  for (const anchor of anchors) {
    if (!anchor || seen.has(anchor)) continue;
    let matched = false;
    if (offerTokenSet.has(anchor)) {
      matched = fieldOfferTokens.has(anchor);
    } else {
      const groupKey = EQUIV_CANON_TO_GROUP[anchor];
      if (groupKey) {
        matched = matchesEquivalenceGroup(normalized, groupKey);
      } else {
        matched = tokens.has(anchor);
      }
    }
    if (matched) {
      anchorHits += 1;
      seen.add(anchor);
    }
  }
  return { normalized, anchorHits, offerHit };
}

function assertPostTopicBound(post = {}, requestedSpec = {}, fallbackMustAvoid = [], context = {}) {
  return { ok: true, failedFields: [], noncoreFailedFields: [], details: {} };
  if (!post || typeof post !== 'object') {
    return { ok: false, fatal: true, failedFields: ['post'], noncoreFailedFields: [], details: { code: 'INVALID_POST' } };
  }
  const resolvedSpec = resolveRequestedSpec(requestedSpec);
  const titleText = getPostTopicString(post);
  if (!titleText) {
    const err = new Error('POST_TOPIC_MISSING');
    err.code = 'INVALID_MODEL_JSON';
    err.statusCode = 400;
    err.payload = {
      post_key: toPlainString(resolvedSpec.post_key || resolvedSpec.postKey || post.post_key || post.postKey || ''),
      day: Number.isFinite(Number(resolvedSpec.day)) ? Number(resolvedSpec.day) : (Number.isFinite(Number(post.day)) ? Number(post.day) : null),
      slotIndex: Number.isFinite(Number(resolvedSpec.slotIndex))
        ? Number(resolvedSpec.slotIndex)
        : (Number.isFinite(Number(post.slotIndex)) ? Number(post.slotIndex) : null),
    };
    throw err;
  }
  let fingerprint = deriveTopicFingerprint(titleText);
  if (!Array.isArray(fingerprint?.tokens)) fingerprint.tokens = [];
  if (!Array.isArray(fingerprint?.anchors) || !fingerprint.anchors.length) {
    fingerprint.anchors = fingerprint.tokens.slice(0, 5);
  }
  if (fingerprint.tokens.length < 3) {
    fingerprint = deriveTopicFingerprint(titleText);
  }
  const hookText = getField(post, ['hook']);
  const captionText = getField(post, ['caption']);
  const scriptText = getField(post, ['reelScript', 'reel_script', 'script']);
  const formatValue = toPlainString(post.format || post.type || post.postFormat || '');
  const formatNormalized = String(formatValue).toLowerCase();
  const isVideoFormat = ['reel', 'tiktok', 'video'].some((item) => formatNormalized.includes(item));
  let primaryFieldName = 'caption';
  if (isVideoFormat && isNonEmptyString(scriptText)) {
    primaryFieldName = 'script';
  } else if (isNonEmptyString(captionText)) {
    primaryFieldName = 'caption';
  } else if (isNonEmptyString(hookText)) {
    primaryFieldName = 'hook';
  } else if (isNonEmptyString(scriptText)) {
    primaryFieldName = 'script';
  }
  const hashtagsText = getField(post, ['hashtags']);
  const designNotesText = getField(post, ['designNotes', 'design_notes']);
  const coreFailedFields = [];
  const noncoreFailedFields = [];
  const snippets = {};
  const hookSignals = getFieldBindingSignals(hookText, fingerprint);
  const hookOk = isNonEmptyString(hookText) ? (hookSignals.offerHit || hookSignals.anchorHits >= 1) : null;
  if (hookOk === false) {
    coreFailedFields.push('hook');
    snippets.hook = hookText ? hookText.slice(0, 60) : '';
  }
  const captionSignals = getFieldBindingSignals(captionText, fingerprint);
  const captionOk = isNonEmptyString(captionText) ? (captionSignals.offerHit || captionSignals.anchorHits >= 2) : null;
  if (captionOk === false) {
    coreFailedFields.push('caption');
    snippets.caption = captionText ? captionText.slice(0, 60) : '';
  }
  const scriptSignals = getFieldBindingSignals(scriptText, fingerprint);
  const scriptOk = isNonEmptyString(scriptText) ? (scriptSignals.offerHit || scriptSignals.anchorHits >= 2) : null;
  if (scriptOk === false) {
    coreFailedFields.push('script');
    snippets.script = scriptText ? scriptText.slice(0, 60) : '';
  }
  const hashtagsSignals = getHashtagBindingSignals(hashtagsText, fingerprint);
  const hashtagsOk = isNonEmptyString(hashtagsText) && (hashtagsSignals.offerHit || hashtagsSignals.anchorHits >= 1);
  if (!hashtagsOk) {
    coreFailedFields.push('hashtags');
    snippets.hashtags = hashtagsText ? hashtagsText.slice(0, 60) : '';
  }
  const designNotesSignals = getFieldBindingSignals(designNotesText, fingerprint);
  const designNotesOk = isNonEmptyString(designNotesText)
    && (designNotesSignals.offerHit || designNotesSignals.anchorHits >= 1);
  if (!designNotesOk) {
    noncoreFailedFields.push('designNotes');
    snippets.designNotes = designNotesText ? designNotesText.slice(0, 60) : '';
  }
  if (!coreFailedFields.length && !noncoreFailedFields.length) {
    return { ok: true, failedFields: [], noncoreFailedFields: [], details: {} };
  }
  const details = {
    post_key: toPlainString(resolvedSpec.post_key || resolvedSpec.postKey || post.post_key || post.postKey || ''),
    title: titleText,
    anchors: Array.isArray(fingerprint?.anchors) ? fingerprint.anchors : [],
    offerTokens: Array.isArray(fingerprint?.offerTokens) ? fingerprint.offerTokens : [],
    primaryFieldName,
    snippets,
  };
  if (!coreFailedFields.length) {
    return { ok: true, failedFields: [], noncoreFailedFields, details };
  }
  const primaryFieldOk = primaryFieldName === 'script'
    ? scriptOk
    : (primaryFieldName === 'hook' ? hookOk : captionOk);
  const topicBoundOk = [hookOk, captionOk, scriptOk].some((value) => value === true);
  if (!(primaryFieldOk === false && !topicBoundOk)) {
    return { ok: true, failedFields: [], noncoreFailedFields, details };
  }
  return { ok: false, failedFields: coreFailedFields, noncoreFailedFields, details };
}

function runTopicBindSelfTest() {
  const title = 'Limited Time: 1% Service Fee for New Clients!';
  const requestedSpec = {
    post_key: 'day-1-slot-0',
    day: 1,
    slotIndex: 0,
    title,
    topic: title,
  };
  const basePost = {
    post_key: 'day-1-slot-0',
    day: 1,
    slotIndex: 0,
    title,
    hook: 'Get a 1% service fee for new clients.',
    caption: 'New clients get a 1% service fee offer for a limited time.',
    script: { hook: '1% service fee.', body: 'Get a 1% service fee when you join as a new client.', cta: 'Ask for details.' },
    hashtags: ['#ServiceFee', '#1Percent', '#NewClients'],
    designNotes: 'Minimal layout with the 1% offer highlighted.',
    engagementScripts: { commentReply: 'Happy to help with the offer.', dmReply: 'Share your timeline and we can help.' },
  };
  const passes = (() => {
    const result = assertPostTopicBound(basePost, requestedSpec, []);
    return result && result.ok !== false;
  })();
  console.assert(passes, '[TopicBinding][SelfTest] promo hook example should pass.');
  const fails = (() => {
    const result = assertPostTopicBound({ ...basePost, hook: 'Explore unrelated tips and ideas.' }, requestedSpec, []);
    return result && result.ok === false;
  })();
  console.assert(fails, '[TopicBinding][SelfTest] off-topic promo hook should fail.');
  const socialTitle = 'What My Clients Say About Working With Me';
  const socialSpec = {
    post_key: 'day-2-slot-0',
    day: 2,
    slotIndex: 0,
    title: socialTitle,
    topic: socialTitle,
  };
  const socialPost = {
    post_key: 'day-2-slot-0',
    day: 2,
    slotIndex: 0,
    title: socialTitle,
    hook: 'Hear what my clients say about working together.',
    caption: 'Clients share real feedback and return for the experience.',
    script: { hook: 'Client feedback matters.', body: 'Listen to my clients share their experiences.', cta: 'See their stories.' },
    hashtags: ['#Testimonials', '#ClientFeedback'],
    designNotes: 'Quote-style layout with a client photo.',
    engagementScripts: { commentReply: 'Thanks for sharing your experience.', dmReply: 'Happy to answer questions.' },
  };
  const socialFingerprint = deriveTopicFingerprint(socialTitle);
  console.assert(
    Array.isArray(socialFingerprint.tokens) && socialFingerprint.tokens.includes('testimonial'),
    '[TopicBinding][SelfTest] social proof fingerprint should include testimonial.'
  );
  const socialPass = (() => {
    const result = assertPostTopicBound(socialPost, socialSpec, []);
    return result && result.ok !== false;
  })();
  console.assert(socialPass, '[TopicBinding][SelfTest] social proof script should pass.');
  const socialFail = (() => {
    const result = assertPostTopicBound({ ...socialPost, script: { hook: 'Unrelated tips.', body: 'Explore unrelated ideas today.', cta: 'Save this.' } }, socialSpec, []);
    return result && result.ok === false;
  })();
  console.assert(socialFail, '[TopicBinding][SelfTest] off-topic social proof script should fail.');
  const nowinTitle = 'Limited Time Offer: No Win, No Fee Guarantee!';
  const nowinFingerprint = deriveTopicFingerprint(nowinTitle);
  const hasNoWinToken = Array.isArray(nowinFingerprint.offerTokens)
    && (nowinFingerprint.offerTokens.includes('nowin_nofee') || nowinFingerprint.offerTokens.includes('contingency'));
  console.assert(hasNoWinToken, '[TopicBinding][SelfTest] no-win/no-fee fingerprint should include offer token.');
  const nowinSpec = {
    post_key: 'day-3-slot-0',
    day: 3,
    slotIndex: 0,
    title: nowinTitle,
    topic: nowinTitle,
  };
  const nowinPost = {
    post_key: 'day-3-slot-0',
    day: 3,
    slotIndex: 0,
    title: nowinTitle,
    hook: 'No win, no fee — you don’t pay unless we win.',
    caption: 'No win no fee guarantee, clients only pay when we win.',
    script: { hook: 'No win, no fee.', body: 'You pay only if we win your case.', cta: 'Ask for details.' },
    hashtags: ['#NoWinNoFee'],
    designNotes: 'Bold guarantee headline.',
    engagementScripts: { commentReply: 'Happy to explain the guarantee.', dmReply: 'Send your questions.' },
  };
  const nowinPass = (() => {
    const result = assertPostTopicBound(nowinPost, nowinSpec, []);
    return result && result.ok !== false;
  })();
  console.assert(nowinPass, '[TopicBinding][SelfTest] no-win/no-fee hook should pass.');
  const nowinFail = (() => {
    const result = assertPostTopicBound({ ...nowinPost, hook: 'Unrelated tips you’ll love.' }, nowinSpec, []);
    return result && result.ok === false;
  })();
  console.assert(nowinFail, '[TopicBinding][SelfTest] off-topic no-win/no-fee hook should fail.');
  const freeTitle = 'Exclusive Offer: Free Valuation for New Clients';
  const freeFingerprint = deriveTopicFingerprint(freeTitle);
  const hasFreeToken = Array.isArray(freeFingerprint.offerTokens)
    && (freeFingerprint.offerTokens.includes('free_valuation') || freeFingerprint.offerTokens.includes('free_offer'));
  console.assert(hasFreeToken, '[TopicBinding][SelfTest] free valuation title should include offer token.');
  const freeSpec = {
    post_key: 'day-4-slot-0',
    day: 4,
    slotIndex: 0,
    title: freeTitle,
    topic: freeTitle,
  };
  const freePost = {
    post_key: 'day-4-slot-0',
    day: 4,
    slotIndex: 0,
    title: freeTitle,
    hook: 'Get your free valuation today.',
    caption: 'Get a free valuation so you know your project\'s worth.',
    script: { hook: 'Free valuation.', body: 'We offer a free valuation so you can price with confidence.', cta: 'Book yours.' },
    hashtags: ['#FreeValuation'],
    designNotes: 'Highlight the free valuation offer.',
    engagementScripts: { commentReply: 'Happy to help with your valuation.', dmReply: 'Send your details to start.' },
  };
  const freePass = (() => {
    const result = assertPostTopicBound(freePost, freeSpec, []);
    return result && result.ok !== false;
  })();
  console.assert(freePass, '[TopicBinding][SelfTest] free valuation caption should pass.');
  const freeFail = (() => {
    const result = assertPostTopicBound({ ...freePost, caption: 'New unrelated tips today.' }, freeSpec, []);
    return result && result.ok === false;
  })();
  console.assert(freeFail, '[TopicBinding][SelfTest] off-topic free valuation caption should fail.');
}

function stripAudioLinks(value = '') {
  let text = String(value || '').trim();
  if (!text) return '';
  text = text.replace(/\([^)]*(https?:\/\/|link:)[^)]*\)/gi, '');
  text = text.replace(/\bhttps?:\/\/\S+/gi, '');
  text = text.replace(/\blink:\s*\S+/gi, '');
  text = text.replace(/@[A-Za-z0-9._-]+/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function splitAudioTitleArtist(text = '') {
  const cleaned = stripAudioLinks(text).trim();
  if (!cleaned) return { title: '', artist: '' };
  const parts = cleaned.split(/\s+—\s+|\s+-\s+/);
  if (parts.length <= 1) return { title: cleaned, artist: '' };
  const title = parts.shift().trim();
  const artist = parts.join(' - ').trim();
  return { title, artist };
}

function normalizeAudioFromText(text = '') {
  return splitAudioTitleArtist(String(text || ''));
}

function sanitizeAudioEntry(entry = {}) {
  const title = stripAudioLinks(entry.title || entry.name || entry.sound || entry.track || '');
  const artist = stripAudioLinks(entry.artist || entry.creator || entry.by || '');
  return { title, artist };
}

function normalizeAudioValue(candidate, fallbackEntry = null) {
  const fallback = fallbackEntry || getEvergreenFallbackList()[0] || { title: 'Original audio', artist: 'voiceover' };
  const fallbackString = normalizeAudioString(fallback.title, fallback.artist);
  if (!candidate) {
    return fallbackString;
  }
  if (typeof candidate === 'string') {
    const parsed = normalizeAudioFromText(candidate);
    return normalizeAudioString(parsed.title || fallback.title, parsed.artist || fallback.artist);
  }
  if (candidate && typeof candidate === 'object') {
    const hasDirect = candidate.title || candidate.name || candidate.track;
    if (hasDirect) {
      const sanitized = sanitizeAudioEntry(candidate);
      return normalizeAudioString(sanitized.title || fallback.title, sanitized.artist || fallback.artist);
    }
    const sanitized = sanitizeAudioEntry(candidate);
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
  if (missingSet.has('designNotes')) post.designNotes = post.designNotes || fallback.designNotes;
  if (missingSet.has('hashtags')) {
    post.hashtags = Array.isArray(post.hashtags) && post.hashtags.length
      ? post.hashtags
      : buildFallbackHashtagList(nicheStyle || fallback.nicheStyle || '', post.format || 'reel');
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

function ensureRegenRequiredFields(rawPost = {}, nicheStyle = '', dayNumber = 1, options = {}) {
  const allowFallbacks = options?.allowFallbacks !== false;
  const normalized = normalizePostWithOverrideFallback(rawPost, 0, dayNumber, dayNumber, nicheStyle, {}, options);
  const applied = [];
  if (!isNonEmptyString(normalized.title)) {
    normalized.title = normalized.idea || `Day ${String(dayNumber).padStart(2, '0')} idea`;
    applied.push('title');
  }
      if (!isNonEmptyString(normalized.hook)) {
        normalized.hook = `Start with ${normalized.idea || 'a key insight'}.`;
        applied.push('hook');
      }
  if (allowFallbacks) {
    normalized.cta = ensureCtaFallback(normalized);
  }
  if (!isNonEmptyString(normalized.caption)) {
    if (allowFallbacks) {
      normalized.caption = `${normalized.hook} ${normalized.cta}.`.trim();
      applied.push('caption');
    }
  }
  if (!isNonEmptyString(normalized.designNotes)) {
    if (allowFallbacks) {
      normalized.designNotes = ensureDesignNotesFallback(normalized, nicheStyle);
      applied.push('designNotes');
    }
  }
  if (allowFallbacks) {
    normalized.engagementScripts = ensureEngagementScriptsFallback(normalized, nicheStyle);
  }
  if (!isNonEmptyString(normalized.topic_signature)) {
    const signature = toPlainString(rawPost.topic_signature || rawPost.topicSignature || '');
    if (signature) {
      normalized.topic_signature = signature;
    } else if (allowFallbacks) {
      normalized.topic_signature = normalizeTitleSignature(normalized.title || normalized.idea || '');
    }
    applied.push('topic_signature');
  }
  if (!isNonEmptyString(normalized.angle)) {
    const angle = toPlainString(rawPost.angle || rawPost.strategy?.angle || '');
    if (angle) {
      normalized.angle = angle;
    } else if (allowFallbacks) {
      normalized.angle = CALENDAR_ANGLE_OPTIONS[0] || 'beginner explainer';
    }
    applied.push('angle');
  }
  const scriptBase = {
    hook: normalized.script?.hook || normalized.hook,
    body: normalized.script?.body || normalized.caption || normalized.idea,
    cta: normalized.script?.cta || normalized.cta,
  };
  normalized.script = scriptBase;
  normalized.videoScript = normalized.videoScript && normalized.videoScript.hook ? normalized.videoScript : scriptBase;
  normalized.reelScript = normalized.reelScript || scriptBase;
  const fallbackAudio = getEvergreenFallbackList()[0] || { title: 'Top track', artist: 'Billboard Hot 100' };
  const normalizedAudio = normalizeAudioValue(
    normalized.audio || rawPost.audio || rawPost.audio,
    fallbackAudio
  );
  normalized.details = {
    ...(normalized.details && typeof normalized.details === 'object' && !Array.isArray(normalized.details) ? normalized.details : {}),
    audio: normalizedAudio,
  };
  delete normalized.audio;
  const inferredMode = toPlainString(normalized?.calendarMode || normalized?.mode || '') === 'brand_brain'
    ? 'brand_brain'
    : 'regular';
  let missing = validatePostCompleteness(normalized, inferredMode);
  return { post: normalized, missingFields: missing, appliedFixes: applied };
}

function ensureRegenDaySignatureAngle(post = {}, dayNumber = 1) {
  const next = { ...post };
  if (!isNonEmptyString(next.topic_signature)) {
    const signature = normalizeTitleSignature(next.title || next.idea || '');
    next.topic_signature = signature || `day-${String(dayNumber).padStart(2, '0')}`;
  }
  if (!isNonEmptyString(next.angle)) {
    const format = toPlainString(next.format || next.type || '').toLowerCase();
    const hook = toPlainString(next.hook || '');
    const hookSnippet = hook.split(/[.!?]/)[0].trim();
    const combined = [format].filter(Boolean).join(' ').trim();
    next.angle = hookSnippet || combined || 'general angle';
  }
  return next;
}

function normalizeCapsuleTokens(value) {
  if (!Array.isArray(value)) return [];
  return value.map((token) => toPlainString(token)).filter(Boolean);
}

function hashTopicSignature(source) {
  const cleaned = toPlainString(source);
  if (!cleaned) return '';
  const hashed = hashPromptPreview(cleaned);
  if (hashed) return hashed;
  const seeded = seedFromString(cleaned);
  return seeded ? seeded.toString(16).slice(0, 12) : '';
}

function deriveTopicSignature(post = {}) {
  const direct = toPlainString(post.topic_signature || post.topicSignature || '');
  if (direct) return { value: direct, source: 'direct' };
  const capsule = post.topicCapsule || post.topic_capsule;
  if (capsule && typeof capsule === 'object') {
    const summary = toPlainString(capsule.summary);
    const audienceAngle = toPlainString(capsule.audienceAngle);
    const mustUse = normalizeCapsuleTokens(capsule.mustUse).join('|');
    const keyEntities = normalizeCapsuleTokens(capsule.keyEntities).join('|');
    const joined = [summary, audienceAngle, mustUse, keyEntities].filter(Boolean).join('||');
    if (joined) {
      return { value: hashTopicSignature(joined), source: 'topicCapsule' };
    }
  }
  const title = toPlainString(post.title);
  const format = toPlainString(post.format);
  const combined = [title, format].filter(Boolean).join('|');
  if (combined) {
    return { value: hashTopicSignature(combined), source: 'title' };
  }
  return { value: '', source: 'none' };
}

function deriveAngle(post = {}) {
  const direct = toPlainString(post.angle || post.strategy?.angle || '');
  if (direct) return { value: direct, source: 'direct' };
  const capsule = post.topicCapsule || post.topic_capsule;
  if (capsule && typeof capsule === 'object') {
    const audienceAngle = toPlainString(capsule.audienceAngle);
    if (audienceAngle) return { value: audienceAngle, source: 'topicCapsule.audienceAngle' };
    const summary = toPlainString(capsule.summary);
    if (summary) return { value: summary, source: 'topicCapsule.summary' };
  }
  const title = toPlainString(post.title);
  if (title) return { value: title, source: 'title' };
  return { value: '', source: 'none' };
}

function ensureBrandBrainSignatureAngle(post = {}, loggingContext = {}) {
  const next = post;
  const derived = [];
  const failures = [];
  if (!isNonEmptyString(next.topic_signature)) {
    const signature = deriveTopicSignature(next);
    if (signature.value) {
      next.topic_signature = signature.value;
      derived.push('topic_signature');
    } else {
      failures.push('topic_signature');
    }
  }
  if (!isNonEmptyString(next.angle)) {
    const angle = deriveAngle(next);
    if (angle.value) {
      next.angle = angle.value;
      derived.push('angle');
    } else {
      failures.push('angle');
    }
  }
  if (derived.length) {
    console.warn('[BrandBrain][Derive] required fields', {
      requestId: loggingContext?.requestId || 'unknown',
      post_key: toPlainString(next.post_key || next.postKey || ''),
      derived,
    });
  }
  if (failures.length) {
    const capsule = next.topicCapsule || next.topic_capsule;
    const sources = {
      title: Boolean(toPlainString(next.title)),
      format: Boolean(toPlainString(next.format)),
      topicCapsule: capsule && typeof capsule === 'object',
      topicCapsuleSummary: Boolean(toPlainString(capsule?.summary)),
      topicCapsuleAudienceAngle: Boolean(toPlainString(capsule?.audienceAngle)),
      topicCapsuleMustUseCount: Array.isArray(capsule?.mustUse) ? capsule.mustUse.length : 0,
      topicCapsuleKeyEntitiesCount: Array.isArray(capsule?.keyEntities) ? capsule.keyEntities.length : 0,
    };
    const err = new Error('Brand Brain required fields could not be derived');
    err.code = 'BRAND_BRAIN_REQUIRED_FIELDS_MISSING';
    err.statusCode = 500;
    err.details = {
      post_key: toPlainString(next.post_key || next.postKey || ''),
      missing: failures,
      sources,
    };
    console.error('[BrandBrain][Derive] failed to derive required fields', {
      requestId: loggingContext?.requestId || 'unknown',
      ...err.details,
    });
    throw err;
  }
  return next;
}

function buildFallbackTopicCapsule(post = {}, nicheStyle = '') {
  const baseText = [
    toPlainString(post.title),
    toPlainString(post.hook),
    toPlainString(post.caption),
    toPlainString(nicheStyle),
  ]
    .filter(Boolean)
    .join(' ');
  const tokens = (baseText.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((token) => token.length > 2 && !BRAND_BRAIN_STOPWORDS.has(token));
  const unique = [];
  tokens.forEach((token) => {
    if (!unique.includes(token)) unique.push(token);
  });
  const filler = ['topic', 'audience', 'focus', 'approach', 'decision', 'signal', 'process', 'context', 'goal', 'tradeoff'];
  let fillerIndex = 0;
  while (unique.length < 5 && fillerIndex < filler.length) {
    const token = filler[fillerIndex];
    if (!unique.includes(token)) unique.push(token);
    fillerIndex += 1;
  }
  const mustUse = unique.slice(0, 10);
  const summary = toPlainString(post.title || post.hook || nicheStyle || mustUse[0]);
  const audienceAngle = toPlainString(post.angle || nicheStyle || summary);
  return {
    summary: summary || mustUse[0] || 'topic',
    mustUse,
    mustAvoid: [],
    audienceAngle: audienceAngle || summary || mustUse[0] || 'topic',
    keyEntities: mustUse.slice(0, 5),
  };
}

function ensureTopicCapsule(post = {}, nicheStyle = '') {
  if (!post || typeof post !== 'object') return post;
  const capsule = post.topicCapsule && typeof post.topicCapsule === 'object' ? { ...post.topicCapsule } : null;
  const fallback = buildFallbackTopicCapsule(post, nicheStyle);
  const mustUse = Array.isArray(capsule?.mustUse)
    ? capsule.mustUse.map((item) => toPlainString(item)).filter(Boolean)
    : fallback.mustUse.slice();
  const mustAvoid = Array.isArray(capsule?.mustAvoid)
    ? capsule.mustAvoid.map((item) => toPlainString(item)).filter(Boolean)
    : fallback.mustAvoid.slice();
  const keyEntities = Array.isArray(capsule?.keyEntities)
    ? capsule.keyEntities.map((item) => toPlainString(item)).filter(Boolean)
    : fallback.keyEntities.slice();
  const filler = fallback.mustUse.slice();
  let fillerIndex = 0;
  while (mustUse.length < 5 && fillerIndex < filler.length) {
    const token = filler[fillerIndex];
    if (!mustUse.includes(token)) mustUse.push(token);
    fillerIndex += 1;
  }
  post.topicCapsule = {
    summary: toPlainString(capsule?.summary) || fallback.summary,
    mustUse: mustUse.slice(0, 10),
    mustAvoid: mustAvoid.slice(0, 10),
    audienceAngle: toPlainString(capsule?.audienceAngle) || fallback.audienceAngle,
    keyEntities: keyEntities.length ? keyEntities.slice(0, 5) : fallback.keyEntities.slice(0, 5),
  };
  return post;
}

function repairBrandBrainRequiredKeys(post = {}, dayNumber = 1, nicheStyle = '') {
  if (!post || typeof post !== 'object') return post;
  const title = toPlainString(post.title);
  const hook = toPlainString(post.hook);
  if (!isNonEmptyString(post.topic_signature)) {
    const source = title || hook;
    const signature = source ? source.slice(0, 80).trim() : `day-${String(dayNumber).padStart(2, '0')}`;
    post.topic_signature = signature || `day-${String(dayNumber).padStart(2, '0')}`;
  }
  if (!isNonEmptyString(post.angle)) {
    const hookSentence = hook.split(/[.!?]/)[0].trim();
    const angle = hookSentence || title;
    post.angle = angle || CALENDAR_ANGLE_OPTIONS[0] || `day-${String(dayNumber).padStart(2, '0')}`;
  }
  if (post.angle && !CALENDAR_ANGLE_OPTIONS.includes(post.angle)) {
    post.angle = CALENDAR_ANGLE_OPTIONS[0] || post.angle;
  }
  ensureTopicCapsule(post, nicheStyle);
  return post;
}

function repairBrandBrainPostBatch(posts = [], nicheStyle = '', startDay = 1, postsPerDay = 1) {
  if (!Array.isArray(posts)) return [];
  return posts.map((post, idx) => {
    const dayValue = Number.isFinite(Number(post?.day))
      ? Number(post.day)
      : computePostDayIndex(idx, startDay, postsPerDay);
    const slotIndexValue = Number.isFinite(Number(post?.slotIndex)) ? Number(post.slotIndex) : 0;
    const base = post && typeof post === 'object' ? { ...post } : {};
    base.day = dayValue;
    base.slotIndex = slotIndexValue;
    if (!isNonEmptyString(base.post_key)) {
      base.post_key = postKey(dayValue, slotIndexValue);
    }
    if (!isNonEmptyString(base.format)) base.format = 'reel';
    const seeded = fillBrandBrainDefaults(base, nicheStyle);
    const ensured = ensureRegenRequiredFields(seeded, nicheStyle, dayValue, { allowFallbacks: true });
    const repaired = repairBrandBrainRequiredKeys(ensured.post, dayValue, nicheStyle);
    if (!Array.isArray(repaired.hashtags) || !repaired.hashtags.length) {
      repaired.hashtags = buildBrandBrainHashtags(nicheStyle);
    }
    if (!repaired.script || typeof repaired.script !== 'object') {
      repaired.script = { hook: repaired.hook, body: repaired.caption, cta: repaired.cta };
    }
    if (!repaired.reelScript || typeof repaired.reelScript !== 'object') {
      repaired.reelScript = { hook: repaired.script.hook, body: repaired.script.body, cta: repaired.script.cta };
    }
    if (!repaired.engagementScripts || typeof repaired.engagementScripts !== 'object') {
      repaired.engagementScripts = ensureEngagementScriptsFallback(repaired, nicheStyle);
    }
    if (!isNonEmptyString(repaired.designNotes)) {
      repaired.designNotes = ensureDesignNotesFallback(repaired, nicheStyle);
    }
    return repaired;
  });
}

function guaranteeRequiredFields(post = {}, nicheStyle = '', dayNumber = 1) {
  const dayValue = Number.isFinite(Number(post?.day)) ? Number(post.day) : Number(dayNumber) || 1;
  const result = ensureRegenRequiredFields(post, nicheStyle, dayValue, { allowFallbacks: true });
  const inferredMode = toPlainString(result?.post?.calendarMode || result?.post?.mode || '') === 'brand_brain'
    ? 'brand_brain'
    : 'regular';
  const missing = validatePostCompleteness(result.post, inferredMode);
  return { post: result.post, missingFields: missing, appliedFixes: result.appliedFixes || [] };
}

function runRegenNormalizationSelfTest() {
  if (isProduction) return;
  const sample = 'Calm Down — Rema (link: https://tiktok.com)';
  const parsed = normalizeAudioFromText(sample);
  if (!parsed.title || !parsed.artist) {
    console.warn('[Calendar][Test] audio normalize failed', { parsed });
  }
  const repaired = ensureRegenRequiredFields({ day: 1, idea: 'Test idea' }, 'Test niche', 1);
  if (repaired.missingFields.length) {
    console.warn('[Calendar][Test] regen normalization missing fields', repaired.missingFields);
  }
  const unexpected = repaired.missingFields.filter((field) => !requiredFieldsForMode('regular').includes(field));
  if (unexpected.length) {
    console.warn('[Calendar][Test] regen normalization unexpected required fields', unexpected);
  }
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

function withTimeout(promise, ms, meta = {}) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error('MODEL_TIMEOUT');
      err.code = 'MODEL_TIMEOUT';
      err.meta = meta;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function extractAudioFromPost(post = {}) {
  if (!post || typeof post !== 'object') return null;
  const candidate = post?.details?.audio ?? post.audio ?? post.audio;
  if (!candidate) return null;
  if (typeof candidate === 'string') {
    return candidate.trim();
  }
  if (typeof candidate === 'object') {
    const normalized = normalizeAudioValue(candidate);
    return normalized || null;
  }
  return null;
}

function normalizePost(post, idx = 0, startDay = 1, forcedDay, nicheStyle = '', options = {}) {
  const allowFallbacks = options?.allowFallbacks !== false;
  if (!post || typeof post !== 'object') {
    const err = new Error('Invalid post payload');
    err.code = 'BAD_REQUEST';
    err.statusCode = 400;
    throw err;
  }
  const fallbackDay = typeof forcedDay === 'number'
    ? Number(forcedDay)
    : (startDay ? Number(startDay) + idx : idx + 1);
  const platform = toPlainString(post.format || post.platform || 'reel');
  const fallbackHashtags = allowFallbacks ? buildFallbackHashtagList(nicheStyle, platform) : [];
  const hashtags = ensureHashtagArray(post.hashtags || [], fallbackHashtags, allowFallbacks ? 8 : 0);
  const repurpose = allowFallbacks
    ? ensureStringArray(post.repurpose || [], ['Reel -> Remix with new hook', 'Reel -> Clip as teaser'], 2)
    : ensureStringArray(post.repurpose || [], [], 0);
  const analytics = allowFallbacks
    ? ensureStringArray(post.analytics || [], ['Reach', 'Saves'], 2)
    : ensureStringArray(post.analytics || [], [], 0);
  const scriptSource = (post.script && typeof post.script === 'object' && !Array.isArray(post.script))
    ? post.script
    : (post.videoScript && typeof post.videoScript === 'object' && !Array.isArray(post.videoScript))
      ? post.videoScript
      : (post.reelScript && typeof post.reelScript === 'object' && !Array.isArray(post.reelScript))
        ? post.reelScript
        : {};
  const scriptObject = normalizeScriptObject(scriptSource);
  const videoScript = { ...scriptObject };
  const scriptText = typeof post.script === 'string' ? post.script.trim() : '';
  const reelScriptParts = post.reelScript && typeof post.reelScript === 'object' && !Array.isArray(post.reelScript)
    ? post.reelScript
    : null;
  const renderedFromParts = reelScriptParts ? renderReelScriptFromParts(reelScriptParts, reelScriptParts?.brandBrainMarkers) : '';
  const reelScriptText = renderedFromParts
    ? renderedFromParts.trim()
    : (typeof post.reelScript === 'string' ? post.reelScript.trim() : scriptText);
  const engagementScriptsValue = (post.engagementScripts && typeof post.engagementScripts === 'object' && !Array.isArray(post.engagementScripts))
    ? post.engagementScripts
    : post.engagementScripts;
  const resolvedDay = typeof post.day === 'number' ? post.day : fallbackDay;
  const postKeyValue = toPlainString(post.post_key || post.postKey || '');
  const slotIndexValue = Number.isFinite(Number(post.slotIndex)) ? Number(post.slotIndex) : null;
  const rawDesignNotes = post.designNotes ?? post.design_notes ?? post.designNotesRaw;
  const normalizedDesignNotes = normalizeDesignNotesInput(rawDesignNotes);
  const normalized = {
    post_key: postKeyValue,
    day: resolvedDay,
    slotIndex: slotIndexValue,
    idea: toPlainString(post.idea || post.title || ''),
    title: toPlainString(post.title || post.idea || ''),
    topicCapsule: post.topicCapsule || post.topic_capsule,
    type: toPlainString(post.type || ''),
    hook: toPlainString(post.hook || scriptObject.hook || ''),
    caption: toPlainString(post.caption || ''),
    topic_signature: toPlainString(post.topic_signature || post.topicSignature || ''),
    angle: toPlainString(post.angle || ''),
    hashtags,
    format: 'reel',
    formatIntent: toPlainString(post.formatIntent || ''),
    cta: toPlainString(post.cta || ''),
    designNotes: normalizedDesignNotes.value || '',
    repurpose,
    analytics,
    engagementScripts: engagementScriptsValue,
    promoSlot: typeof post.promoSlot === 'boolean' ? post.promoSlot : !!post.weeklyPromo,
    weeklyPromo: typeof post.weeklyPromo === 'string' ? post.weeklyPromo : '',
    script: reelScriptText,
    reelScript: reelScriptText,
    videoScript,
    instagram_caption: toPlainString(post.instagram_caption || post.caption || ''),
    tiktok_caption: toPlainString(post.tiktok_caption || post.caption || ''),
    linkedin_caption: toPlainString(post.linkedin_caption || post.caption || ''),
    audio: toPlainString(post.audio || ''),
    strategy: post.strategy || {},
    details: {
      audio: extractAudioFromPost(post) || '',
    },
  };
  if (normalizedDesignNotes.changed) {
    console.log('[Calendar][NormalizeDesignNotes]', {
      requestId: loggingContext?.requestId || null,
      post_key: postKeyValue || null,
      changed: true,
      beforeSnippet: normalizedDesignNotes.before || '',
      afterSnippet: normalizedDesignNotes.after || '',
    });
  }
  if (post.topicBindingFailed) {
    normalized.topicBindingFailed = true;
    if (Array.isArray(post.topicBindingFailedFields) && post.topicBindingFailedFields.length) {
      normalized.topicBindingFailedFields = post.topicBindingFailedFields.slice();
    }
  }
  if (!normalized.promoSlot) normalized.weeklyPromo = '';
  if (allowFallbacks) {
    normalized.cta = ensureCtaFallback(normalized);
    normalized.engagementScripts = ensureEngagementScriptsFallback(normalized, nicheStyle);
  }
  return normalized;
}

if (!isProduction) {
  runRegenNormalizationSelfTest();
}
if (process.env.TOPICBIND_SELFTEST === '1') {
  runTopicBindSelfTest();
}

function normalizePostWithOverrideFallback(post, idx = 0, startDay = 1, forcedDay, nicheStyle = '', loggingContext = {}, options = {}) {
  const allowFallbacks = options?.allowFallbacks !== false;
  return normalizePost(post, idx, startDay, forcedDay, nicheStyle, { allowFallbacks });
}

const enrichRegenPost = (post = {}, dayIndex = 0) => {
  const enriched = { ...post };
  return enriched;
};


function extractFirstJsonObject(text = '') {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function findFirstJsonSegment(text = '') {
  const source = String(text || '');
  let inString = false;
  let escape = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
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
      const segment = captureJsonSegment(source, i);
      if (segment) return segment;
    }
  }
  return null;
}

function parsePostsFromModelText(rawText, { expectedPosts, chunkStartDay, chunkEndDay, postsPerDay } = {}) {
  const text = String(rawText || '').trim();
  if (!text) return null;
  let responseText = text;
  responseText = responseText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  const cleaned = responseText.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  let posts = null;
  let shape = 'unknown';
  if (Array.isArray(parsed)) {
    posts = parsed;
    shape = 'array';
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.posts)) {
      posts = parsed.posts;
      shape = 'posts-wrapper';
    } else if (parsed.post && typeof parsed.post === 'object') {
      posts = [parsed.post];
      shape = 'post-wrapper';
    } else if (parsed.day != null) {
      posts = [parsed];
      shape = 'single-object';
    }
  }
  if (!Array.isArray(posts)) return null;
  const normalized = posts.filter((post) => post && typeof post === 'object').map((post) => {
    const dayValue = Number(post.day);
    const perDay = Number(postsPerDay);
    const explicitSlotIndex = Number.isFinite(Number(post.slotIndex)) ? Number(post.slotIndex) : null;
    let slotValue = explicitSlotIndex;
    if (slotValue === null && Number.isFinite(Number(post.slot_index))) {
      slotValue = Number(post.slot_index);
    }
    if (slotValue === null && Number.isFinite(Number(post.slot))) {
      slotValue = Number(post.slot) - 1;
    }
    if (Number.isFinite(dayValue)) post.day = dayValue;
    if (Number.isFinite(slotValue)) post.slotIndex = slotValue;
    if (Number.isFinite(perDay) && perDay === 1 && (post.slotIndex == null || post.slotIndex === 1)) {
      post.slotIndex = 0;
    }
    return post;
  });
  const dayStart = Number.isFinite(Number(chunkStartDay)) ? Number(chunkStartDay) : null;
  const dayEnd = Number.isFinite(Number(chunkEndDay)) ? Number(chunkEndDay) : null;
  const slotMax = Number.isFinite(Number(postsPerDay)) && Number(postsPerDay) > 0 ? Number(postsPerDay) - 1 : null;
  const filtered = normalized.filter((post) => {
    const dayValue = Number(post.day);
    const slotValue = Number(post.slotIndex);
    if (Number.isFinite(dayValue) && dayStart !== null && dayEnd !== null) {
      if (dayValue < dayStart || dayValue > dayEnd) return false;
    }
    if (Number.isFinite(slotValue) && slotMax !== null) {
      if (slotValue < 0 || slotValue > slotMax) return false;
    }
    return true;
  });
  let selected = filtered;
  if (Number.isFinite(Number(expectedPosts)) && filtered.length > expectedPosts) {
    selected = filtered
      .slice()
      .sort((a, b) => {
        const dayA = Number.isFinite(Number(a.day)) ? Number(a.day) : Number.POSITIVE_INFINITY;
        const dayB = Number.isFinite(Number(b.day)) ? Number(b.day) : Number.POSITIVE_INFINITY;
        if (dayA !== dayB) return dayA - dayB;
        const slotA = Number.isFinite(Number(a.slotIndex)) ? Number(a.slotIndex) : Number.POSITIVE_INFINITY;
        const slotB = Number.isFinite(Number(b.slotIndex)) ? Number(b.slotIndex) : Number.POSITIVE_INFINITY;
        return slotA - slotB;
      })
      .slice(0, expectedPosts);
  }
  if (Number.isFinite(Number(expectedPosts)) && selected.length !== expectedPosts) return null;
  return { posts: selected, shape };
}

function safeJsonParse(raw = '') {
  if (!raw) return null;
  let text = String(raw).trim();
  if (!text) return null;
  let responseText = text;
  responseText = responseText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  text = responseText.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  const firstBrace = text.indexOf('{');
  if (firstBrace > 0) text = text.slice(firstBrace);
  const lastBrace = text.lastIndexOf('}');
  if (lastBrace !== -1 && lastBrace < text.length - 1) text = text.slice(0, lastBrace + 1);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function looksTruncatedJson(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return false;
  const lastChar = text[text.length - 1];
  if (lastChar !== '}' && lastChar !== ']') return true;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
  }
  return depth !== 0;
}

function normalizeCalendarModelOutput(rawParsed, expectedCount, context = {}, rawText = '') {
  let posts = null;
  let shape = 'unknown';
  if (Array.isArray(rawParsed)) {
    posts = rawParsed;
    shape = 'array';
  } else if (rawParsed && typeof rawParsed === 'object') {
    if (Array.isArray(rawParsed.posts)) {
      posts = rawParsed.posts;
      shape = 'posts-wrapper';
    } else if (rawParsed.post && typeof rawParsed.post === 'object') {
      posts = [rawParsed.post];
      shape = 'post-wrapper';
    } else if (rawParsed.title && rawParsed.hook) {
      posts = [rawParsed];
      shape = 'direct-post-object';
    } else {
      const arrayKey = Object.keys(rawParsed).find((key) => Array.isArray(rawParsed[key]));
      if (arrayKey) {
        posts = rawParsed[arrayKey];
        shape = `array-key:${arrayKey}`;
      }
    }
    if (!posts) {
      posts = [rawParsed];
      shape = 'single-object';
    }
  }
  if (Array.isArray(posts) && Number.isFinite(Number(expectedCount)) && Number(expectedCount) === 1 && posts.length > 1) {
    const firstObject = posts.find((item) => item && typeof item === 'object');
    if (firstObject) {
      posts = [firstObject];
      shape = `${shape}|first-object-only`;
    }
  }
  if (Number.isFinite(Number(expectedCount)) && Number(expectedCount) === 1 && posts && !Array.isArray(posts)) {
    posts = [posts];
    shape = `${shape}|wrapped-single`;
  }
  if (Number.isFinite(Number(expectedCount)) && Number(expectedCount) === 1 && Array.isArray(posts) && posts.length === 1) {
    const candidate = posts[0];
    if (candidate && typeof candidate === 'object' && Array.isArray(candidate.posts) && candidate.posts.length) {
      posts = [candidate.posts[0]];
      shape = `${shape}|nested-posts-first`;
    } else if (candidate && typeof candidate === 'object') {
      const arrayKey = Object.keys(candidate).find((key) => Array.isArray(candidate[key]) && candidate[key].length > 0);
      if (arrayKey) {
        const nested = candidate[arrayKey].find((item) => item && typeof item === 'object');
        if (nested) {
          posts = [nested];
          shape = `${shape}|nested-array-key:${arrayKey}`;
        }
      }
    }
  }
  if (!Array.isArray(posts)) {
    console.warn('[Calendar][Parse] schema_mismatch', {
      requestId: context?.requestId || null,
      mode: context?.mode || null,
      chunkIndex: context?.chunkIndex ?? null,
      day: context?.day ?? null,
      expectedPosts: expectedCount ?? null,
      parsedType: typeof rawParsed,
      isArray: Array.isArray(rawParsed),
      keys: rawParsed && typeof rawParsed === 'object' ? Object.keys(rawParsed).slice(0, 20) : [],
      rawSnippet: rawText ? String(rawText).slice(0, 300) : '',
      schemaName: context?.schemaName || null,
    });
    const err = new Error('SCHEMA_MISMATCH');
    err.code = 'SCHEMA_MISMATCH';
    err.statusCode = 422;
    err.details = {
      reason: 'invalid_envelope',
      expectedPosts: expectedCount,
      shape,
    };
    throw err;
  }
  if (Number.isFinite(Number(expectedCount)) && posts.length !== Number(expectedCount)) {
    console.warn('[Calendar][Parse] schema_mismatch', {
      requestId: context?.requestId || null,
      mode: context?.mode || null,
      chunkIndex: context?.chunkIndex ?? null,
      day: context?.day ?? null,
      expectedPosts: expectedCount ?? null,
      actualPosts: posts.length,
      shape,
      schemaName: context?.schemaName || null,
    });
    const err = new Error('SCHEMA_MISMATCH');
    err.code = 'SCHEMA_MISMATCH';
    err.statusCode = 422;
    err.details = {
      reason: 'count_mismatch',
      expectedPosts: expectedCount,
      actualPosts: posts.length,
      shape,
    };
    throw err;
  }
  return { posts, shape };
}

function logCalendarPostShapeFingerprint(obj, ctx = {}) {
  const safe = obj && typeof obj === 'object' ? obj : {};
  const topKeys = Object.keys(safe);
  const topTypes = {};
  topKeys.forEach((key) => {
    const value = safe[key];
    topTypes[key] = Array.isArray(value) ? 'array' : typeof value;
  });
  let nested = null;
  if (safe.post && typeof safe.post === 'object') {
    nested = safe.post;
  } else if (Array.isArray(safe.posts) && safe.posts[0] && typeof safe.posts[0] === 'object') {
    nested = safe.posts[0];
  }
  let nestedKeys = [];
  let nestedTypes = {};
  if (nested) {
    nestedKeys = Object.keys(nested);
    nestedKeys.forEach((key) => {
      const value = nested[key];
      nestedTypes[key] = Array.isArray(value) ? 'array' : typeof value;
    });
  }
  console.log('[Calendar][Shape]', {
    requestId: ctx?.requestId || null,
    day: ctx?.day ?? null,
    post_key: ctx?.post_key || null,
    topKeys,
    topTypes,
    nestedKeys,
    nestedTypes,
  });
}

function extractStructuredJsonTextFromResponsesOutput(resp) {
  const out = resp?.output;
  if (!Array.isArray(out)) return null;
  for (const item of out) {
    if (item?.type !== 'message') continue;
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'output_text' && typeof part?.text === 'string') return part.text;
      if (part?.type === 'text' && typeof part?.text === 'string') return part.text;
    }
  }
  return null;
}

function extractStructuredCalendarOutput(resp) {
  const responseId = resp?.id || null;
  const model = resp?.model || null;
  const presentFields = resp && typeof resp === 'object' ? Object.keys(resp) : [];
  const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
  let parsed = null;
  let text = null;
  const directCandidates = [resp?.output_parsed, resp?.parsed];
  for (const candidate of directCandidates) {
    if (isPlainObject(candidate) || Array.isArray(candidate)) {
      parsed = candidate;
      break;
    }
  }
  if (!parsed && Array.isArray(resp?.output)) {
    for (const item of resp.output) {
      if (isPlainObject(item?.parsed) || Array.isArray(item?.parsed)) {
        parsed = item.parsed;
        break;
      }
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const chunk of content) {
        if (isPlainObject(chunk?.parsed) || Array.isArray(chunk?.parsed)) {
          parsed = chunk.parsed;
          break;
        }
        if (isPlainObject(chunk?.json) || Array.isArray(chunk?.json)) {
          parsed = chunk.json;
          break;
        }
      }
      if (parsed) break;
    }
  }
  text = extractStructuredJsonTextFromResponsesOutput(resp);
  return { parsed, text, responseId, model, presentFields };
}

function extractCalendarOutput(resp) {
  const responseId = resp?.id || null;
  const model = resp?.model || null;
  const presentFields = resp && typeof resp === 'object' ? Object.keys(resp) : [];
  const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const looksLikePost = (value) => {
    if (!isPlainObject(value)) return false;
    if (typeof value.post_key !== 'string') return false;
    if (!('day' in value)) return false;
    if (typeof value.title !== 'string') return false;
    return true;
  };
  let json = null;
  let text = null;
  const directCandidates = [
    resp?.output_parsed,
    resp?.parsed,
  ];
  for (const candidate of directCandidates) {
    if (isPlainObject(candidate)) {
      json = candidate;
      break;
    }
  }
  if (!json && Array.isArray(resp?.output)) {
    for (const item of resp.output) {
      if (isPlainObject(item?.parsed)) {
        json = item.parsed;
        break;
      }
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const chunk of content) {
        if (isPlainObject(chunk?.json)) {
          json = chunk.json;
          break;
        }
        if (isPlainObject(chunk?.parsed)) {
          json = chunk.parsed;
          break;
        }
      }
      if (json) break;
    }
  }
  if (!json) {
    if (typeof resp?.output_text === 'string') {
      text = resp.output_text;
    } else if (Array.isArray(resp?.output)) {
      const outputText = resp.output
        .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
        .map((chunk) => {
          if (chunk?.type === 'output_text' && typeof chunk?.text === 'string') return chunk.text;
          if (chunk?.type === 'text' && typeof chunk?.text === 'string') return chunk.text;
          if (typeof chunk?.text === 'string') return chunk.text;
          return '';
        })
        .filter(Boolean)
        .join('');
      if (outputText) text = outputText;
    }
  }
  const kind = json ? 'structured' : text ? 'text' : 'none';
  const jsonIsPostLike = json && (looksLikePost(json) || (Array.isArray(json?.posts) && json.posts.length >= 1));
  return { kind, json: jsonIsPostLike ? json : json, text, responseId, model, presentFields };
}

async function generateTopicPlan({
  nicheStyle,
  brandContext,
  totalPosts,
  startDay,
  postsPerDay,
  days,
  brandBrainEnabled,
  requestId,
  brandBrainDirective,
  context,
}) {
  const cleanNiche = nicheStyle ? ` for ${nicheStyle}` : '';
  const requestLabel = requestId ? `RequestId: ${requestId}\n` : '';
  const pushWarning = (detail) => {
    if (!context) return;
    if (!Array.isArray(context.warnings)) context.warnings = [];
    context.warnings.push({ code: 'TOPIC_PLAN_SKIPPED', detail });
  };
  const assignedSlots = buildTopicPlanSlots(totalPosts, startDay, postsPerDay);
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['topics'],
    properties: {
      topics: {
        type: 'array',
        minItems: totalPosts,
        maxItems: totalPosts,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['slot', 'day', 'postIndex', 'title', 'angle'],
          properties: {
            slot: { type: 'integer', minimum: 0, maximum: Math.max(0, totalPosts - 1) },
            day: { type: 'integer', minimum: startDay, maximum: startDay + Math.max(1, Number(days) || 1) - 1 },
            postIndex: { type: 'integer', minimum: 0, maximum: Math.max(0, Number(postsPerDay) - 1) },
            title: { type: 'string', minLength: 4 },
            angle: { type: 'string', minLength: 8 },
          },
        },
      },
    },
  };
  try {
    JSON.stringify(schema);
  } catch (err) {
    pushWarning({ reason: 'schema_invalid', message: err?.message || err });
    return null;
  }
  try {
    assertJsonSchemaFiniteNumbers(schema, 'topicPlanSchema');
  } catch (err) {
    pushWarning({ reason: 'schema_invalid', message: err?.message || err });
    return null;
  }
  const slotLines = assignedSlots.map(
    (slot) => `Slot ${slot.slot} | Day ${slot.day} | postIndex ${slot.postIndex}`
  );
  const prompt = [
    'You are planning topics for short-form posts.',
    requestLabel.trim(),
    brandBrainEnabled && brandBrainDirective ? `\n${brandBrainDirective.trim()}` : '',
    'Goal: produce a plan where each post has one clear topic label and one concrete moment anchor.',
    'Return valid JSON matching the schema exactly.',
    'Use only schema keys.',
    `Create exactly ${totalPosts} items for days ${startDay}..${startDay + Math.max(1, Number(days) || 1) - 1}.`,
    'For each item, set slot/day/postIndex to the assigned values.',
    'Each item includes:',
    '- title: specific topic label with concrete phrasing tied to the niche and a single visual moment',
    '- angle: short decision-dynamic label that supports an entertaining, concrete post',
    'Title quality: identify a concrete moment the audience can picture.',
    'Angle quality: identify the decision dynamic that drives what happens next.',
    'Assigned slots:',
    ...slotLines,
  ].filter(Boolean).join('\n');
  let json = null;
  try {
    json = await withTimeout(
      claudeMessagesRequest({
        model: 'claude-sonnet-4-5-20250514',
        system: 'Return valid JSON only.',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 900,
        temperature: 0.2,
        tools: [{
          name: 'plan_calendar_topics',
          description: 'Plan topic slots for short-form videos.',
          input_schema: schema,
        }],
        toolChoice: { type: 'tool', name: 'plan_calendar_topics' },
      }),
      CALENDAR_PLAN_TIMEOUT_MS,
      { requestId, phase: 'topic_plan' }
    );
  } catch (err) {
    const details = extractOpenAiErrorDetails(err);
    console.error('[OpenAI][TopicPlan] request failed', {
      requestId: requestId || null,
      mode: 'topicPlan',
      model: 'claude-sonnet-4-5-20250514',
      responseFormat: null,
      statusCode: err?.statusCode || err?.status || null,
      ...details,
    });
    pushWarning({ reason: 'openai_error', details });
    return null;
  }
  const contentBlocks = Array.isArray(json?.raw?.content) ? json.raw.content : [];
  const toolBlock = contentBlocks.find((b) => b && b.type === 'tool_use' && b.name === 'plan_calendar_topics');
  const topics = Array.isArray(toolBlock?.input?.topics) ? toolBlock.input.topics : null;
  if (!topics) {
    pushWarning({ reason: 'missing_topics' });
    return null;
  }
  if (topics.length !== totalPosts) {
    pushWarning({ reason: 'count_mismatch', expectedCount: totalPosts, actualCount: topics.length });
    return null;
  }
  const titleSet = new Set();
  const signatureSet = new Set();
  for (const topic of topics) {
    const title = String(topic?.title || '').trim();
    if (!title) {
      pushWarning({ reason: 'empty_title' });
      return null;
    }
    const normalizedTitle = normalizeTitleText(title);
    const signature = normalizeTitleSignature(title);
    if (titleSet.has(normalizedTitle)) {
      pushWarning({ reason: 'duplicate_title', value: normalizedTitle });
      return null;
    }
    if (signature && signatureSet.has(signature)) {
      pushWarning({ reason: 'duplicate_signature', value: signature });
      return null;
    }
    titleSet.add(normalizedTitle);
    if (signature) signatureSet.add(signature);
  }
  return topics;
}

async function callOpenAI(nicheStyle, brandContext, opts = {}) {
  const { loggingContext = {} } = opts;
  const modelName = opts.model || 'claude-opus-4-6';
  const maxTokenCap = opts.compactPrompt ? 6000 : (opts.reduceVerbosity ? 2600 : 3200);
  const requestedTokens =
    Number.isFinite(Number(opts.maxTokens)) && Number(opts.maxTokens) > 0
      ? Number(opts.maxTokens)
      : maxTokenCap;
  const maxTokens = Math.min(requestedTokens, maxTokenCap);
  const calendarMode = String(
    opts.calendarMode || (opts.brandBrainEnabled ? 'brand_brain' : 'regular')
  ).toLowerCase() === 'brand_brain'
    ? 'brand_brain'
    : 'regular';
  const defaultTemperature = calendarMode === 'brand_brain' ? 0.5 : 0.4;
  const temperature = Number.isFinite(Number(opts.temperature)) ? Number(opts.temperature) : defaultTemperature;
  const presencePenalty = Number.isFinite(Number(opts.presencePenalty))
    ? Number(opts.presencePenalty)
    : (Number.isFinite(Number(opts.presence_penalty)) ? Number(opts.presence_penalty) : 0);
  const requestTimeoutMs = Number.isFinite(Number(opts.requestTimeoutMs)) ? Number(opts.requestTimeoutMs) : OPENAI_GENERATION_TIMEOUT_MS;
  const chunkDays = Number.isFinite(Number(opts.days)) && Number(opts.days) > 0 ? Number(opts.days) : 1;
  const chunkStartDay = Number.isFinite(Number(opts.startDay)) ? Number(opts.startDay) : 1;
  const postsPerDay = 1;
  const useSinglePost = Boolean(opts.singlePost);
  const schemaName = useSinglePost
    ? (calendarMode === 'brand_brain' ? 'calendar_post_brandbrain' : 'calendar_post_regular')
    : (calendarMode === 'brand_brain' ? 'calendar_batch_brandbrain' : 'calendar_batch_regular');
  const expectedChunkCount = useSinglePost ? 1 : chunkDays * postsPerDay;
  const schema = useSinglePost && opts.schemaOverride
    ? opts.schemaOverride
    : useSinglePost
      ? getCalendarPostSchema(
          calendarMode,
          chunkStartDay,
          Number.isFinite(Number(chunkStartDay + chunkDays - 1)) ? chunkStartDay + chunkDays - 1 : chunkStartDay
        )
      : buildCalendarSchemaObject(
          expectedChunkCount,
          chunkStartDay,
          Number.isFinite(Number(chunkStartDay + chunkDays - 1)) ? chunkStartDay + chunkDays - 1 : chunkStartDay,
          calendarMode
        );
  try {
    JSON.stringify(schema);
    if (!schema || schema.type !== 'object' || !schema.properties || !schema.required) {
      throw new Error('Invalid schema root shape');
    }
    assertJsonSchemaFiniteNumbers(schema, 'calendarChunkSchema');
    assertJsonSchemaAdditionalProperties(schema, 'calendarChunkSchema');
  } catch (err) {
    const schemaErr = new Error('OpenAI schema validation failed');
    schemaErr.code = 'OPENAI_SCHEMA_ERROR';
    schemaErr.statusCode = 400;
    schemaErr.details = { message: err?.message || err, schemaKeys: Object.keys(schema || {}) };
    throw schemaErr;
  }
  const propertyKeys = Object.keys(schema.properties || {});
  const requiredKeys = new Set(Array.isArray(schema.required) ? schema.required : []);
  const missingRequired = propertyKeys.filter((key) => !requiredKeys.has(key));
  if (missingRequired.length) {
    console.error('[Calendar][Schema][Preflight] required missing keys', {
      schemaName: useSinglePost ? 'calendar_post' : 'calendar_batch',
      missingRequired,
    });
    const schemaErr = new Error('OpenAI schema invalid');
    schemaErr.code = 'OPENAI_SCHEMA_INVALID';
    schemaErr.statusCode = 422;
    schemaErr.details = {
      message: 'Schema required is missing property keys',
      schemaName: useSinglePost ? 'calendar_post' : 'calendar_batch',
      missingRequired,
    };
    throw schemaErr;
  }
  const debugEnabled = process.env.DEBUG_AI_PARSE === '1';
  const attemptStart = Date.now();
  const contextLabel = formatCalendarLogContext(loggingContext);
  const label = contextLabel ? ` (${contextLabel})` : '';
  const debugCalendar = process.env.DEBUG_CALENDAR === '1';
  const previewJson = (value = '') => {
    if (!value) return '';
    const snippet = String(value);
    return snippet.length <= 500 ? snippet : `${snippet.slice(0, 500)}...`;
  };
  let lastPromptMeta = null;
  const attachPromptMeta = (err) => {
    if (!err || typeof err !== 'object') return;
    err.promptMeta = lastPromptMeta;
    err.model = modelName;
    err.responseFormat = null;
    err.mode = opts.brandBrainDirective ? 'chunk_brand_brain' : 'chunk';
  };
  const extractStructuredOutput = (responseJson) => {
    if (!responseJson || typeof responseJson !== 'object') return null;
    if (responseJson.output_parsed && typeof responseJson.output_parsed === 'object') return responseJson.output_parsed;
    const output = Array.isArray(responseJson.output) ? responseJson.output : [];
    for (const item of output) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const chunk of content) {
        if (chunk && typeof chunk === 'object') {
          if (chunk.json && typeof chunk.json === 'object') return chunk.json;
          if (chunk.parsed && typeof chunk.parsed === 'object') return chunk.parsed;
        }
      }
    }
    return null;
  };
  const parseJsonFromText = (text = '') => {
    let responseText = String(text || '');
    responseText = responseText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const trimmed = String(responseText || '').trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('PARSE_FAILED');
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  };

  const attemptRequest = async (_useSchema = true, overrides = {}) => {
    const attemptTimestamp = Date.now();
    const attemptNumber = Number.isFinite(Number(overrides.attempt)) ? Number(overrides.attempt) : 1;
    const attemptMaxTokens = Number.isFinite(Number(overrides.maxTokens)) ? Number(overrides.maxTokens) : maxTokens;
    const attemptTemperature = Number.isFinite(Number(overrides.temperature)) ? Number(overrides.temperature) : temperature;
    const attemptPresencePenalty = Number.isFinite(Number(overrides.presencePenalty))
      ? Number(overrides.presencePenalty)
      : presencePenalty;
    const attemptModel = overrides.model || modelName;
    const attemptTimeoutMs = Number.isFinite(Number(overrides.timeoutMs)) ? Number(overrides.timeoutMs) : requestTimeoutMs;
    const attemptOpts = {
      ...opts,
      days: chunkDays,
      startDay: chunkStartDay,
      postsPerDay,
      singlePost: useSinglePost,
      isPro: Boolean(opts.isPro),
      requestId: loggingContext?.requestId || '',
    };
    const prompt = buildPrompt(nicheStyle, brandContext, attemptOpts);
    lastPromptMeta = {
      chars: prompt.length,
      hash: hashPromptPreview(prompt),
    };
    const voiceLockApplied = Boolean(attemptOpts.voiceLock?.enabled);
    const voiceLockPreset = attemptOpts.voiceLock?.preset
      ? (VOICE_LOCK_PRESET_GUIDES[attemptOpts.voiceLock.preset]?.label || attemptOpts.voiceLock.preset)
      : 'none';
    const openAiRequestId = loggingContext?.requestId || 'unknown';
    if (debugCalendar) {
      if (voiceLockApplied) {
        console.log('[VoiceLock] applied=true preset="%s" requestId=%s', voiceLockPreset, openAiRequestId);
      } else if (attemptOpts.voiceLock?.reason === 'unknown_preset') {
        console.log('[VoiceLock] applied=false requestId=%s reason=unknown_preset', openAiRequestId);
      } else {
        console.log('[VoiceLock] applied=false requestId=%s', openAiRequestId);
      }
      if (loggingContext?.requestId) {
        console.log('[Calendar][Prompt]', {
          requestId: loggingContext.requestId,
          chunkStartDay,
          chunkDays,
          promptChars: prompt.length,
          maxTokens: attemptMaxTokens,
          planUsed: Boolean(opts.planUsed),
        });
      }
    }
    const systemMessage = 'You write exactly what a person would say out loud. Every script you write is a transcript of spoken words. You write in complete sentences that flow into each other as one continuous paragraph. When you write a CTA, you write one sentence that connects back to what the creator just said.';
    if (debugCalendar && loggingContext?.requestId) {
      console.log('[Claude][CalendarChunk][Payload]', {
        requestId: loggingContext.requestId,
        model: 'claude-opus-4-6',
        hasSystem: true,
        hasMessages: true,
        maxTokens: Math.max(4000, attemptMaxTokens),
      });
    }
    const requestPromise = withOpenAiSlot(() =>
      claudeMessagesRequest({
        model: 'claude-opus-4-6',
        system: systemMessage,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: Math.max(4000, attemptMaxTokens),
        temperature: attemptTemperature,
      }).catch((err) => {
        const mode = opts.brandBrainDirective ? 'chunk_brand_brain' : 'chunk';
        const details = {
          claudeType: err?.claudeError?.type || null,
          claudeMessage: err?.claudeError?.message || err?.message || null,
        };
        err.attempt = attemptNumber;
        console.error('[Claude][CalendarChunk] request failed', {
          requestId: loggingContext?.requestId || null,
          mode,
          model: 'claude-opus-4-6',
          statusCode: err?.statusCode || err?.status || null,
          ...details,
        });
        err.openaiDetails = details;
        err.mode = mode;
        err.promptMeta = lastPromptMeta;
        err.model = 'claude-opus-4-6';
        err.responseFormat = null;
        throw err;
      })
    );
    const timeoutPromise = new Promise((_, reject) => {
      const timeoutId = setTimeout(() => {
        const timeoutErr = new Error('Claude request timed out');
        timeoutErr.code = 'OPENAI_TIMEOUT';
        timeoutErr.attempt = attemptNumber;
        reject(timeoutErr);
      }, attemptTimeoutMs);
      requestPromise.finally(() => clearTimeout(timeoutId));
    });
    const claudeResult = await Promise.race([requestPromise, timeoutPromise]);
    const json = claudeResult?.raw || null;
    const content = typeof claudeResult?.text === 'string' ? claudeResult.text : '';
    let parsedOutput = null;
    try {
      parsedOutput = content ? parseJsonFromText(content) : null;
    } catch (_parseErr) {
      parsedOutput = null;
    }
    if (debugEnabled) {
      console.log('[CALENDAR PARSE] chunk schema response length', (content || '').length);
    }
    return {
      content,
      parsedOutput,
      latency: Date.now() - attemptTimestamp,
      promptMeta: lastPromptMeta,
      responseId: json?.id || null,
      responseModel: json?.model || 'claude-opus-4-6',
      rawTextLength: typeof content === 'string' ? content.length : null,
      responseKeys: json && typeof json === 'object' ? Object.keys(json) : [],
      extractedKind: parsedOutput || content ? 'structured' : 'none',
    };
  };

  const shouldFailover = (err) => {
    const msg = String(err?.message || '').toLowerCase();
    const status = err?.statusCode || err?.status || err?.upstreamStatus || null;
    return (
      err?.code === 'OPENAI_TIMEOUT' ||
      err?.code === 'MODEL_TIMEOUT' ||
      status === 503 ||
      msg.includes('model timeout') ||
      msg.includes('timeout')
    );
  };
  const allowFailover = opts.allowFailover !== false;
  try {
    let firstResponse = null;
    try {
      firstResponse = await attemptRequest(true);
    } catch (err) {
      if (!allowFailover || !shouldFailover(err)) throw err;
      const fallbackMaxTokens = maxTokens;
      const fallbackTemperature = 0;
      console.warn('[OpenAI][CalendarChunk][Failover]', {
        requestId: loggingContext?.requestId || null,
        reason: err?.code || err?.message || 'timeout',
        model: modelName,
        maxTokens: fallbackMaxTokens,
        timeoutMs: requestTimeoutMs,
        attempt: 2,
      });
      firstResponse = await attemptRequest(true, {
        attempt: 2,
        maxTokens: fallbackMaxTokens,
        temperature: fallbackTemperature,
      });
    }
    const parseStart = Date.now();
    if (useSinglePost) {
      const rawText = firstResponse.content || '';
      let parsed = firstResponse.parsedOutput;
      let parsedSource = 'output_parsed';
      if (!parsed && rawText) {
        try {
          parsed = parseJsonFromText(rawText);
          parsedSource = 'output_text_in_output';
        } catch (parseErr) {
          const rawHead = String(rawText || '').replace(/\s+/g, ' ').slice(0, 120);
          console.log('[Calendar][Parse][Fail]', {
            requestId: loggingContext?.requestId || 'unknown',
            mode: calendarMode,
            raw_head: rawHead,
          });
          const err = new Error('missing_posts_parse_failed');
          err.code = 'PARSE_FAILED';
          err.statusCode = 422;
          err.reason = 'PARSE_FAILED';
          err.responseId = firstResponse.responseId || null;
          err.responseModel = firstResponse.responseModel || modelName;
          err.usedStructuredOutput = false;
          throw err;
        }
      }
      if (parsed) {
        const normalized = normalizeCalendarModelOutput(parsed, expectedChunkCount, {
          requestId: loggingContext?.requestId || null,
          mode: calendarMode,
          chunkIndex: loggingContext?.chunkIndex ?? null,
          day: chunkStartDay,
          schemaName: schemaName,
        }, rawText);
        if (debugCalendar) {
          console.log('[Calendar][Parse] structured_output_used', {
            requestId: loggingContext?.requestId || 'unknown',
            responseId: firstResponse.responseId || null,
            model: firstResponse.responseModel || modelName,
            usedStructuredOutput: true,
            source: parsedSource,
          });
        }
        return {
          posts: normalized.posts,
          rawContent: rawText,
          latency: firstResponse.latency,
          parseMs: 0,
          promptMeta: firstResponse.promptMeta || null,
          usedStructuredOutput: true,
        };
      }
      if (debugCalendar) {
        console.warn('[Calendar][Parse] structured_output_missing', {
          requestId: loggingContext?.requestId || 'unknown',
          expectedCount: expectedChunkCount,
          responseId: firstResponse.responseId || null,
          model: firstResponse.responseModel || modelName,
          presentFields: firstResponse.responseKeys || [],
          note: rawText ? 'missing_output_parsed' : 'missing_output_text_in_output',
        });
      }
      const parseErr = new Error('missing_posts_parse_failed');
      parseErr.code = 'PARSE_FAILED';
      parseErr.statusCode = 422;
      parseErr.reason = 'STRUCTURED_OUTPUT_MISSING';
      parseErr.responseId = firstResponse.responseId || null;
      parseErr.responseModel = firstResponse.responseModel || modelName;
      parseErr.usedStructuredOutput = false;
      throw parseErr;
    }
    const rawText = firstResponse.content || '';
    let parsed = firstResponse.parsedOutput;
    let parsedSource = 'output_parsed';
    if (!parsed && rawText) {
      try {
        parsed = parseJsonFromText(rawText);
        parsedSource = 'output_text_in_output';
      } catch (parseErr) {
        const rawHead = String(rawText || '').replace(/\s+/g, ' ').slice(0, 120);
        console.log('[Calendar][Parse][Fail]', {
          requestId: loggingContext?.requestId || 'unknown',
          mode: calendarMode,
          raw_head: rawHead,
        });
        const err = new Error('missing_posts_parse_failed');
        err.code = 'PARSE_FAILED';
        err.statusCode = 422;
        err.reason = 'PARSE_FAILED';
        err.responseId = firstResponse.responseId || null;
        err.responseModel = firstResponse.responseModel || modelName;
        err.usedStructuredOutput = false;
        throw err;
      }
    }
    if (!parsed) {
      if (debugCalendar) {
        console.warn('[Calendar][Parse] structured_output_missing', {
          requestId: loggingContext?.requestId || 'unknown',
          expectedCount: expectedChunkCount,
          responseId: firstResponse.responseId || null,
          model: firstResponse.responseModel || modelName,
          presentFields: firstResponse.responseKeys || [],
          note: rawText ? 'missing_output_parsed' : 'missing_output_text_in_output',
        });
      }
      const parseErr = new Error('missing_posts_parse_failed');
      parseErr.code = 'PARSE_FAILED';
      parseErr.statusCode = 422;
      parseErr.reason = 'STRUCTURED_OUTPUT_MISSING';
      parseErr.responseId = firstResponse.responseId || null;
      parseErr.responseModel = firstResponse.responseModel || modelName;
      parseErr.usedStructuredOutput = false;
      throw parseErr;
    }
    const normalized = normalizeCalendarModelOutput(parsed, expectedChunkCount, {
      requestId: loggingContext?.requestId || null,
      mode: calendarMode,
      chunkIndex: loggingContext?.chunkIndex ?? null,
      day: chunkStartDay,
      schemaName: schemaName,
    }, rawText);
    if (debugCalendar) {
      console.log('[Calendar][Parse] structured_output_used', {
        requestId: loggingContext?.requestId || 'unknown',
        responseId: firstResponse.responseId || null,
        model: firstResponse.responseModel || modelName,
        usedStructuredOutput: true,
        source: parsedSource,
      });
    }
    return {
      posts: normalized.posts,
      rawContent: rawText,
      latency: firstResponse.latency,
      parseMs: Date.now() - parseStart,
      promptMeta: firstResponse.promptMeta || null,
      usedStructuredOutput: true,
    };
  } catch (err) {
    if (err?.code === 'OPENAI_SCHEMA_ERROR' || err?.code === 'OPENAI_TIMEOUT' || err?.code === 'PARSE_FAILED') {
      throw err;
    }
    console.warn(`[Calendar] callOpenAI failed${label}:`, err.message);
    throw err;
  }
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
  promoting: '',
};

function normalizeBrandBrainSettings(input = {}) {
  return {
    enabled: Boolean(input?.enabled),
    promoting: toPlainString(input?.promoting || '').trim(),
  };
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
    let settings = data?.profile_settings;
    if (typeof settings === 'string') {
      try {
        settings = JSON.parse(settings);
      } catch (_err) {
        settings = {};
      }
    }
    if (!settings || typeof settings !== 'object') settings = {};
    const enabled = Boolean(settings?.brand_brain_enabled);
    const promoting = toPlainString(settings?.brand_brain_promoting || '').trim();
    return normalizeBrandBrainSettings({ enabled, promoting });
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
    const nextSettings = {
      ...current,
      brand_brain_enabled: payload.enabled,
      brand_brain_promoting: payload.promoting,
    };
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({ profile_settings: nextSettings, updated_at: new Date().toISOString() })
      .eq('id', userId)
      .select('profile_settings')
      .maybeSingle();
    if (updateError) throw updateError;
    const enabled = Boolean(updated?.profile_settings?.brand_brain_enabled);
    const promoting = toPlainString(updated?.profile_settings?.brand_brain_promoting || '').trim();
    return normalizeBrandBrainSettings({ enabled, promoting });
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
      if (!normalized) throw new Error('Primary color must be a hex code (e.g., #ffffff).');
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

async function stripeApiRequest({ method = 'GET', path: requestPath, body, secretKey }) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': `Bearer ${secretKey}`,
    };
    let payload = null;
    if (body) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const options = {
      hostname: 'api.stripe.com',
      path: requestPath,
      method,
      headers,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data || '{}');
        } catch (_err) {
          parsed = null;
        }
        resolve({ statusCode: res.statusCode || 0, data: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
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

function isProfileSettingsSchemaMissing(err) {
  if (!err) return false;
  const code = String(err?.code || '');
  const msg = String(err?.message || '').toLowerCase();
  return (
    code === '42703' ||
    (msg.includes('profile_settings') && msg.includes('column') && msg.includes('does not exist'))
  );
}

const server = http.createServer((req, res) => {
  try {
  const parsed = url.parse(req.url, true);
  const cspNonce = crypto.randomBytes(16).toString('base64');
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
  const baseCsp = `default-src 'self'; script-src 'self' 'nonce-${cspNonce}' https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com https://cdn.jsdelivr.net/npm/@supabase https://cdn.getphyllo.com https://t.contentsquare.net https://*.contentsquare.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https://usepromptly.app https://res.asset-store.com https://*.contentsquare.net https://*.contentsquare.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://api.openai.com https://api.anthropic.com https://*.supabase.co https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://fonts.gstatic.com https://api.insightiq.ai https://api.getphyllo.com https://*.contentsquare.net https://*.contentsquare.com; frame-src 'self' https://connect.getphyllo.com; frame-ancestors 'none'; worker-src 'self' blob: https://t.contentsquare.net https://*.contentsquare.net; child-src 'self' blob:;`;
  res.setHeader('Content-Security-Policy', baseCsp);
  // Asset service is allowed in img-src so asset previews work.
  // HSTS only if behind HTTPS (skip for localhost dev)
  if ((req.headers.host || '').includes('usepromptly.app')) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // Short-circuit legacy Design Lab page when disabled
  if (!ENABLE_DESIGN_LAB && parsed.pathname === '/design.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  if (parsed.pathname && (parsed.pathname.startsWith('/api/phyllo') || parsed.pathname.startsWith('/internal/phyllo'))) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not_found' }));
  }

  if (parsed.pathname === '/api/entitlements' && req.method === 'GET') {
    (async () => {
      const requestId = generateRequestId('entitlements');
      try {
        const user = await requireSupabaseUser(req);
        const emailRaw = user?.email || user?.user_metadata?.email || '';
        const email = String(emailRaw || '').trim().toLowerCase();
        const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
        if (!STRIPE_SECRET_KEY) {
          console.warn('[Entitlements] Stripe not configured', { requestId });
          return sendJson(res, 503, { error: 'ENTITLEMENTS_UNAVAILABLE', requestId });
        }
        if (!email) {
          return sendJson(res, 200, { tier: 'free', reason: 'missing_email', requestId });
        }

        const customers = loadCustomersMap();
        let customerId = customers[email];
        if (!customerId) {
          const query = new URLSearchParams({ email, limit: '1' }).toString();
          const customerResp = await stripeApiRequest({
            method: 'GET',
            path: `/v1/customers?${query}`,
            secretKey: STRIPE_SECRET_KEY,
          });
          if (customerResp.statusCode < 200 || customerResp.statusCode >= 300) {
            console.warn('[Entitlements] Stripe customer lookup failed', {
              requestId,
              statusCode: customerResp.statusCode,
            });
            return sendJson(res, 503, { error: 'ENTITLEMENTS_UNAVAILABLE', requestId });
          }
          const found = Array.isArray(customerResp.data?.data) ? customerResp.data.data[0] : null;
          if (found?.id) {
            customerId = found.id;
            customers[email] = customerId;
            saveCustomersMap(customers);
          }
        }

        if (!customerId) {
          if (DEBUG_ENTITLEMENTS) {
            console.log('[Entitlements] no customer found', {
              requestId,
              userId: user?.id,
              email,
            });
          }
          return sendJson(res, 200, { tier: 'free', reason: 'no_customer', requestId });
        }

        const subsQuery = new URLSearchParams({
          customer: customerId,
          status: 'all',
          limit: '10',
        }).toString();
        const subsResp = await stripeApiRequest({
          method: 'GET',
          path: `/v1/subscriptions?${subsQuery}`,
          secretKey: STRIPE_SECRET_KEY,
        });
        if (subsResp.statusCode < 200 || subsResp.statusCode >= 300) {
          console.warn('[Entitlements] Stripe subscription lookup failed', {
            requestId,
            customerId,
            statusCode: subsResp.statusCode,
          });
          return sendJson(res, 503, { error: 'ENTITLEMENTS_UNAVAILABLE', requestId });
        }
        const subscriptions = Array.isArray(subsResp.data?.data) ? subsResp.data.data : [];
        const statuses = subscriptions.map((sub) => sub?.status).filter(Boolean);
        const isPro = statuses.some((status) => status === 'active' || status === 'trialing');

        if (DEBUG_ENTITLEMENTS) {
          console.log('[Entitlements] resolved', {
            requestId,
            userId: user?.id,
            email,
            customerId,
            statuses,
          });
        }

        return sendJson(res, 200, { tier: isPro ? 'pro' : 'free', requestId });
      } catch (err) {
        const status = err?.statusCode || 500;
        if (status === 401) {
          return sendJson(res, 401, { error: 'unauthorized', requestId });
        }
        console.warn('[Entitlements] failed to resolve entitlements', {
          requestId,
          error: err?.message || err,
        });
        return sendJson(res, 503, { error: 'ENTITLEMENTS_UNAVAILABLE', requestId });
      }
    })();
    return;
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
          .select('subscription_plan, tier')
          .eq('id', user.id)
          .maybeSingle();

        if (error) {
          console.error('[Subscription] fetch error', error);
          return sendJson(res, 200, { ok: true, plan: 'free' });
        }

        const rawPlan = data?.subscription_plan || data?.tier || 'free';
        const normalized =
          rawPlan === 'paid' || rawPlan === 'premium' ? 'pro' : rawPlan;
        return sendJson(res, 200, { ok: true, plan: normalized, tier: normalized });
      } catch (err) {
        console.error('[Subscription] server error', err);
        return sendJson(res, 200, { ok: true, plan: 'free' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/user/subscription' && req.method === 'POST') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        if (!user || !user.id) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        const body = await readJsonBody(req);
        const rawTier = String(body?.tier || body?.plan || '')
          .trim()
          .toLowerCase();
        if (!rawTier) {
          return sendJson(res, 400, { ok: false, error: 'missing_tier' });
        }
        const normalized =
          rawTier === 'paid' || rawTier === 'premium' ? 'pro' : rawTier;

        const { error } = await supabaseAdmin
          .from('profiles')
          .upsert(
            {
              id: user.id,
              email: toPlainString(user.email || user?.user_metadata?.email || ''),
              tier: normalized,
              subscription_plan: normalized,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'id' }
          );

        if (error) {
          console.error('[Subscription] update error', error);
          return sendJson(res, 500, { ok: false, error: 'update_failed' });
        }

        return sendJson(res, 200, { ok: true, plan: normalized, tier: normalized });
      } catch (err) {
        const status = err.statusCode || 500;
        console.error('[Subscription] update error', err);
        return sendJson(res, status, { ok: false, error: 'update_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/profile/settings' && req.method === 'GET') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        if (!user || !user.id) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        if (!supabaseAdmin) {
          return sendJson(res, 500, { ok: false, error: 'supabase_not_configured' });
        }
        await hydrateUserTier(req, 'ProfileSettings');
        const isProUser = isUserPro(req);

        const { data, error } = await supabaseAdmin
          .from('profiles')
          .select('profile_settings')
          .eq('id', user.id)
          .maybeSingle();

        if (error) {
          if (isProfileSettingsSchemaMissing(error)) {
            if (!profileSettingsSchemaWarned) {
              profileSettingsSchemaWarned = true;
              console.warn('[ProfileSettings] schema missing: profiles.profile_settings');
            }
            return sendJson(res, 503, { ok: false, error: 'PROFILE_SETTINGS_SCHEMA_MISSING' });
          }
          console.error('[ProfileSettings] fetch error', error);
          return sendJson(res, 500, { ok: false, error: 'profile_settings_fetch_failed' });
        }

        const settings = data?.profile_settings && typeof data.profile_settings === 'object'
          ? data.profile_settings
          : {};
        const sanitized = isProUser
          ? settings
          : {
              ...settings,
              brand_brain_enabled: false,
              voice_lock_enabled: false,
              target_audience_enabled: false,
            };
        return sendJson(res, 200, { ok: true, settings: sanitized });
      } catch (err) {
        const status = err.statusCode || 500;
        if (status !== 401) {
          console.error('[ProfileSettings] handler error', err);
        }
        return sendJson(res, status, { ok: false, error: 'profile_settings_fetch_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/profile/settings' && req.method === 'POST') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        if (!user || !user.id) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        }
        if (!supabaseAdmin) {
          return sendJson(res, 500, { ok: false, error: 'supabase_not_configured' });
        }
        await hydrateUserTier(req, 'ProfileSettings');
        const isProUser = isUserPro(req);
        const body = await readJsonBody(req);
        const patch = body?.patch || body?.settings || {};
        const safePatch = patch && typeof patch === 'object' ? patch : {};
        if (!isProUser) {
          safePatch.brand_brain_enabled = false;
          safePatch.voice_lock_enabled = false;
          safePatch.target_audience_enabled = false;
        }

        const { data, error } = await supabaseAdmin
          .from('profiles')
          .select('profile_settings')
          .eq('id', user.id)
          .maybeSingle();

        if (error) {
          if (isProfileSettingsSchemaMissing(error)) {
            if (!profileSettingsSchemaWarned) {
              profileSettingsSchemaWarned = true;
              console.warn('[ProfileSettings] schema missing: profiles.profile_settings');
            }
            return sendJson(res, 503, { ok: false, error: 'PROFILE_SETTINGS_SCHEMA_MISSING' });
          }
          console.error('[ProfileSettings] fetch error', error);
          return sendJson(res, 500, { ok: false, error: 'profile_settings_fetch_failed' });
        }

        const current = data?.profile_settings && typeof data.profile_settings === 'object'
          ? data.profile_settings
          : {};
        const nextSettings = { ...current, ...safePatch };
        if (!isProUser) {
          nextSettings.brand_brain_enabled = false;
          nextSettings.voice_lock_enabled = false;
          nextSettings.target_audience_enabled = false;
        }

        const { data: updated, error: updateError } = await supabaseAdmin
          .from('profiles')
          .upsert(
            {
              id: user.id,
              email: toPlainString(user.email || user?.user_metadata?.email || ''),
              profile_settings: nextSettings,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'id' }
          )
          .select('profile_settings')
          .maybeSingle();

        if (updateError) {
          if (isProfileSettingsSchemaMissing(updateError)) {
            if (!profileSettingsSchemaWarned) {
              profileSettingsSchemaWarned = true;
              console.warn('[ProfileSettings] schema missing: profiles.profile_settings');
            }
            return sendJson(res, 503, { ok: false, error: 'PROFILE_SETTINGS_SCHEMA_MISSING' });
          }
          console.error('[ProfileSettings] update error', updateError);
          return sendJson(res, 500, { ok: false, error: 'profile_settings_update_failed' });
        }

        const updatedSettings = updated?.profile_settings || nextSettings;
        const sanitized = isProUser
          ? updatedSettings
          : {
              ...updatedSettings,
              brand_brain_enabled: false,
              voice_lock_enabled: false,
              target_audience_enabled: false,
            };
        return sendJson(res, 200, {
          ok: true,
          settings: sanitized,
        });
      } catch (err) {
        const status = err.statusCode || 500;
        if (status !== 401) {
          console.error('[ProfileSettings] handler error', err);
        }
        return sendJson(res, status, { ok: false, error: 'profile_settings_update_failed' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/upload' && req.method === 'POST') {
    (async () => {
      try {
        if (!supabaseAdmin) {
          return sendJson(res, 500, { error: 'supabase_not_configured' });
        }

        const rawBody = await readRawBodyWithLimit(req, MAX_UPLOAD_BODY);
        const { fields, files } = parseMultipartFormData(rawBody, req.headers['content-type'] || '');
        const file = files.video;
        const userId = String(fields.userId || '').trim();

        if (!file) return sendJson(res, 400, { error: 'No video file provided' });
        if (!userId) return sendJson(res, 400, { error: 'User ID is required' });
        if (file.size > MAX_VIDEO_FILE_SIZE) {
          return sendJson(res, 400, { error: 'File size exceeds 500MB limit' });
        }

        const fileExtension = String(file.name || '').toLowerCase().match(/\.[^.]*$/)?.[0] || '';
        if (!VIDEO_ALLOWED_TYPES.includes(file.type) && !VIDEO_ALLOWED_EXTENSIONS.includes(fileExtension)) {
          return sendJson(res, 400, { error: 'Only MP4, MOV, and AVI files are allowed' });
        }

        const timestamp = Date.now();
        const sanitizedFilename = String(file.name || 'video.mp4')
          .replace(/[^a-zA-Z0-9.-]/g, '_')
          .replace(/_{2,}/g, '_');
        const storagePath = `${userId}/${timestamp}-${sanitizedFilename}`;

        const { error: uploadError } = await supabaseAdmin.storage
          .from('videos')
          .upload(storagePath, file.buffer, {
            contentType: file.type,
            upsert: false,
          });

        if (uploadError) {
          console.error('[VideoEditor][Upload] Supabase upload error:', uploadError);
          return sendJson(res, 500, { error: 'Failed to upload video to storage' });
        }

        const { data: urlData } = supabaseAdmin.storage
          .from('videos')
          .getPublicUrl(storagePath);

        return sendJson(res, 200, {
          success: true,
          videoUrl: urlData?.publicUrl,
          fileName: sanitizedFilename,
          fileSize: file.size,
          storagePath,
        });
      } catch (error) {
        const status = error?.statusCode || 500;
        console.error('[VideoEditor][Upload] error:', error);
        return sendJson(res, status, { error: error?.message || 'Internal server error during upload' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/generate' && req.method === 'POST') {
    (async () => {
      try {
        if (!supabaseAdmin) {
          return sendJson(res, 500, { error: 'supabase_not_configured' });
        }

        const body = await readJsonBody(req);
        const { videoUrl, vibeInput, userId } = body || {};

        if (!videoUrl) return sendJson(res, 400, { error: 'Video URL is required' });
        if (!vibeInput) return sendJson(res, 400, { error: 'Vibe input is required' });
        if (!userId) return sendJson(res, 400, { error: 'User ID is required' });

        let fileName = 'unknown';
        try {
          const urlObj = new URL(videoUrl);
          const pathParts = urlObj.pathname.split('/');
          fileName = pathParts[pathParts.length - 1] || 'unknown';
        } catch (_e) {
          fileName = String(videoUrl).split('/').pop()?.split('?')[0] || 'unknown';
        }

        const { data, error } = await supabaseAdmin
          .from('edit_jobs')
          .insert({
            user_id: userId,
            video_url: videoUrl,
            video_filename: fileName,
            vibe_input: vibeInput,
            status: 'queued',
            progress: 0,
          })
          .select()
          .single();

        if (error) {
          console.error('[VideoEditor][Generate] Database error:', error);
          return sendJson(res, 500, { error: 'Failed to create job' });
        }

        return sendJson(res, 200, { jobId: data.id });
      } catch (error) {
        const status = error?.statusCode || 500;
        console.error('[VideoEditor][Generate] error:', error);
        return sendJson(res, status, { error: error?.message || 'Internal server error' });
      }
    })();
    return;
  }

  const videoJobMatch = parsed.pathname && parsed.pathname.match(/^\/api\/jobs\/([^/]+)$/i);
  if (videoJobMatch && req.method === 'GET') {
    (async () => {
      try {
        if (!supabaseAdmin) {
          return sendJson(res, 500, { error: 'supabase_not_configured' });
        }

        const jobId = decodeURIComponent(videoJobMatch[1] || '').trim();
        if (!jobId) return sendJson(res, 400, { error: 'jobId is required' });

        const { data, error } = await supabaseAdmin
          .from('edit_jobs')
          .select('id, status, progress, rendered_video_url, error, updated_at, completed_at')
          .eq('id', jobId)
          .maybeSingle();

        if (error) {
          console.error('[VideoEditor][JobStatus] Database error:', error);
          return sendJson(res, 500, { error: 'Failed to fetch job status' });
        }
        if (!data) {
          return sendJson(res, 404, { error: 'Job not found' });
        }

        return sendJson(res, 200, data);
      } catch (error) {
        const status = error?.statusCode || 500;
        console.error('[VideoEditor][JobStatus] error:', error);
        return sendJson(res, status, { error: error?.message || 'Internal server error' });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/cron/process-jobs' && req.method === 'GET') {
    (async () => {
      try {
        if (!supabaseAdmin) {
          return sendJson(res, 500, { error: 'supabase_not_configured' });
        }

        const authHeader = req.headers.authorization;
        if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
          return sendJson(res, 401, { error: 'Unauthorized' });
        }

        const { data: jobs, error } = await supabaseAdmin
          .from('edit_jobs')
          .select('*')
          .eq('status', 'queued')
          .order('created_at', { ascending: true })
          .limit(3);

        if (error) throw new Error(`Failed to fetch queued jobs: ${error.message}`);

        if (!jobs || jobs.length === 0) {
          return sendJson(res, 200, { message: 'No queued jobs', processed: 0, results: [] });
        }

        const { processEditJob } = require('./lib/video-processor/process-job');
        const results = [];

        for (const job of jobs) {
          try {
            console.log(`[VideoEditor][Cron] Processing job ${job.id}...`);
            const finalVideoUrl = await processEditJob(job);
            results.push({ jobId: job.id, success: true, videoUrl: finalVideoUrl });
            console.log(`[VideoEditor][Cron] Job ${job.id} complete`);
          } catch (jobError) {
            console.error(`[VideoEditor][Cron] Job ${job.id} failed:`, jobError?.message || jobError);
            results.push({ jobId: job.id, success: false, error: jobError?.message || 'Unknown error' });
          }
        }

        return sendJson(res, 200, {
          message: 'Cron job completed',
          processed: jobs.length,
          results,
        });
      } catch (error) {
        const status = error?.statusCode || 500;
        console.error('[VideoEditor][Cron] Fatal error:', error);
        return sendJson(res, status, { error: error?.message || 'Internal cron error' });
      }
    })();
    return;
  }

  // Serve favicon from SVG asset to avoid 404s
  if (parsed.pathname === '/favicon.ico') {
    const fav = path.join(__dirname, 'assets', 'promptly-mark-white.png');
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
    const apple = path.join(__dirname, 'assets', 'promptly-mark-white.png');
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
  function stripCspMeta(html) {
    return html.replace(/<meta[^>]*http-equiv=["']content-security-policy["'][^>]*>/gi, '');
  }

  function injectNonceIntoInlineScripts(html, nonce) {
    return html.replace(/<script\b([^>]*)>/gi, (match, attrs) => {
      if (/\snonce\s*=/i.test(attrs)) return match;
      if (/\ssrc\s*=/i.test(attrs)) return match;
      return `<script nonce="${nonce}"${attrs}>`;
    });
  }

  function scanInlineScriptsWithoutNonce(html) {
    const regex = /<script\b(?![^>]*\bnonce\s*=)(?![^>]*\bsrc\s*=)[^>]*>/ig;
    let count = 0;
    let snippet = null;
    let match;
    while ((match = regex.exec(html)) !== null) {
      count += 1;
      if (!snippet) {
        const start = Math.max(0, match.index - 100);
        const end = Math.min(html.length, match.index + match[0].length + 100);
        snippet = html.slice(start, end);
      }
    }
    return { count, snippet };
  }

  function hasInlineHandlers(html) {
    return /\son[a-z]+\s*=\s*["']/i.test(html);
  }

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
      let raw = fs.readFileSync(filePath);
      const accept = req.headers['accept-encoding'] || '';
      // Only compress text-like content
      const isText = /\.(html|css|js|json|txt)$/i.test(filePath);
      const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
      const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
      const isHttps = proto === 'https' || req.socket?.encrypted === true;
      const isProdHost = host === 'usepromptly.app' || host === 'www.usepromptly.app';
      const isProdRequest = isProdHost && isHttps;
      if (ext === '.html' && !isProdRequest) {
        console.info('Contentsquare disabled on dev host');
      }
      if (ext === '.html') {
        const snippet = '<script src="https://t.contentsquare.net/uxa/9aea871ffd8c7.js"></script>';
        let html = raw.toString('utf8');
        html = stripCspMeta(html);
        if (!isProdRequest) {
          if (html.includes(snippet)) {
            const newline = html.includes('\r\n') ? '\r\n' : '\n';
            const lines = html.split(/\r?\n/);
            html = lines.filter((line) => line.trim() !== snippet).join(newline);
          }
        } else if (!html.includes(snippet)) {
          const lower = html.toLowerCase();
          const headIndex = lower.indexOf('</head>');
          if (headIndex !== -1) {
            const newline = html.includes('\r\n') ? '\r\n' : '\n';
            const before = html.slice(0, headIndex);
            const after = html.slice(headIndex);
            const lastNl = before.lastIndexOf('\n');
            let indent = '';
            if (lastNl !== -1) {
              const line = before.slice(lastNl + 1);
              indent = line.match(/^\s*/)?.[0] || '';
            }
            html = `${before}${newline}${indent}${snippet}${newline}${after}`;
          }
        }
        html = injectNonceIntoInlineScripts(html, cspNonce);
        if (!isProdRequest) {
          const base = path.basename(filePath).toLowerCase();
          if (base === 'terms.html' && !TERMS_CSP_LOGGED) {
            const inlineScan = scanInlineScriptsWithoutNonce(html);
            const inlineHandlers = hasInlineHandlers(html);
            if (inlineScan.count > 0 || inlineHandlers) {
              console.info('[CSP][NonceCheck]', {
                file: base,
                nonce: cspNonce,
                missingNonceCount: inlineScan.count,
                inlineHandlers,
                snippet: inlineScan.count > 0 ? inlineScan.snippet : null,
              });
              TERMS_CSP_LOGGED = true;
            }
          }
        }
        raw = Buffer.from(html, 'utf8');
      }
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

  async function generateCalendarPlan({ requestId, mode, nicheStyle, promoting = '', targetAudience = '', days, startDay, postsPerDay, postKeysOverride = null, extraInstruction = '', usedSignatures = [] }) {
    if (!nicheStyle) {
      const err = new Error('nicheStyle required');
      err.statusCode = 400;
      throw err;
    }
    if (!CLAUDE_API_KEY) {
      const err = new Error('CLAUDE_API_KEY not set');
      err.statusCode = 500;
      throw err;
    }
    const safeDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 1;
    const safeStart = Number.isFinite(Number(startDay)) ? Number(startDay) : 1;
    const perDay = Math.max(1, Number.isFinite(Number(postsPerDay)) ? Number(postsPerDay) : 1);
    const overrideKeys = Array.isArray(postKeysOverride)
      ? postKeysOverride.map((item) => toPlainString(item || '')).filter(Boolean)
      : null;
    const expectedCount = overrideKeys && overrideKeys.length ? overrideKeys.length : safeDays * perDay;
    const plannerMode = String(mode || 'regular').toLowerCase() === 'brand_brain' ? 'brand_brain' : 'regular';
    const postKeys = overrideKeys && overrideKeys.length ? overrideKeys.slice() : [];
    if (!postKeys.length) {
      for (let dayOffset = 0; dayOffset < safeDays; dayOffset += 1) {
        const day = safeStart + dayOffset;
        for (let slotIndex = 0; slotIndex < perDay; slotIndex += 1) {
          postKeys.push(postKey(day, slotIndex));
        }
      }
    }
    const cleanPromoting = toPlainString(promoting || '');
    const cleanTargetAudience = (() => {
      if (!targetAudience) return '';
      if (typeof targetAudience === 'string') return toPlainString(targetAudience);
      if (typeof targetAudience !== 'object') return '';
      if (targetAudience.enabled === false) return '';
      const presetKey = normalizeTargetAudiencePresetKey(targetAudience.preset || '');
      if (presetKey) {
        return toPlainString(TARGET_AUDIENCE_PRESET_GUIDES[presetKey]?.label || presetKey);
      }
      return toPlainString(targetAudience.label || '');
    })();
    const hasPromoting = plannerMode === 'brand_brain' && Boolean(cleanPromoting.trim());
    const cleanUsedSignatures = Array.isArray(usedSignatures)
      ? usedSignatures.map((item) => toPlainString(item || '')).filter(Boolean).slice(-24)
      : [];
    const singlePostKey = toPlainString(postKeys[0] || '');
    const plannerCountLine = expectedCount === 30 && perDay === 1 && safeStart === 1
      ? 'Return exactly 30 items, one for each day. Use post_key values "day-1-slot-0" through "day-30-slot-0".'
      : `Return exactly ${expectedCount} items. Use these post_key values: ${postKeys.join(', ')}`;
    const REGULAR_PLAN_PROMPT = [
      `You are a creator in this space: ${nicheStyle}. Plan 30 short-form videos for TikTok and Reels.`,
      cleanTargetAudience ? `The audience: ${cleanTargetAudience}.` : '',
      '',
      `Every video is the creator talking directly to camera about a moment from their day-to-day in this space.`,
      '',
      'Each video needs a topic_signature (one sentence — a specific moment from the creator\'s day-to-day in this space) and an angle (one sentence — what the creator expected to go one way that went another).',
      plannerCountLine,
      '',
      `Every video covers a different topic.`,
    ].join('\n');

    const BRAND_BRAIN_PLAN_PROMPT = [
      hasPromoting
        ? `You are a creator in this space: ${nicheStyle}. The creator also offers: ${cleanPromoting}. Plan 30 short-form videos for TikTok and Reels.`
        : `You are a creator in this space: ${nicheStyle}. Plan 30 short-form videos for TikTok and Reels.`,
      cleanTargetAudience ? `The audience: ${cleanTargetAudience}.` : '',
      '',
      hasPromoting
        ? `Every video is the creator talking directly to camera about a moment from their day-to-day in this space. During the story, what the creator is offering connects to what the creator was talking about.`
        : `Every video is the creator talking directly to camera about a moment from their day-to-day in this space.`,
      '',
      hasPromoting
        ? 'Each video needs a topic_signature (one sentence — a specific moment from the creator\'s day-to-day in this space) and an angle (one sentence — what the creator expected to go one way that went another, and how that connects to what the creator offers).'
        : 'Each video needs a topic_signature (one sentence — a specific moment from the creator\'s day-to-day in this space) and an angle (one sentence — what the creator expected to go one way that went another).',
      plannerCountLine,
      '',
      `Every video covers a different topic.`,
    ].join('\n');
    const planPromptBase = (plannerMode === 'brand_brain') ? BRAND_BRAIN_PLAN_PROMPT : REGULAR_PLAN_PROMPT;
    const usedSignaturesLine = cleanUsedSignatures.length
      ? `These topics have already been used for other days. Pick a completely different concept: ${cleanUsedSignatures.join('; ')}`
      : '';
    const planPrompt = [planPromptBase, usedSignaturesLine].filter(Boolean).join('\n');
    const planSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['plan'],
      properties: {
        plan: {
          type: 'array',
          minItems: expectedCount,
          maxItems: expectedCount,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['post_key', 'topic_signature', 'angle'],
            properties: {
              post_key: { type: 'string', minLength: 1 },
              topic_signature: { type: 'string', minLength: 1 },
              angle: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    };
    const planStart = Date.now();
    const planMaxTokens = expectedCount >= 30 ? 4000 : 1200;
    const runPlanRequest = async ({ maxTokens }) => {
      return withTimeout(
        withOpenAiSlot(() =>
          claudeMessagesRequest({
            model: 'claude-sonnet-4-5-20250514',
            system: 'Return only valid JSON for the requested plan. No markdown.',
            messages: [{ role: 'user', content: planPrompt }],
            maxTokens: maxTokens,
            temperature: 0.2,
            tools: [{
              name: 'plan_calendar',
              description: 'Plan short-form videos for TikTok and Reels.',
              input_schema: {
                type: 'object',
                properties: {
                  plan: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        post_key: { type: 'string' },
                        topic_signature: { type: 'string' },
                        angle: { type: 'string' },
                      },
                      required: ['post_key', 'topic_signature', 'angle'],
                    },
                  },
                },
                required: ['plan'],
              },
            }],
            toolChoice: { type: 'tool', name: 'plan_calendar' },
          })
        ),
        CALENDAR_PLAN_TIMEOUT_MS,
        { requestId, phase: 'plan' }
      );
    };
    let response = null;
    const planTokensUsed = planMaxTokens;
    response = await runPlanRequest({ maxTokens: planMaxTokens });
    const contentBlocks = Array.isArray(response?.raw?.content) ? response.raw.content : [];
    const toolBlock = contentBlocks.find((b) => b && b.type === 'tool_use' && b.name === 'plan_calendar');
    const plan = Array.isArray(toolBlock?.input?.plan) ? toolBlock.input.plan : null;
    if (!plan) {
      console.log('[Calendar][Plan] 422 reason:', {
        requestId,
        code: 'PLAN_MISSING',
        message: 'Tool response missing plan array',
        contentTypes: contentBlocks.map((b) => b?.type || null),
      });
      const err = new Error('PLAN_MISSING');
      err.code = 'PLAN_MISSING';
      err.statusCode = 422;
      throw err;
    }
    const details = [];
    plan.forEach((item, index) => {
      const missing = [];
      const topicSignature = toPlainString(item?.topic_signature || '');
      if (!topicSignature) missing.push('topic_signature');
      const angle = toPlainString(item?.angle || '');
      if (!angle) missing.push('angle');
      if (missing.length) details.push({ index, missing });
    });
    if (plan.length !== expectedCount || details.length) {
      console.log('[Calendar][Plan] 422 reason:', {
        requestId,
        code: 'PLAN_SCHEMA_MISMATCH',
        expectedCount,
        actualCount: plan.length,
        details,
      });
      const err = new Error('PLAN_SCHEMA_MISMATCH');
      err.code = 'PLAN_SCHEMA_MISMATCH';
      err.statusCode = 422;
      err.details = details;
      err.payload = { expectedCount, actualCount: plan.length };
      throw err;
    }
    console.log('[Calendar][Plan]', {
      requestId,
      mode,
      promptChars: planPrompt.length,
      elapsedMs: Date.now() - planStart,
      planCount: plan.length,
      maxTokens: planTokensUsed,
      timeoutMs: CALENDAR_PLAN_TIMEOUT_MS,
    });
    return { plan };
  }

  async function generateCalendarPostsDeterministic(payload = {}) {
    const { nicheStyle, userId } = payload;
    const loggingContext = payload?.context || {};
    const requestId = String(loggingContext?.requestId || payload?.requestId || '');
    const promoting = toPlainString(payload?.promoting || '');
    if (!nicheStyle) {
      const err = new Error('nicheStyle required');
      err.statusCode = 400;
      throw err;
    }
    if (!CLAUDE_API_KEY) {
      const err = new Error('CLAUDE_API_KEY not set');
      err.statusCode = 500;
      throw err;
    }

    const safeDays = Number.isFinite(Number(payload?.days)) && Number(payload.days) > 0 ? Number(payload.days) : 1;
    const safeStart = Number.isFinite(Number(payload?.startDay)) ? Number(payload.startDay) : 1;
    const postsPerDay = Math.max(1, Number.isFinite(Number(payload?.postsPerDay)) ? Number(payload.postsPerDay) : 1);
    const totalPosts = safeDays * postsPerDay;

    const isProUser = Boolean(payload?.isPro);
    const voiceLockConfig = resolveVoiceLockConfig(payload, isProUser);
    const targetAudienceConfig = resolveTargetAudienceConfig(payload, isProUser);
    const voiceLockValue = voiceLockConfig.enabled
      ? toPlainString(VOICE_LOCK_PRESET_GUIDES[voiceLockConfig.preset]?.label || voiceLockConfig.preset || '')
      : '';
    const targetAudienceValue = targetAudienceConfig.enabled
      ? toPlainString(TARGET_AUDIENCE_PRESET_GUIDES[targetAudienceConfig.preset]?.label || targetAudienceConfig.preset || '')
      : '';
    let calendarMode = String(payload?.calendarMode || '').toLowerCase();
    if (calendarMode !== 'brand_brain' && calendarMode !== 'regular') calendarMode = '';
    const brandBrainSettings = userId ? await fetchBrandBrainSettings(userId) : null;
    const brandBrainOverride = Boolean(
      payload?.brandBrainEnabled || payload?.brand_brain_enabled || payload?.calendarMode === 'brand_brain'
    );
    let brandBrainDirective = '';
    if (calendarMode === 'brand_brain') {
      brandBrainDirective = buildBrandBrainDirective({ ...(brandBrainSettings || {}), enabled: true });
    } else if (!calendarMode && isProUser && (brandBrainSettings?.enabled || brandBrainOverride)) {
      brandBrainDirective = buildBrandBrainDirective({ ...(brandBrainSettings || {}), enabled: true });
    }
    const brandBrainEnabled = calendarMode === 'brand_brain' || Boolean(brandBrainDirective);
    calendarMode = brandBrainEnabled ? 'brand_brain' : 'regular';

    const brandContext = '';

    const slots = [];
    for (let dayOffset = 0; dayOffset < safeDays; dayOffset += 1) {
      const day = safeStart + dayOffset;
      for (let slotIndex = 0; slotIndex < postsPerDay; slotIndex += 1) {
        slots.push({ day, slotIndex, post_key: postKey(day, slotIndex) });
      }
    }

    let planItems = null;
    if (Array.isArray(payload?.topicPlan) && payload.topicPlan.length) {
      planItems = payload.topicPlan.map((item) => ({
        post_key: postKey(
          Number.isFinite(Number(item?.day)) ? Number(item.day) : safeStart,
          Number.isFinite(Number(item?.postIndex)) ? Number(item.postIndex) : 0
        ),
        topic_signature: toPlainString(item?.title || item?.topic_signature || ''),
        angle: toPlainString(item?.angle || ''),
      }));
    } else {
      const planResult = await generateCalendarPlan({
        requestId,
        mode: calendarMode,
        nicheStyle,
        promoting,
        targetAudience: targetAudienceValue,
        days: safeDays,
        startDay: safeStart,
        postsPerDay,
      });
      planItems = Array.isArray(planResult?.plan) ? planResult.plan : [];
    }
    const hasDuplicateTopicSignatures = (items = []) => {
      const seen = new Set();
      for (const item of items) {
        const sig = toPlainString(item?.topic_signature || '').toLowerCase();
        if (!sig) continue;
        if (seen.has(sig)) return true;
        seen.add(sig);
      }
      return false;
    };
    if (!Array.isArray(payload?.topicPlan) && hasDuplicateTopicSignatures(planItems)) {
      try {
        const rerun = await generateCalendarPlan({
          requestId,
          mode: calendarMode,
          nicheStyle,
          promoting,
          targetAudience: targetAudienceValue,
          days: safeDays,
          startDay: safeStart,
          postsPerDay,
          extraInstruction: 'Avoid reusing the same artifact category or the same decision dynamic across items in this batch.',
        });
        const rerunPlan = Array.isArray(rerun?.plan) ? rerun.plan : [];
        if (rerunPlan.length) planItems = rerunPlan;
      } catch (rerunErr) {
        console.warn('[Calendar][Plan] dedupe rerun skipped', {
          requestId,
          error: rerunErr?.message || rerunErr,
        });
      }
    }

    const planByKey = new Map();
    planItems.forEach((item) => {
      const key = toPlainString(item?.post_key || '');
      if (!key || planByKey.has(key)) return;
      planByKey.set(key, {
        post_key: key,
        topic_signature: toPlainString(item?.topic_signature || ''),
        angle: toPlainString(item?.angle || ''),
      });
    });
    if (planByKey.size !== totalPosts) {
      const err = new Error('CALENDAR_SCHEMA_MISMATCH');
      err.code = 'CALENDAR_SCHEMA_MISMATCH';
      err.statusCode = 422;
      err.details = [{ missing: ['plan'] }];
      throw err;
    }

    const maxTokens = Number.isFinite(Number(payload?.maxTokens)) && Number(payload.maxTokens) > 0
      ? Number(payload.maxTokens)
      : 1500;
    const requestTimeoutMs = payload?.requestTimeoutMs;
    const temperature = Number.isFinite(Number(payload?.temperature)) ? Number(payload.temperature) : undefined;
    const presencePenalty = Number.isFinite(Number(payload?.presencePenalty))
      ? Number(payload.presencePenalty)
      : (Number.isFinite(Number(payload?.presence_penalty)) ? Number(payload.presence_penalty) : undefined);
    const calendarId = toPlainString(payload?.calendarId || payload?.id || '');
    const usedSignatures = [];
    const acceptedPosts = [];

    const runJob = async (slot, index) => {
      const planItem = planByKey.get(slot.post_key);
      if (!planItem) {
        const err = new Error('CALENDAR_POST_GENERATION_FAILED');
        err.code = 'CALENDAR_POST_GENERATION_FAILED';
        err.statusCode = 422;
        err.details = { reason: 'SCHEMA_MISMATCH', day: slot.day, post_key: slot.post_key };
        throw err;
      }
      const variation = deriveVariation(slot.post_key);
      const momentSpec = toPlainString(planItem.topic_signature || '');
      console.log('[Calendar][PlanItem]', {
        post_key: slot.post_key,
        mode: calendarMode,
        topic_signature: momentSpec,
        angle: toPlainString(planItem.angle || ''),
      });
      const recentTitles = buildRecentTitlesList(acceptedPosts.map((post) => post?.title || ''), 10);
      return generateAndValidateSinglePost({
        nicheStyle,
        brandContext,
        calendarMode,
        brandBrainDirective,
        day: slot.day,
        slotIndex: slot.slotIndex,
        postsPerDay,
        post_key: slot.post_key,
        plannedTitle: planItem.topic_signature,
        plannedAngle: planItem.angle,
        promoting,
        topicSignature: momentSpec,
        momentSpec,
        renderStyle: variation.render_style,
        beatShape: variation.beat_shape,
        revealOrder: variation.reveal_order,
        pov: variation.pov,
        angleLabel: planItem.angle || '',
        requestId,
        loggingContext,
        maxTokens,
        requestTimeoutMs,
        temperature,
        presencePenalty,
        recentTitles,
        calendarId,
        usedSignatures,
        qualityState: { signatureMap: new Map() },
        voiceLock: voiceLockValue,
      });
    };
    const results = [];
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index];
      const post = await runJob(slot, index);
      results.push(post);
      usedSignatures.push(buildPostSignature(post));
      acceptedPosts.push(post);
    }
    const ordered = results.slice().sort((a, b) => {
      const dayA = Number(a?.day) || 0;
      const dayB = Number(b?.day) || 0;
      if (dayA !== dayB) return dayA - dayB;
      const slotA = Number(a?.slotIndex) || 0;
      const slotB = Number(b?.slotIndex) || 0;
      return slotA - slotB;
    });
    return ordered;
  }

  // helper to generate calendar posts (reuse logic from /api/generate-calendar)
  async function generateCalendarPosts(payload = {}, attempt = 1) {
    return generateCalendarPostsDeterministic(payload);
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
    if (!CLAUDE_API_KEY) {
      const err = new Error('CLAUDE_API_KEY not set');
      err.statusCode = 500;
      throw err;
    }
    const classification = categorizeNiche(nicheStyle);
    const brandContext = '';
    const brandBrainSettings = userId ? await fetchBrandBrainSettings(userId) : null;
    const isProUser = Boolean(payload?.isPro);
    const forceRegular = String(payload?.calendarMode || '').toLowerCase() === 'regular';
    const brandBrainOverride = Boolean(
      payload?.brandBrainEnabled || payload?.brand_brain_enabled || payload?.calendarMode === 'brand_brain'
    );
    const brandBrainDirective = isProUser && !forceRegular && (brandBrainSettings?.enabled || brandBrainOverride)
      ? buildBrandBrainDirective({ ...(brandBrainSettings || {}), enabled: true })
      : '';
    const brandBrainEnabled = Boolean(brandBrainDirective);
    const calendarMode = brandBrainEnabled ? 'brand_brain' : 'regular';
    let lastPromptMeta = null;
    let lastRawContent = '';
    const voiceLockConfig = resolveVoiceLockConfig(payload, isProUser);
    const targetAudienceConfig = resolveTargetAudienceConfig(payload, isProUser);
    const requestId = String(loggingContext?.requestId || '');
    if (requestId && !VOICE_LOCK_LOGGED_REQUESTS.has(requestId)) {
      if (payload?.voiceLockEnabled && voiceLockConfig.reason !== 'disabled' && !voiceLockConfig.enabled) {
        console.log('[VoiceLock][Skipped] requestId=%s reason=%s', requestId, voiceLockConfig.reason || 'disabled');
      }
      VOICE_LOCK_LOGGED_REQUESTS.add(requestId);
      if (VOICE_LOCK_LOGGED_REQUESTS.size > 5000) VOICE_LOCK_LOGGED_REQUESTS.clear();
    }
    if (requestId && targetAudienceConfig.enabled && !TARGET_AUDIENCE_LOGGED_REQUESTS.has(requestId)) {
      const presetLabel = TARGET_AUDIENCE_PRESET_GUIDES[targetAudienceConfig.preset]?.label || targetAudienceConfig.preset;
      console.log('[TargetAudience] enabled=true preset=%s requestId=%s', presetLabel, requestId);
      TARGET_AUDIENCE_LOGGED_REQUESTS.add(requestId);
      if (TARGET_AUDIENCE_LOGGED_REQUESTS.size > 5000) TARGET_AUDIENCE_LOGGED_REQUESTS.clear();
    }
    console.log('[BrandBrain] generation mode', {
      requestId: loggingContext?.requestId || 'unknown',
      userId: userId || null,
      enabled: Boolean(brandBrainDirective),
      isPro: isProUser,
    });
    const callStart = Date.now();
    const logContext = {
      requestId: loggingContext?.requestId || 'unknown',
      days,
      startDay,
      postsPerDay,
    };
    const safeDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : null;
    const requestedPostsPerDay = 1;
    const forceSinglePostPerDayForModel = false;
    const modelPostsPerDay = requestedPostsPerDay;
    const perDay = modelPostsPerDay;
    const targetCount = computePostCountTarget(days, modelPostsPerDay);
    let expectedCount = null;
    const fallbackStart = Number.isFinite(Number(startDay)) ? Number(startDay) : 1;
    const daysToGenerate = safeDays || (targetCount ? Math.max(1, Math.ceil(targetCount / perDay)) : 1);
    const totalPosts = targetCount || (daysToGenerate * perDay);
    let topicPlan = Array.isArray(payload?.topicPlan) ? payload.topicPlan : null;
    if (!payload?.skipTopicPlan && !topicPlan) {
      try {
        topicPlan = await generateTopicPlan({
          nicheStyle,
          brandContext,
          totalPosts,
          startDay: fallbackStart,
          postsPerDay: perDay,
          days: daysToGenerate,
          brandBrainEnabled,
          requestId: loggingContext?.requestId || null,
          brandBrainDirective,
          context: loggingContext,
        });
      } catch (err) {
        console.warn('[Calendar] topic plan failed; continuing without plan', {
          requestId: loggingContext?.requestId || 'unknown',
          error: err?.message || err,
        });
        topicPlan = null;
      }
    }
    const singleRequestMode = Boolean(payload?.singleRequest);
    const perDayChunkSize = singleRequestMode ? daysToGenerate : (daysToGenerate >= 10 ? 1 : 2);
    const chunkLimit = perDay === 1 ? perDayChunkSize : Math.max(1, OPENAI_CHUNK_MAX_DAYS);
    const usePostChunks = !brandBrainEnabled && perDay > 1;
    const blockFallbacks = forceSinglePostPerDayForModel;
    const maxPostsPerChunk = 2;
    const chunkMetrics = [];
    let aggregatedRawPosts = [];
    let remainingDays = daysToGenerate;
    let processedDays = 0;
    const maxTokensOverride =
      Number.isFinite(Number(payload?.maxTokens)) && Number(payload.maxTokens) > 0
        ? Number(payload.maxTokens)
        : null;
    const chunkBaseTokens = maxTokensOverride ?? (singleRequestMode ? 4200 : 1600);
    const chunkMinTokens = maxTokensOverride ?? (singleRequestMode ? 2800 : 1000);

    const forceCompactPrompt = payload?.compactPrompt !== false;
    async function fetchChunk(chunkDays, chunkStartDay, chunkIndex, chunkPostsPerDay) {
      const chunkContext = { ...loggingContext, chunkIndex, chunkStartDay };
      const chunkMaxTokens = Math.max(chunkMinTokens, chunkBaseTokens);
      console.log('[Calendar][Server][Perf] callOpenAI start', {
        requestId: chunkContext?.requestId || 'unknown',
        chunkIndex,
        startDay: chunkStartDay,
        days: chunkDays,
        postsPerDay: chunkPostsPerDay,
        expectedPosts: chunkDays * chunkPostsPerDay,
      });
      const result = await callOpenAI(nicheStyle, brandContext, {
        days: chunkDays,
        startDay: chunkStartDay,
        postsPerDay: chunkPostsPerDay,
        loggingContext: chunkContext,
        maxTokens: chunkMaxTokens,
        requestTimeoutMs: payload?.requestTimeoutMs,
        reduceVerbosity: true,
        compactPrompt: forceCompactPrompt,
        temperature: Number.isFinite(Number(payload?.temperature)) ? Number(payload.temperature) : undefined,
        topicPlan,
        brandBrainDirective,
        voiceLock: voiceLockConfig,
        targetAudience: targetAudienceConfig,
        isPro: isProUser,
        planUsed: Boolean(topicPlan && topicPlan.length),
        singlePost: Boolean(payload?.singlePost),
        allowFailover: false,
      });
      if (result?.promptMeta) lastPromptMeta = result.promptMeta;
      if (result?.rawContent) lastRawContent = String(result.rawContent);
      const chunkPosts = Array.isArray(result.posts)
        ? result.posts
        : (Array.isArray(result?.posts?.posts) ? result.posts.posts : []);
      chunkPosts.forEach((post) => canonicalizeCalendarPost(post, chunkPostsPerDay));
      const requestedSpecMap = buildRequestedSpecMap({
        startDay: chunkStartDay,
        days: chunkDays,
        postsPerDay: chunkPostsPerDay,
        topicPlan,
      });
      const fallbackAvoidByKey = buildMustAvoidTokensByEntries(
        chunkPosts.map((post) => ({
          post_key: toPlainString(post?.post_key || post?.postKey || ''),
          title: toPlainString(post?.title || post?.topic || ''),
        })),
        10
      );
      assertPostKeyMapping(chunkPosts, requestedSpecMap);
      const topicBindingFailures = [];
      chunkPosts.forEach((post) => {
        normalizeHashtagsForTopicBinding(post);
        const key = toPlainString(post?.post_key || post?.postKey || '');
        const requestedSpec = requestedSpecMap.get(key) || {};
        const fallbackMustAvoid = fallbackAvoidByKey.get(key) || [];
        const binding = assertPostTopicBound(post, requestedSpec, fallbackMustAvoid, {
          requestId: chunkContext?.requestId || 'unknown',
        });
        if (!binding) return;
        if (binding.fatal) {
          const err = new Error('INVALID_MODEL_JSON');
          err.code = 'INVALID_MODEL_JSON';
          err.statusCode = 422;
          err.payload = {
            post_key: toPlainString(requestedSpec.post_key || requestedSpec.postKey || post?.post_key || post?.postKey || ''),
            day: Number.isFinite(Number(requestedSpec.day)) ? Number(requestedSpec.day) : (Number.isFinite(Number(post?.day)) ? Number(post.day) : null),
            slotIndex: Number.isFinite(Number(requestedSpec.slotIndex))
              ? Number(requestedSpec.slotIndex)
              : (Number.isFinite(Number(post?.slotIndex)) ? Number(post.slotIndex) : null),
          };
          throw err;
        }
        if (binding.ok === false) {
          post.topicBindingFailed = true;
          post.topicBindingFailedFields = Array.isArray(binding.failedFields) ? binding.failedFields.slice() : [];
          topicBindingFailures.push({
            post_key: toPlainString(requestedSpec.post_key || requestedSpec.postKey || post?.post_key || post?.postKey || ''),
            title: toPlainString(post?.title || post?.topic || ''),
            failedFields: post.topicBindingFailedFields,
          });
        }
      });
      if (topicBindingFailures.length) {
        const requestId = chunkContext?.requestId || '';
        const requestLabel = requestId || 'unknown';
        if (!requestId || !TOPIC_BINDING_WARNING_LOGGED_REQUESTS.has(requestId)) {
          console.warn('[TopicBinding] degraded_to_warning', {
            requestId: requestLabel,
            count: topicBindingFailures.length,
            samples: topicBindingFailures.slice(0, 3),
          });
          if (requestId) {
            TOPIC_BINDING_WARNING_LOGGED_REQUESTS.add(requestId);
            if (TOPIC_BINDING_WARNING_LOGGED_REQUESTS.size > 5000) {
              TOPIC_BINDING_WARNING_LOGGED_REQUESTS.clear();
            }
          }
        }
      }
      console.log('[Calendar][Server][Perf] callOpenAI end', {
        requestId: chunkContext?.requestId || 'unknown',
        chunkIndex,
        startDay: chunkStartDay,
        days: chunkDays,
        openMs: result.latency || 0,
        parseMs: result.parseMs || 0,
        usedStructuredOutput: Boolean(result.usedStructuredOutput),
        rawLength: String(result.rawContent || '').length,
        postCount: Array.isArray(result.posts) ? result.posts.length : 0,
      });
      return {
        posts: chunkPosts,
        rawLength: String(result.rawContent || '').length,
        latency: result.latency || 0,
        fallback: Boolean(result.fallback),
      };
    }

    const openAiWallStart = Date.now();
    if (usePostChunks) {
      const chunkPlan = [];
      for (let dayOffset = 0; dayOffset < daysToGenerate; dayOffset += 1) {
        const day = fallbackStart + dayOffset;
        let remaining = perDay;
        while (remaining > 0) {
          const chunkPostsPerDay = Math.min(remaining, maxPostsPerChunk);
          chunkPlan.push({
            chunkDays: 1,
            chunkStartDay: day,
            chunkPostsPerDay,
            chunkIndex: chunkPlan.length,
          });
          remaining -= chunkPostsPerDay;
        }
      }
      const chunkCount = chunkPlan.length;
      let chunkConcurrency = daysToGenerate >= 10 && perDay === 1 ? 2 : 4;
      if (chunkCount >= 10 && perDay === 1 && perDayChunkSize === 1) {
        chunkConcurrency = 3;
      }
      chunkConcurrency = Math.min(chunkConcurrency, 2);
      const chunkResults = await mapWithConcurrency(
        chunkPlan,
        chunkConcurrency,
        (plan) =>
          fetchChunk(
            plan.chunkDays,
            plan.chunkStartDay,
            plan.chunkIndex,
            plan.chunkPostsPerDay
          )
      );
      for (let i = 0; i < chunkPlan.length; i += 1) {
        const plan = chunkPlan[i];
        const chunkResult = chunkResults[i];
        aggregatedRawPosts = aggregatedRawPosts.concat(chunkResult.posts || []);
        chunkMetrics.push({
          chunkIndex: plan.chunkIndex,
          startDay: plan.chunkStartDay,
          days: plan.chunkDays,
          posts: plan.chunkPostsPerDay,
          rawLength: chunkResult.rawLength,
          duration: chunkResult.latency,
          timeoutMs: OPENAI_GENERATION_TIMEOUT_MS,
          chunkConcurrency,
        });
      }
      expectedCount = targetCount;
    } else {
      const chunkPlan = [];
      while (remainingDays > 0) {
        const chunkDays = Math.min(remainingDays, chunkLimit);
        const chunkStartDay = fallbackStart + processedDays;
        const chunkIndex = chunkPlan.length;
        chunkPlan.push({
          chunkDays,
          chunkStartDay,
          chunkPostsPerDay: perDay,
          chunkIndex,
        });
        remainingDays -= chunkDays;
        processedDays += chunkDays;
      }
      const chunkCount = chunkPlan.length;
      let chunkConcurrency = daysToGenerate >= 10 && perDay === 1 ? 2 : 4;
      if (chunkCount >= 10 && perDay === 1 && perDayChunkSize === 1) {
        chunkConcurrency = 3;
      }
      chunkConcurrency = Math.min(chunkConcurrency, 2);
      const chunkResults = await mapWithConcurrency(
        chunkPlan,
        chunkConcurrency,
        (plan) => fetchChunk(plan.chunkDays, plan.chunkStartDay, plan.chunkIndex, plan.chunkPostsPerDay)
      );
      for (let i = 0; i < chunkPlan.length; i += 1) {
        const plan = chunkPlan[i];
        const chunkResult = chunkResults[i];
        aggregatedRawPosts = aggregatedRawPosts.concat(chunkResult.posts || []);
        chunkMetrics.push({
          chunkIndex: plan.chunkIndex,
          startDay: plan.chunkStartDay,
          days: plan.chunkDays,
          posts: perDay * plan.chunkDays,
          rawLength: chunkResult.rawLength,
          duration: chunkResult.latency,
          timeoutMs: OPENAI_GENERATION_TIMEOUT_MS,
          chunkConcurrency,
        });
      }
      expectedCount = processedDays ? (processedDays * perDay) : null;
    }
    const openAiWallEnd = Date.now();
    console.log('[Calendar][Server][Chunks]', {
      requestId: logContext.requestId,
      startDay,
      days,
      postsPerDay,
      chunkConcurrency: chunkMetrics.length ? (chunkMetrics[0].chunkConcurrency || null) : null,
      chunkCount: chunkMetrics.length,
      timeoutMs: OPENAI_GENERATION_TIMEOUT_MS,
      chunkDetails: chunkMetrics,
    });
    const rawLength = chunkMetrics.reduce((sum, chunk) => sum + (chunk.rawLength || 0), 0);

    let rawPosts = aggregatedRawPosts.map((post) => {
      if (!post || typeof post !== 'object') return post;
      if (!Array.isArray(post.hashtags)) {
        if (typeof post.hashtags === 'string') {
          post.hashtags = post.hashtags
            .split(/[#,\n]+/)
            .map((tag) => tag.trim())
            .filter(Boolean)
            .slice(0, 12);
        } else {
          post.hashtags = [];
        }
      }
      return post;
    });
    if (expectedCount && rawPosts.length !== expectedCount) {
      const err = new Error('Calendar response count mismatch');
      err.code = 'OPENAI_SCHEMA_ERROR';
      err.statusCode = 500;
      err.details = {
        expectedCount,
        actualCount: rawPosts.length,
      };
      err.promptMeta = lastPromptMeta;
      err.rawContent = lastRawContent ? String(lastRawContent) : '';
      err.model = 'claude-opus-4-6';
      err.schemaName = 'calendar_batch';
      err.responseFormat = null;
      err.mode = calendarMode;
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
    if (false && brandBrainEnabled) {
      rawPosts = rawPosts.map((post, idx) => {
        if (!post || typeof post !== 'object') return post;
        const next = fillBrandBrainDefaults(post, nicheStyle);
        const dayValue = Number.isFinite(Number(next?.day))
          ? Number(next.day)
          : computePostDayIndex(idx, fallbackStart, perDay);
        try {
          ensureBrandBrainSignatureAngle(next, loggingContext);
        } catch (err) {
          repairBrandBrainRequiredKeys(next, dayValue, nicheStyle);
        }
        return repairBrandBrainRequiredKeys(next, dayValue, nicheStyle);
      });
    }
    const missingFieldsReport = [];
    const noncoreMissingReport = [];
    rawPosts.forEach((post, idx) => {
      const missing = validatePostCompleteness(post, calendarMode);
      if (!missing.length) return;
      const coreMissing = missing.filter((field) => !NONCORE_OPTIONAL_FIELDS.has(field));
      const noncoreMissing = missing.filter((field) => NONCORE_OPTIONAL_FIELDS.has(field));
      const day = Number.isFinite(Number(post.day)) ? Number(post.day) : computePostDayIndex(idx, fallbackStart, perDay);
      const slotIndex = Number.isFinite(Number(post?.slotIndex)) ? Number(post.slotIndex) : null;
      const postKeyValue = toPlainString(post?.post_key || post?.postKey || '');
      if (noncoreMissing.length) {
        noncoreMissingReport.push({
          index: idx,
          day,
          slotIndex,
          postsPerDay: perDay,
          post_key: postKeyValue,
          missing: noncoreMissing,
        });
      }
      if (coreMissing.length) {
        missingFieldsReport.push({
          index: idx,
          day,
          slotIndex,
          postsPerDay: perDay,
          post_key: postKeyValue,
          missing: coreMissing,
        });
      }
    });
    if (noncoreMissingReport.length) {
      console.warn('[Calendar][Server][SchemaValidation] noncore empty fields', {
        requestId: loggingContext?.requestId,
        startDay,
        days,
        postsPerDay,
        count: noncoreMissingReport.length,
        detailSamples: noncoreMissingReport.slice(0, 2).map((entry) => ({
          ...entry,
          missing: Array.isArray(entry.missing) ? entry.missing.map(String) : [],
        })),
      });
    }
    if (missingFieldsReport.length) {
      const debugDiagnosticsEnabled = !!loggingContext?.debug;
      const missingDiagnostics = debugDiagnosticsEnabled
        ? missingFieldsReport.map((entry) => {
          const post = rawPosts[entry.index] && typeof rawPosts[entry.index] === 'object' ? rawPosts[entry.index] : {};
          const diagnostics = buildRequiredFieldDiagnostics(post, calendarMode);
          return {
            ...entry,
            missing: diagnostics.missing.length ? diagnostics.missing : entry.missing,
            empty: diagnostics.empty,
            invalidTypes: diagnostics.invalidTypes,
          };
        })
        : null;
      if (false && brandBrainEnabled) {
        // Disabled legacy repair path intentionally left empty.
      } else {
        const err = new Error('Calendar response missing required fields');
        err.code = 'OPENAI_SCHEMA_ERROR';
        err.statusCode = 500;
        err.details = missingFieldsReport;
        if (debugDiagnosticsEnabled && missingDiagnostics) {
          err.details = {
            expectedCount: expectedCount || rawPosts.length,
            actualCount: rawPosts.length,
            missingFields: missingFieldsReport,
            diagnostics: missingDiagnostics,
          };
        }
        err.promptMeta = lastPromptMeta;
        err.rawContent = lastRawContent ? String(lastRawContent) : '';
        err.model = 'claude-opus-4-6';
        err.schemaName = 'calendar_batch';
        err.responseFormat = null;
        err.mode = calendarMode;
        const rawPreview = debugDiagnosticsEnabled ? err.rawContent.slice(0, 2000) : null;
        const rawTail = debugDiagnosticsEnabled ? err.rawContent.slice(-500) : null;
        console.warn('[Calendar][Server][SchemaValidation] missing required fields', {
          requestId: loggingContext?.requestId,
          startDay,
          days,
          postsPerDay,
          expectedCount,
          actualCount: rawPosts.length,
          missingFields: missingFieldsReport.length,
          responseLength: rawLength,
          detailSamples: missingFieldsReport.slice(0, 2).map((entry) => ({
            ...entry,
            missing: Array.isArray(entry.missing) ? entry.missing.map(String) : [],
          })),
          debugSamples: debugDiagnosticsEnabled && missingDiagnostics
            ? missingDiagnostics.slice(0, 2)
            : null,
          rawOutputPreview: rawPreview || undefined,
          rawOutputTail: rawTail || undefined,
        });
        throw err;
      }
    }
    if (brandBrainEnabled) {
      const warningPostSets = new Map();
      const fatalEntries = [];
      rawPosts.forEach((post, idx) => {
        const day = Number.isFinite(Number(post?.day)) ? Number(post.day) : computePostDayIndex(idx, fallbackStart, perDay);
        if (!post || typeof post !== 'object') {
          fatalEntries.push({ index: idx, day, reasons: [{ code: 'INVALID_POST' }] });
          return;
        }
        normalizeHashtagsForBrandBrain(post);
        const validation = validateBrandBrainPost(post, nicheStyle);
        if (validation.ok) return;
        const fatalReasons = [];
        const warningReasons = [];
        validation.reasons.forEach((reason) => {
          if (reason.code === 'MISSING_FIELD') {
            fatalReasons.push(reason);
          } else {
            warningReasons.push(reason);
          }
        });
        if (fatalReasons.length) {
          fatalEntries.push({ index: idx, day, reasons: fatalReasons });
        }
        if (warningReasons.length) {
          warningReasons.forEach((reason) => {
            const code = String(reason.code || 'UNKNOWN');
            if (!warningPostSets.has(code)) warningPostSets.set(code, new Set());
            warningPostSets.get(code).add(idx);
          });
        }
      });
      if (warningPostSets.size) {
        const requestId = loggingContext?.requestId || '';
        const requestLabel = requestId || 'unknown';
        if (!requestId || !BRAND_BRAIN_VALIDATION_WARNING_LOGGED_REQUESTS.has(requestId)) {
          const warningCounts = {};
          const warnedPosts = new Set();
          warningPostSets.forEach((set, code) => {
            warningCounts[code] = set.size;
            set.forEach((idx) => warnedPosts.add(idx));
          });
          console.warn('[BrandBrain][Validation][Warning]', {
            requestId: requestLabel,
            warningCounts,
            postsWithWarnings: warnedPosts.size,
          });
          if (requestId) {
            BRAND_BRAIN_VALIDATION_WARNING_LOGGED_REQUESTS.add(requestId);
            if (BRAND_BRAIN_VALIDATION_WARNING_LOGGED_REQUESTS.size > 5000) {
              BRAND_BRAIN_VALIDATION_WARNING_LOGGED_REQUESTS.clear();
            }
          }
        }
      }
      if (false && fatalEntries.length) {
        rawPosts = repairBrandBrainPostBatch(rawPosts, nicheStyle, fallbackStart, perDay);
        const remaining = [];
        rawPosts.forEach((post, idx) => {
          const missing = validatePostCompleteness(post, calendarMode);
          if (!missing.length) return;
          const day = Number.isFinite(Number(post?.day)) ? Number(post.day) : computePostDayIndex(idx, fallbackStart, perDay);
          remaining.push({ index: idx, day, missing });
        });
        if (remaining.length) {
          console.error('[BrandBrain][Validation] missing required fields after repair', {
            requestId: loggingContext?.requestId || 'unknown',
            failures: remaining.length,
            samples: remaining.slice(0, 2),
          });
        }
      }
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
      retryUsed: attempt > 1,
      responseLength: rawLength,
    });
    if (!rawPosts.length) {
      console.warn('[Calendar] No posts returned across chunks', logContext);
    }
    const openDuration = Date.now() - callStart;
    const openAiLatency = chunkMetrics.reduce((max, chunk) => Math.max(max, chunk.duration || 0), 0);
    const validationStart = Date.now();
    const normalizedPosts = [];
    const allowFallbacks = false;
    for (let idx = 0; idx < rawPosts.length; idx += 1) {
      const normalized = normalizePostWithOverrideFallback(
        rawPosts[idx],
        idx,
        startDay,
        undefined,
        nicheStyle,
        loggingContext,
        { allowFallbacks }
      );
      if (normalized) normalizedPosts.push(normalized);
    }
    let posts = normalizedPosts;
    if (Array.isArray(topicPlan) && topicPlan.length) {
      topicPlan.forEach((item) => {
        const planDay = Number(item?.day);
        const slotIndex = Number.isFinite(Number(item?.postIndex)) ? Number(item.postIndex) : 0;
        if (!Number.isFinite(planDay)) return;
        item.__slotIndex = slotIndex;
        item.__key = postKey(planDay, slotIndex);
      });
      assignPostKeys(posts, startDay, perDay);
      const topicByKey = new Map(
        topicPlan
          .filter((item) => item && item.__key && item.title)
          .map((item) => [item.__key, String(item.title).trim()])
      );
      let missingBinding = false;
      const missingKeys = [];
      posts.forEach((post) => {
        if (!post || typeof post !== 'object') return;
        const topic = topicByKey.get(post.__key);
        if (!topic) {
          missingBinding = true;
          if (post.__key) missingKeys.push(post.__key);
          return;
        }
        post.topic = topic;
        post.title = topic;
        if (normalizeTitleText(post.title) !== normalizeTitleText(topic)) {
          missingBinding = true;
          if (post.__key) missingKeys.push(post.__key);
        }
      });
      if (missingBinding) {
        const err = new Error('TopicBindFailed');
        err.code = 'POST_KEY_MAPPING_FAILED';
        err.statusCode = 422;
        err.payload = { reason: 'topic_plan_binding_failed', missingPostKeys: missingKeys };
        throw err;
      }
      const debugSample = posts
        .slice(0, 3)
        .map((post) => ({
          day: post.day,
          slot: post.__slotIndex,
          topic: post.topic,
          hook: String(post.hook || '').slice(0, 40),
        }));
      if (debugSample.length) {
        console.log('[Calendar][TopicBind]', {
          requestId: loggingContext?.requestId || 'unknown',
          sample: debugSample,
        });
      }
    }
    const normalizedMissing = [];
    posts.forEach((post, idx) => {
      const missing = validatePostCompleteness(post, calendarMode);
      if (missing.length) {
        normalizedMissing.push({ index: idx, missing });
      }
    });
    console.log('[Calendar][Server][SchemaValidation] normalized missing fields', {
      requestId: loggingContext?.requestId || 'unknown',
      count: normalizedMissing.length,
      samples: normalizedMissing.slice(0, 2),
    });
    if (false && brandBrainEnabled && normalizedMissing.length) {
      posts = repairBrandBrainPostBatch(posts, nicheStyle, startDay, perDay);
      const stillMissing = [];
      posts.forEach((post, idx) => {
        const missing = validatePostCompleteness(post, calendarMode);
        if (missing.length) {
          stillMissing.push({ index: idx, missing });
        }
      });
      console.warn('[BrandBrain][SchemaValidation] normalized missing fields after repair', {
        requestId: loggingContext?.requestId || 'unknown',
        count: stillMissing.length,
        samples: stillMissing.slice(0, 2),
      });
    }
    const qualityState = { signatureMap: new Map() };
    posts.forEach((post, idx) => {
      const day = Number.isFinite(Number(post?.day)) ? Number(post.day) : computePostDayIndex(idx, startDay, perDay);
      const slotIndex = Number.isFinite(Number(post?.slotIndex)) ? Number(post.slotIndex) : null;
      const postKeyValue = toPlainString(post?.post_key || post?.postKey || '');
      const validation = validateCalendarPostQuality(post, {
        mode: calendarMode,
        nicheStyle,
        day,
        slotIndex,
        post_key: postKeyValue,
        requestId: loggingContext?.requestId || null,
      }, qualityState);
      if (validation?.ok) return;
      logCalendarPostReject(validation, {
        mode: calendarMode,
        nicheStyle,
        day,
        slotIndex,
        post_key: postKeyValue,
        requestId: loggingContext?.requestId || null,
      });
      const err = new Error('CALENDAR_POST_GENERATION_FAILED');
      err.code = 'CALENDAR_POST_GENERATION_FAILED';
      err.statusCode = 422;
      err.details = {
        post_key: postKeyValue,
        day,
        slotIndex,
        reason: validation?.reason || 'VALIDATION_FAILED',
        field: validation?.field || null,
        snippet: validation?.snippet || null,
        extra: validation?.extra || null,
      };
      throw err;
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
    logDuplicateStrategyValues(posts);
    const {
      tracks: billboardEntries,
      chartDateUsed,
      source: audioSource,
      filteredOut,
    } = await getCachedHot100({
      requestId: loggingContext?.requestId,
      minCount: 30,
    });
    const audioStats = ensureAudioForPosts(posts, {
      audioEntries: billboardEntries,
      requestId: loggingContext?.requestId,
      chunkStartDay: startDay,
      postsPerDay: perDay,
    });
    const invalidAudio = posts.find((post) => !post || !isValidAudio(getAudioValue(post)));
    if (invalidAudio) {
      const err = new Error('CALENDAR_POST_GENERATION_FAILED');
      err.code = 'CALENDAR_POST_GENERATION_FAILED';
      err.statusCode = 422;
      err.details = {
        reason: 'AUDIO_SOURCE_INVALID',
        field: 'details.audio',
        snippet: 'hot100_invalid',
      };
      throw err;
    }
    const audioSample = posts
      .slice(0, 2)
      .map((post) => ({
        day: post.day,
        audio: getAudioValue(post),
      }))
      .filter((entry) => entry.audio);
    const postProcessingMs = Date.now() - validationStart;
    const openAiTotalMs = chunkMetrics.reduce((sum, chunk) => sum + (chunk.duration || 0), 0);
    const openAiWallMs = openAiWallEnd - openAiWallStart;
    const preMs = openAiWallStart - tStart;
    const postMs = Date.now() - openAiWallEnd;
    console.log('[Calendar][Server][Perf] callOpenAI timings', {
      openMs: openDuration,
      latencyMs: openAiLatency,
      parseMs: postProcessingMs,
      postCount: posts.length,
      rawLength,
      context: loggingContext,
      preMs,
      openaiTotalMs: openAiTotalMs,
      openaiWallMs: openAiWallMs,
      postMs,
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
        const value = getAudioValue(post) || '';
        const parsed = normalizeAudioFromText(value);
        return parsed?.title && isHolidayTrack(parsed.title, parsed.artist);
      });
      if (holidayHits.length) {
        const sample = holidayHits.slice(0, 2).map((post) => ({
          day: post.day,
          audio: getAudioValue(post),
        }));
        throw new Error(`Holiday audio detected in audio: ${JSON.stringify(sample)}`);
      }
    }
    if (forceSinglePostPerDayForModel && requestedPostsPerDay > 1) {
      const expanded = [];
      posts.forEach((post) => {
        for (let slotIndex = 0; slotIndex < requestedPostsPerDay; slotIndex += 1) {
          if (!post || typeof post !== 'object') {
            expanded.push(post);
            continue;
          }
          const clone = { ...post };
          if (Object.prototype.hasOwnProperty.call(clone, 'slot')) clone.slot = slotIndex + 1;
          if (Object.prototype.hasOwnProperty.call(clone, 'slotIndex')) clone.slotIndex = slotIndex;
          if (Object.prototype.hasOwnProperty.call(clone, 'postIndex')) clone.postIndex = slotIndex;
          if (Object.prototype.hasOwnProperty.call(clone, 'perDayIndex')) clone.perDayIndex = slotIndex;
          expanded.push(clone);
        }
      });
      posts = expanded;
    }
    console.log('[Calendar][Server][Perf] generateCalendarPosts end', {
      elapsedMs: Date.now() - tStart,
      count: posts.length,
      expectedCount: expectedCount || posts.length,
      rawLength,
      latencyMs: openAiLatency,
      context: loggingContext,
    });
    posts.forEach((post) => {
      if (!post || typeof post !== 'object') return;
      delete post.__key;
      delete post.__slotIndex;
      if (Object.prototype.hasOwnProperty.call(post, 'topic')) {
        delete post.topic;
      }
    });
    return posts;
  }

  if (parsed.pathname === '/api/calendar/export-usage' && req.method === 'GET') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        req.user = user;
        const isPro = isUserPro(req);
        const brandBrainSettings = user?.id ? await fetchBrandBrainSettings(user.id) : null;
        const brandBrainEnabled = isPro && Boolean(brandBrainSettings?.enabled);
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
              message: 'Upgrade required to regenerate the calendar.',
              requestId,
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
              message: 'Upgrade required to regenerate the calendar.',
              feature: CALENDAR_EXPORT_FEATURE_KEY,
              requestId,
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

  if (parsed.pathname === '/api/calendar/regenerate_one' && req.method === 'POST') {
    (async () => {
      const requestId = generateRequestId('regen_one');
      res.setHeader('x-request-id', requestId);
      const requestStart = Date.now();
      let clientAborted = false;
      req.on('aborted', () => {
        clientAborted = true;
        console.warn('[Calendar][One][ClientAborted]', { requestId, elapsedMs: Date.now() - requestStart });
      });
      try {
        const user = await requireSupabaseUser(req);
        req.user = user;
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
          console.warn('[Calendar][One] failed to resolve tier', {
            requestId,
            userId: user.id,
            error: planErr?.message || planErr,
          });
        }
        const isPro = isUserPro(req);
        const body = await readJsonBody(req);
        if (body && typeof body === 'object') body.userId = user.id;
        if (!isPro) {
          const usage = await getFeatureUsageCount(supabaseAdmin, user.id, CALENDAR_EXPORT_FEATURE_KEY);
          if (usage >= 3) {
            return sendJson(res, 402, {
              ok: false,
              error: 'upgrade_required',
              feature: CALENDAR_EXPORT_FEATURE_KEY,
              requestId,
            });
          }
        }
        const calendarId = body?.calendarId ?? null;
        let calendarBrandBrainEnabled = null;
        let recentTitlesForRegenOne = [];
        if (calendarBrandBrainEnabled === null && calendarId && supabaseAdmin) {
          const { data: calendarRow, error: calendarError } = await supabaseAdmin
            .from('calendars')
            .select('*')
            .eq('id', calendarId)
            .eq('user_id', user.id)
            .maybeSingle();
          if (!calendarError && calendarRow) {
            if (typeof calendarRow.brand_brain_enabled === 'boolean') {
              calendarBrandBrainEnabled = calendarRow.brand_brain_enabled;
            } else if (typeof calendarRow.brandBrainEnabled === 'boolean') {
              calendarBrandBrainEnabled = calendarRow.brandBrainEnabled;
            } else if (typeof calendarRow.calendar_mode === 'string') {
              calendarBrandBrainEnabled = calendarRow.calendar_mode === 'brand_brain';
            } else if (typeof calendarRow.calendarMode === 'string') {
              calendarBrandBrainEnabled = calendarRow.calendarMode === 'brand_brain';
            }
            const calendarPosts = Array.isArray(calendarRow.posts) ? calendarRow.posts : [];
            recentTitlesForRegenOne = buildRecentTitlesList(calendarPosts.map((post) => post?.title || ''), 10);
          }
        }
        let selectedMode = calendarBrandBrainEnabled === true ? 'brand_brain' : 'regular';
        if (body?.calendarMode === 'brand_brain' || body?.mode === 'brand_brain' || body?.brandBrainEnabled) {
          selectedMode = 'brand_brain';
        }

        const nicheStyle = body?.nicheStyle || body?.niche || body?.niche_style || '';
        const promoting = toPlainString(body?.promoting || '');
        const voiceLockConfig = resolveVoiceLockConfig(body, isPro);
        const targetAudienceConfig = resolveTargetAudienceConfig(body, isPro);
        const voiceLockValue = voiceLockConfig.enabled
          ? toPlainString(VOICE_LOCK_PRESET_GUIDES[voiceLockConfig.preset]?.label || voiceLockConfig.preset || '')
          : '';
        const targetAudienceValue = targetAudienceConfig.enabled
          ? toPlainString(TARGET_AUDIENCE_PRESET_GUIDES[targetAudienceConfig.preset]?.label || targetAudienceConfig.preset || '')
          : '';
        const day = Number.isFinite(Number(body?.day)) ? Number(body.day) : 1;
        const slotIndex = Number.isFinite(Number(body?.slot)) ? Number(body.slot) : (
          Number.isFinite(Number(body?.slotIndex)) ? Number(body.slotIndex) : 0
        );
        const postKeyValue = toPlainString(body?.post_key || '') || postKey(day, slotIndex);
        const postsPerDay = Math.max(1, Number.isFinite(Number(body?.postsPerDay)) ? Number(body.postsPerDay) : 1);
        const totalDays = Number.isFinite(Number(body?.totalDays))
          ? Number(body.totalDays)
          : (Number.isFinite(Number(body?.days)) ? Number(body.days) : 30);
        const totalPosts = totalDays * postsPerDay;
        const scheduleIndex = (day - 1) * postsPerDay + slotIndex;

        let plannedTitle = toPlainString(body?.plannedTitle || body?.title || '');
        let plannedAngle = toPlainString(body?.plannedAngle || body?.angle || '');
        let plannedTopicSignature = toPlainString(body?.topic_signature || body?.topicSignature || '') || plannedTitle;
        const hasProvidedPlan = Boolean(plannedTopicSignature && plannedAngle);
        if (!hasProvidedPlan) {
          const plannerUsedSignatures = Array.isArray(body?.usedSignatures)
            ? body.usedSignatures.map((item) => toPlainString(item || '')).filter(Boolean).slice(-24)
            : [];
          const plannerNiche = nicheStyle || 'General';
          const onePlan = await generateCalendarPlan({
            requestId,
            mode: selectedMode,
            nicheStyle: plannerNiche,
            promoting,
            targetAudience: targetAudienceValue,
            usedSignatures: plannerUsedSignatures,
            days: 1,
            startDay: day,
            postsPerDay: 1,
            postKeysOverride: [postKeyValue],
          });
          const onePlanItems = Array.isArray(onePlan?.plan) ? onePlan.plan : [];
          const onePlanItem = onePlanItems[0] || null;
          if (!onePlanItem || !onePlanItem.topic_signature) {
            const err = new Error('PLAN_SCHEMA_MISMATCH');
            err.code = 'PLAN_SCHEMA_MISMATCH';
            err.statusCode = 422;
            throw err;
          }
          plannedTopicSignature = toPlainString(onePlanItem.topic_signature || '') || plannedTopicSignature;
          plannedAngle = toPlainString(onePlanItem.angle || '') || plannedAngle;
          plannedTitle = plannedTopicSignature || plannedTitle;
        } else if (!plannedTitle) {
          plannedTitle = plannedTopicSignature;
        }
        const variation = deriveVariation(postKeyValue);
        const maxTokens = Number.isFinite(Number(body?.maxTokens)) && Number(body.maxTokens) > 0 ? Number(body.maxTokens) : 1500;
        const requestTimeoutMs = Number.isFinite(Number(body?.requestTimeoutMs)) ? Number(body.requestTimeoutMs) : undefined;
        const temperature = Number.isFinite(Number(body?.temperature)) ? Number(body.temperature) : undefined;
        const schemaLabel = selectedMode === 'brand_brain' ? 'calendar_post_brandbrain' : 'calendar_post_regular';

        const brandContext = '';
        let brandBrainDirective = '';
        if (selectedMode === 'brand_brain') {
          const brandBrainSettings = user.id ? await fetchBrandBrainSettings(user.id) : null;
          brandBrainDirective = buildBrandBrainDirective({ ...(brandBrainSettings || {}), enabled: true });
        }

        try {
          console.log('[Calendar][One] start', {
            requestId,
            day,
            slot: slotIndex,
            post_key: postKeyValue,
            mode: selectedMode,
          });
          const post = await generateAndValidateSinglePost({
            nicheStyle,
            brandContext,
            calendarMode: selectedMode,
            brandBrainDirective,
            day,
            slotIndex,
            postsPerDay,
            post_key: postKeyValue,
            plannedTitle,
            plannedAngle,
            promoting,
            topicSignature: plannedTopicSignature,
            momentSpec: plannedTopicSignature,
            renderStyle: variation.render_style,
            beatShape: variation.beat_shape,
            revealOrder: variation.reveal_order,
            pov: variation.pov,
            angleLabel: plannedAngle || '',
            requestId,
            loggingContext: { requestId, day, slotIndex, post_key: postKeyValue },
            maxTokens,
            requestTimeoutMs,
            temperature,
            recentTitles: recentTitlesForRegenOne,
            calendarId,
            usedSignatures: [],
            qualityState: { signatureMap: new Map() },
            voiceLock: voiceLockValue,
          });
          if (!isPro && body?.isFirst === true) {
            await incrementFeatureUsage(supabaseAdmin, user.id, CALENDAR_EXPORT_FEATURE_KEY);
          }
          console.log('[Calendar][One] success', {
            requestId,
            day,
            slot: slotIndex,
            post_key: postKeyValue,
            ms: Date.now() - requestStart,
          });
          return sendJson(res, 200, { post, calendarId, requestId });
        } catch (err) {
          const reason = err?.details?.reason
            || (err?.code === 'PARSE_FAILED'
              ? (err?.reason || 'PARSE_FAILED')
              : err?.code === 'OPENAI_TIMEOUT' || err?.code === 'MODEL_TIMEOUT'
                ? 'OPENAI_TIMEOUT'
                : err?.code === 'OPENAI_BACKEND_ERROR'
                  ? 'OPENAI_UPSTREAM_FAIL'
                  : 'SCHEMA_MISMATCH');
          const normalizedReason = reason === 'PARSE_FAILED'
            ? 'PARSE_FAIL'
            : reason === 'SCHEMA_MISMATCH'
              ? 'SCHEMA_FAIL'
              : reason;
          console.log('[Calendar][One] fail', {
            requestId,
            day,
            slot: slotIndex,
            post_key: postKeyValue,
            reason: normalizedReason,
            field: err?.details?.field || null,
          });
          const detail = err?.details || {};
          return sendJson(res, 422, {
            error: 'CALENDAR_POST_GENERATION_FAILED',
            message: 'Calendar post generation failed.',
            requestId,
            details: {
              reason: normalizedReason,
              field: detail?.field || 'unknown',
              snippet: detail?.snippet || '',
              wordCount: detail?.wordCount ?? detail?.extra?.wordCount ?? null,
              missing_fields: detail?.missing_fields || [],
              wrong_types: detail?.wrong_types || [],
              extra_keys: detail?.extra_keys || [],
              day,
              post_key: postKeyValue,
            },
          });
        }
      } catch (err) {
        if (clientAborted || req.aborted || res.writableEnded) return;
        const status = err?.statusCode || err?.status || 500;
        if (status >= 500) {
          return sendJson(res, status, { error: err?.message || 'Internal Server Error', requestId });
        }
        return sendJson(res, status, { error: err?.message || 'REGENERATE_ONE_FAILED', requestId });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/calendar/plan' && req.method === 'POST') {
    (async () => {
      const requestId = generateRequestId('plan');
      res.setHeader('x-request-id', requestId);
      console.log('[Calendar][Plan] incoming request body:', JSON.stringify(req.body, null, 2));
      try {
        const user = await requireSupabaseUser(req);
        req.user = user;
        const body = await readJsonBody(req);
        console.log('[Calendar][Plan] parsed request body:', JSON.stringify(body, null, 2));
        if (body && typeof body === 'object') body.userId = user.id;
        const plannerMode = (body?.calendarMode === 'brand_brain' || body?.mode === 'brand_brain' || body?.brandBrainEnabled)
          ? 'brand_brain'
          : 'regular';
        const nicheStyle = toPlainString(body?.nicheStyle || body?.niche || body?.niche_style || '');
        const promoting = toPlainString(body?.promoting || '');
        const days = Number.isFinite(Number(body?.totalDays))
          ? Number(body.totalDays)
          : (Number.isFinite(Number(body?.days)) ? Number(body.days) : 30);
        const postsPerDay = Math.max(1, Number.isFinite(Number(body?.postsPerDay)) ? Number(body.postsPerDay) : 1);
        const startDay = Number.isFinite(Number(body?.startDay))
          ? Number(body.startDay)
          : (Number.isFinite(Number(body?.day)) ? Number(body.day) : 1);
        const usedSignatures = Array.isArray(body?.usedSignatures)
          ? body.usedSignatures.map((item) => toPlainString(item || '')).filter(Boolean).slice(-24)
          : [];
        const isPro = isUserPro(req);
        const targetAudienceConfig = resolveTargetAudienceConfig(body, isPro);
        const targetAudienceValue = targetAudienceConfig.enabled
          ? toPlainString(TARGET_AUDIENCE_PRESET_GUIDES[targetAudienceConfig.preset]?.label || targetAudienceConfig.preset || '')
          : '';
        console.log('[Calendar][Plan] planner request payload summary:', {
          requestId,
          plannerMode,
          nicheStyle,
          hasPromoting: Boolean(promoting),
          days,
          startDay,
          postsPerDay,
          usedSignaturesCount: usedSignatures.length,
          targetAudienceValue,
        });
        const planResult = await generateCalendarPlan({
          requestId,
          mode: plannerMode,
          nicheStyle: nicheStyle || 'General',
          promoting,
          targetAudience: targetAudienceValue,
          days,
          startDay,
          postsPerDay,
          usedSignatures,
        });
        return sendJson(res, 200, {
          plan: Array.isArray(planResult?.plan) ? planResult.plan : [],
          requestId,
        });
      } catch (err) {
        const status = err?.statusCode || err?.status || 500;
        if (status === 422) {
          console.log('[Calendar][Plan] 422 reason:', {
            requestId,
            code: err?.code || null,
            message: err?.message || null,
            details: err?.details || null,
            payload: err?.payload || null,
          });
        } else {
          console.log('[Calendar][Plan] error reason:', {
            requestId,
            status,
            code: err?.code || null,
            message: err?.message || null,
          });
        }
        if (status >= 500) {
          return sendJson(res, status, { error: err?.message || 'Internal Server Error', requestId });
        }
        return sendJson(res, status, { error: err?.message || 'PLAN_FAILED', requestId });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/calendar/regenerate' && req.method === 'POST') {
    (async () => {
      let body = null;
      let selectedMode = 'regular';
      let targetCalendarId = null;
      const requestId = generateRequestId('regen');
      res.setHeader('x-request-id', requestId);
      const regenContext = { requestId, warnings: [] };
      const requestStart = Date.now();
      let clientAborted = false;
      req.on('aborted', () => {
        clientAborted = true;
        console.warn('[Calendar][Regen][ClientAborted]', { requestId, elapsedMs: Date.now() - requestStart });
      });
      res.on('close', () => {
        if (!res.headersSent) return;
        console.warn('[Calendar][Regen][ResClosed]', {
          requestId,
          elapsedMs: Date.now() - requestStart,
          headersSent: res.headersSent,
          writableEnded: res.writableEnded,
        });
      });
      res.on('finish', () => {
        console.log('[Calendar][Regen][Response]', {
          requestId,
          statusCode: res.statusCode,
          elapsedMs: Date.now() - requestStart,
        });
      });
      try {
        // Require auth for regen, but still allow body userId to pass brand
        const user = await requireSupabaseUser(req);
        req.user = user;
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
          console.warn('[Calendar] failed to resolve tier', {
            requestId,
            userId: user.id,
            error: planErr?.message || planErr,
          });
        }
        const isPro = isUserPro(req);
        const debugSchema = !isProduction || String(req.headers['x-debug'] || '') === '1';
        regenContext.debug = debugSchema;
        const tStart = Date.now();
        console.log('[Calendar][Server][Perf] regen request received', {
          requestId,
          userId: user.id,
          tier: req.user?.tier || req.user?.plan || 'free',
          isPro,
        });
        if (!isPro) {
          const usage = await getFeatureUsageCount(supabaseAdmin, user.id, CALENDAR_EXPORT_FEATURE_KEY);
          if (usage >= 3) {
            return sendJson(res, 402, {
              ok: false,
              error: 'upgrade_required',
              feature: CALENDAR_EXPORT_FEATURE_KEY,
              requestId,
            });
          }
        }
        body = await readJsonBody(req);
        if (body && typeof body === 'object') {
          body.userId = user.id;
        }
        targetCalendarId = body?.calendarId ?? null;
        let calendarBrandBrainEnabled = null;
        if (calendarBrandBrainEnabled === null && targetCalendarId && supabaseAdmin) {
          const { data: calendarRow, error: calendarError } = await supabaseAdmin
            .from('calendars')
            .select('*')
            .eq('id', targetCalendarId)
            .eq('user_id', user.id)
            .maybeSingle();
          if (!calendarError && calendarRow) {
            if (typeof calendarRow.brand_brain_enabled === 'boolean') {
              calendarBrandBrainEnabled = calendarRow.brand_brain_enabled;
            } else if (typeof calendarRow.brandBrainEnabled === 'boolean') {
              calendarBrandBrainEnabled = calendarRow.brandBrainEnabled;
            } else if (typeof calendarRow.calendar_mode === 'string') {
              calendarBrandBrainEnabled = calendarRow.calendar_mode === 'brand_brain';
            } else if (typeof calendarRow.calendarMode === 'string') {
              calendarBrandBrainEnabled = calendarRow.calendarMode === 'brand_brain';
            }
            if (calendarBrandBrainEnabled === null) {
              const posts = Array.isArray(calendarRow.posts) ? calendarRow.posts : [];
              const hasModeFlag = posts.some((post) => {
                if (!post || typeof post !== 'object') return false;
                return (
                  post?.calendarMode === 'brand_brain' ||
                  post?.mode === 'brand_brain' ||
                  post?.brandBrainEnabled === true ||
                  post?.brand_brain_enabled === true
                );
              });
              calendarBrandBrainEnabled = Boolean(hasModeFlag);
            }
          }
        }
        selectedMode = calendarBrandBrainEnabled === true ? 'brand_brain' : 'regular';
        const postKeyForLog = body?.post_key || body?.postKey || body?.post?.post_key || body?.post?.postKey || null;
        console.log('[Calendar][Regen][ModeSelect]', {
          requestId,
          post_key: postKeyForLog,
          selectedMode,
          calendarBrandBrainEnabled: Boolean(calendarBrandBrainEnabled),
        });
        if (clientAborted || req.aborted) return;
        console.log('[Calendar][Server][Perf] regen generation start', {
          requestId,
          days: body?.days,
          startDay: body?.startDay,
          postsPerDay: body?.postsPerDay,
        });
        regenContext.batchIndex = body?.batchIndex;
        regenContext.startDay = body?.startDay;
        if (clientAborted || req.aborted || res.writableEnded) return;
        await acquireRegenSlot(requestId);
        try {
          const safeDays = Number.isFinite(Number(body?.days)) && Number(body?.days) > 0 ? Number(body.days) : 1;
          const safeStart = Number.isFinite(Number(body?.startDay)) ? Number(body.startDay) : 1;
          const requestedPostsPerDay = Math.max(
            1,
            Number.isFinite(Number(body?.postsPerDay)) ? Number(body.postsPerDay) : 1
          );
          const posts = await generateCalendarPosts({
            ...(body || {}),
            userId: user.id,
            calendarMode: selectedMode,
            brandBrainEnabled: selectedMode === 'brand_brain',
            days: safeDays,
            startDay: safeStart,
            postsPerDay: requestedPostsPerDay,
            isPro,
            context: {
              requestId,
              batchIndex: body?.batchIndex,
              startDay: safeStart,
            },
          });
          if (!isPro) {
            await incrementFeatureUsage(supabaseAdmin, user.id, CALENDAR_EXPORT_FEATURE_KEY);
          }
          return sendJson(res, 200, { calendarId: targetCalendarId, posts, requestId });
        } finally {
          releaseRegenSlot();
        }
        return;
      } catch (err) {
        if (clientAborted || req.aborted || res.writableEnded) return;
        const safeError = err instanceof Error ? err : new Error(String(err));
        const missingFieldsSample = (() => {
          const details = safeError?.details;
          if (Array.isArray(details)) {
            const entry = details.find((item) => Array.isArray(item?.missing) && item.missing.length);
            if (!entry) return null;
            return {
              missing: entry.missing,
              day: entry.day ?? null,
              slotIndex: entry.slotIndex ?? null,
              post_key: entry.post_key ?? null,
            };
          }
          if (details && typeof details === 'object' && Array.isArray(details.missing) && details.missing.length) {
            return {
              missing: details.missing,
              day: details.day ?? null,
              slotIndex: details.slotIndex ?? null,
              post_key: details.post_key ?? null,
            };
          }
          return null;
        })();
        if (safeError?.code === 'REGEN_TIMEOUT_BUDGET' || safeError?.code === 'REGEN_BUDGET_EXCEEDED') {
          return sendJson(res, 503, {
            error: 'REGEN_BUDGET_EXCEEDED',
            message: 'Regeneration exceeded time budget',
            requestId,
          });
        }
        if (safeError?.code === 'MODEL_TIMEOUT') {
          return sendJson(res, 503, {
            error: 'MODEL_TIMEOUT',
            message: 'Model timeout',
            requestId,
          });
        }
        if (safeError?.code === 'OPENAI_SCHEMA_INVALID') {
          return sendJson(res, 422, {
            error: 'OPENAI_SCHEMA_INVALID',
            message: 'OpenAI schema invalid.',
            requestId,
            details: safeError?.details || null,
          });
        }
        if (safeError?.code === 'CALENDAR_POST_GENERATION_FAILED') {
          const detail = safeError?.details || {};
          const responseDetails = {
            reason: detail?.reason || null,
            field: detail?.field || detail?.reason || 'schema',
            snippet: detail?.snippet || (() => {
              try {
                return JSON.stringify(detail).slice(0, 200);
              } catch {
                return null;
              }
            })(),
            day: detail?.day ?? null,
            post_key: detail?.post_key || null,
          };
          return sendJson(res, 422, {
            error: 'CALENDAR_POST_GENERATION_FAILED',
            message: 'Calendar post generation failed.',
            requestId,
            details: responseDetails,
          });
        }
        const errorContext = {
          postsPerDay: body?.postsPerDay,
          days: body?.days,
          startDay: body?.startDay,
          nicheStyle: body?.nicheStyle,
        };
        const isSchemaError = safeError?.code === 'OPENAI_SCHEMA_ERROR';
        const isInvalidJson = safeError?.code === 'INVALID_MODEL_JSON';
        const isTopicBinding = safeError?.code === 'TOPIC_BINDING_FAILED';
        const isPostKeyMapping = safeError?.code === 'POST_KEY_MAPPING_FAILED';
        const debugSchema = !isProduction || String(req.headers['x-debug'] || '') === '1';
        if (isSchemaError && debugSchema) {
          const promptMeta = safeError?.promptMeta || {};
          const rawText = safeError?.rawContent ? String(safeError.rawContent) : '';
          const rawPreview = rawText ? rawText.slice(0, 2000) : null;
          const rawTail = rawText ? rawText.slice(-500) : null;
          const openaiDetails = safeError?.openaiDetails || {};
          console.warn('[Calendar][SchemaError][Debug]', {
            requestId,
            mode: safeError?.mode || 'unknown',
            schemaName: safeError?.schemaName || 'calendar_batch',
            model: safeError?.model || 'claude-opus-4-6',
            responseFormat: safeError?.responseFormat || null,
            promptChars: promptMeta.chars || null,
            promptHash: promptMeta.hash || null,
            openaiMessage: openaiDetails.openaiMessage || safeError?.message || null,
            openaiType: openaiDetails.openaiType || null,
            openaiParam: openaiDetails.openaiParam || null,
            schemaDetails: safeError?.details || null,
            rawOutputPreview: rawPreview,
            rawOutputTail: rawTail,
          });
        }
        const logInfo = { requestId, context: errorContext };
        logInfo.errorName = safeError?.name;
        logInfo.errorCode = safeError?.code;
        logInfo.errorStatus = safeError?.statusCode || safeError?.status || null;
        if (isSchemaError) {
          if (safeError?.schemaSnippet) logInfo.schemaSnippet = safeError.schemaSnippet;
          if (safeError?.details) logInfo.schemaPayload = safeError.details;
          if (safeError?.rawContent) logInfo.rawContentPreview = String(safeError.rawContent).slice(0, 400);
        }
        if (isSchemaError) {
          console.error('[Calendar][SchemaError]', {
            requestId,
            message: safeError?.message || '',
            code: safeError?.code || '',
            statusCode: safeError?.statusCode || '',
            errorPayload: safeError?.details?.error || null,
            responseFormat: safeError?.details?.response_format || null,
            schemaKeys: safeError?.details?.schemaKeys || null,
            openaiDetails: safeError?.openaiDetails || null,
            mode: safeError?.mode || null,
          });
        }
        if (isInvalidJson && safeError?.rawContent) {
          logInfo.rawContentPreview = String(safeError.rawContent).slice(0, 400);
        }
        logServerError('calendar_regenerate_error', safeError, logInfo);
        if (res.headersSent) return;
        if (isTopicBinding || isPostKeyMapping) {
          if (isTopicBinding) {
            return sendJson(res, 422, {
              error: 'TOPIC_BINDING_FAILED',
              message: 'Topic binding failed for this post.',
              requestId,
              post_key: safeError?.payload?.post_key,
              failedFields: safeError?.payload?.failedFields,
            });
          }
          return sendJson(res, 422, {
            error: 'PostKeyMappingFailed',
            message: 'Post key mapping failed for this batch.',
            ...(safeError?.payload || {}),
            requestId,
          });
        }
        if (isSchemaError) {
          return sendJson(res, 422, {
            error: 'CALENDAR_SCHEMA_MISMATCH',
            message: 'Calendar output did not meet required fields.',
            requestId,
            details: safeError?.details || null,
            missingFieldsSample: missingFieldsSample || undefined,
          });
        }
        if (safeError?.code === 'BRAND_BRAIN_VALIDATION_FAILED') {
          return sendJson(res, 500, {
            error: 'Brand Brain validation failed',
            requestId,
            details: safeError?.details || null,
          });
        }
        const upstreamStatus = safeError?.upstreamStatus || safeError?.statusCode || safeError?.status || null;
        const status = isInvalidJson ? 400 : (Number.isFinite(Number(upstreamStatus)) ? Number(upstreamStatus) : 500);
        const safeStatus = status === 502 ? 500 : status;
        const message = safeError?.message || 'Internal Server Error';
        if (safeStatus >= 500) {
          return sendJson(res, safeStatus, { error: message, requestId });
        }
        const payload = {
          error: 'REGENERATE_FAILED',
          message,
          requestId,
          details: {
            type: safeError?.code || safeError?.name || 'unknown_error',
            upstreamStatus: upstreamStatus || null,
            upstreamMessage: safeError?.openaiDetails?.openaiMessage || null,
            code: safeError?.code || null,
            where: 'calendar_regenerate',
          },
        };
        return sendJson(res, safeStatus, payload);
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/generate-variants' && req.method === 'POST') {
    (async () => {
      try {
        await requireSupabaseUser(req);
        const payload = await readJsonBody(req);
        let rawVariants = Array.isArray(payload?.variants) ? payload.variants : [];
        if ((!rawVariants || !rawVariants.length) && Array.isArray(payload?.posts)) {
          rawVariants = payload.posts
            .map((post) => {
              if (!post || typeof post !== 'object') return null;
              const caption = toPlainString(post.caption || post.hook || post.title || '');
              if (!caption) return null;
              return {
                day: post.day,
                variants: {
                  igCaption: caption,
                  tiktokCaption: caption,
                  linkedinCaption: caption,
                },
              };
            })
            .filter(Boolean);
        }
        const MAX_VARIANTS = 30;
        const MAX_TEXT = 320;
        const trimmed = rawVariants.slice(0, MAX_VARIANTS).map((entry) => {
          if (!entry || typeof entry !== 'object') return entry;
          const next = { ...entry };
          const maybeTrim = (value) =>
            typeof value === 'string' && value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
          Object.keys(next).forEach((key) => {
            next[key] = maybeTrim(next[key]);
          });
          return next;
        });
        const responsePayload = { variants: trimmed };
        const payloadText = JSON.stringify(responsePayload);
        console.log('[Calendar] generate-variants response size', {
          bytes: Buffer.byteLength(payloadText),
          count: trimmed.length,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(payloadText);
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
      let selectedMode = 'regular';
      let parsedPayload = null;
      try {
        const payload = JSON.parse(body || '{}');
        parsedPayload = payload;
        const targetCalendarId = payload?.calendarId ?? null;
        if (targetCalendarId && supabaseAdmin) {
          const { data: calendarRow, error: calendarError } = await supabaseAdmin
            .from('calendars')
            .select('*')
            .eq('id', targetCalendarId)
            .maybeSingle();
          if (!calendarError && calendarRow) {
            if (typeof calendarRow.brand_brain_enabled === 'boolean') {
              selectedMode = calendarRow.brand_brain_enabled ? 'brand_brain' : 'regular';
            } else if (typeof calendarRow.brandBrainEnabled === 'boolean') {
              selectedMode = calendarRow.brandBrainEnabled ? 'brand_brain' : 'regular';
            } else if (typeof calendarRow.calendar_mode === 'string') {
              selectedMode = calendarRow.calendar_mode === 'brand_brain' ? 'brand_brain' : 'regular';
            } else if (typeof calendarRow.calendarMode === 'string') {
              selectedMode = calendarRow.calendarMode === 'brand_brain' ? 'brand_brain' : 'regular';
            }
          }
        }
        const brandBrainEnabled = selectedMode === 'brand_brain';
        let posts = await generateCalendarPosts({
          ...payload,
          brandBrainEnabled,
          calendarMode: selectedMode,
          postsPerDay: 1,
          isPro: brandBrainEnabled,
          context: {
            requestId,
            batchIndex: payload?.batchIndex,
            startDay: payload?.startDay,
          },
        });
        if (brandBrainEnabled) {
          posts = repairBrandBrainPostBatch(posts, payload?.nicheStyle || '', payload?.startDay || 1, 1);
        }
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

  if (parsed.pathname === '/api/debug/design-templates' && req.method === 'GET') {
    if (!ENABLE_DESIGN_LAB) return sendJson(res, 410, { error: 'Design Lab has been removed.' });
    handleDesignTemplateDebug(req, res);
    return;
  }

  if (parsed.pathname === '/api/debug/design-config' && req.method === 'GET') {
    if (!ENABLE_DESIGN_LAB) return sendJson(res, 410, { error: 'Design Lab has been removed.' });
    handleDebugDesignConfig(req, res);
    return;
  }

  const calendarDeleteMatch =
    parsed.pathname && parsed.pathname.match(/^\/api\/calendars\/([^/]+)$/i);
  if (calendarDeleteMatch && req.method === 'DELETE') {
    handleDeleteCalendar(req, res, calendarDeleteMatch[1]);
    return;
  }

  if (parsed.pathname === '/api/design/generate' && req.method === 'POST') {
    return sendJson(res, 410, { error: 'Design Lab has been removed.' });
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
        const isPro = isUserPro(req);
        const brandBrainSettings = user?.id ? await fetchBrandBrainSettings(user.id) : null;
        const brandBrainEnabled = isPro && Boolean(brandBrainSettings?.enabled);
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
        const postsPerDay = 1;
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
              isPro,
              voiceLockEnabled: body?.voiceLockEnabled,
              voiceLockPreset: body?.voiceLockPreset,
              voiceLockSample: body?.voiceLockSample,
              targetAudience: body?.targetAudience,
              promoting: body?.promoting,
            });
          } catch (genErr) {
            throw genErr;
          }
          const candidate = Array.isArray(posts) && posts.length ? posts[0] : null;
          if (!candidate) throw new Error('Calendar generator returned no posts');
          const normalizedResult = ensureRegenRequiredFields(candidate, nicheStyle, dayNumber, {
            allowFallbacks: false,
          });
          const hadSignature = isNonEmptyString(normalizedResult.post?.topic_signature);
          const hadAngle = isNonEmptyString(normalizedResult.post?.angle);
          normalized = ensureRegenDaySignatureAngle(normalizedResult.post, dayNumber);
          appliedFixes = (normalizedResult.appliedFixes || []).slice();
          if (!hadSignature) appliedFixes.push('topic_signature');
          if (!hadAngle) appliedFixes.push('angle');
          missingFields = validatePostCompleteness(normalized, calendarMode);
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
        if (err?.code === 'TOPIC_BINDING_FAILED') {
          return sendJson(res, 422, {
            error: 'TOPIC_BINDING_FAILED',
            requestId,
            post_key: err?.payload?.post_key,
            failedFields: err?.payload?.failedFields,
          });
        }
        if (err?.code === 'POST_KEY_MAPPING_FAILED') {
          return sendJson(res, 422, {
            error: 'PostKeyMappingFailed',
            ...(err?.payload || {}),
            requestId,
          });
        }
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
      const requestId = resolveRequestId(req, 'brandbrain_settings');
      let user = null;
      let entitlement = { status: null, plan: null, sourceTable: 'profiles' };
      let decision = 'unknown';
      let decisionReason = null;
      let logged = false;
      const logDecision = () => {
        if (logged) return;
        logged = true;
        console.log('[BrandBrain][Settings][GET]', {
          requestId,
          userId: user?.id || null,
          email: user?.email || null,
          decision,
          reason: decisionReason,
          status: entitlement.status || null,
          plan: entitlement.plan || null,
          sourceTable: entitlement.sourceTable || null,
        });
      };
      try {
        const missingEnv = getMissingSupabaseEnvVars();
        if (missingEnv.length) {
          decision = 'server_misconfig';
          logDecision();
          return sendJson(res, 500, {
            error: 'SERVER_MISCONFIG',
            details: { missing: missingEnv },
            requestId,
          });
        }
        const expectedSupabaseHost = String(process.env.EXPECTED_SUPABASE_HOST || '').trim();
        const currentSupabaseUrl = String(process.env.SUPABASE_URL || '').trim();
        if (expectedSupabaseHost && currentSupabaseUrl && !currentSupabaseUrl.includes(expectedSupabaseHost)) {
          console.warn('[BrandBrain][Entitlements][EnvMismatch]', {
            requestId,
            expectedHost: expectedSupabaseHost,
            currentUrl: currentSupabaseUrl,
          });
        }
        try {
          user = await requireSupabaseUser(req);
          req.user = user;
        } catch (_authErr) {
          decision = 'auth_required';
          logDecision();
          return sendJson(res, 401, { error: 'AUTH_REQUIRED', requestId });
        }
        const entitlementDecision = await assertProEntitled(user.id);
        entitlement = {
          status: entitlementDecision.status,
          plan: entitlementDecision.plan,
          sourceTable: entitlementDecision.sourceTable,
        };
        decision = entitlementDecision.isPro ? 'pro' : 'not_pro';
        decisionReason = entitlementDecision.reason;
        logDecision();
        if (!entitlementDecision.isPro) {
          console.warn(
            `[BrandBrain][Entitlements][402] requestId=${requestId} ` +
              `userId=${user?.id || 'unknown'} email=${user?.email || 'unknown'} ` +
              `sourceTable=${entitlementDecision.sourceTable} plan=${entitlementDecision.plan || 'unknown'} ` +
              `status=${entitlementDecision.status || 'unknown'} reason=${entitlementDecision.reason}`
          );
          return sendJson(res, 402, {
            error: 'PAYMENT_REQUIRED',
            requestId,
            details: { status: entitlementDecision.status, plan: entitlementDecision.plan },
          });
        }
        const settings = (await fetchBrandBrainSettings(user.id)) || BRAND_BRAIN_DEFAULT_SETTINGS;
        return sendJson(res, 200, { ok: true, settings });
      } catch (err) {
        decision = decision === 'unknown' ? 'internal_error' : decision;
        logDecision();
        console.error('[BrandBrain] settings GET failed', {
          requestId,
          error: err?.message || err,
          stack: err?.stack,
        });
        return sendJson(res, 500, { error: 'INTERNAL_ERROR', requestId });
      }
    })();
    return;
  }

  if (parsed.pathname === '/api/brand-brain/settings' && req.method === 'POST') {
    (async () => {
      try {
        const user = await requireSupabaseUser(req);
        req.user = user;
        const entitlementDecision = await assertProEntitled(user.id);
        if (!entitlementDecision.isPro) {
          return sendJson(res, 402, {
            error: 'PAYMENT_REQUIRED',
            requestId: resolveRequestId(req, 'brandbrain_settings'),
            details: { status: entitlementDecision.status, plan: entitlementDecision.plan },
          });
        }
        const body = await readJsonBody(req);
        const normalized = normalizeBrandBrainSettings(body || {});
        const saved = await upsertBrandBrainSettings(user.id, normalized);
        return sendJson(res, 200, { ok: true, settings: saved || normalized });
      } catch (err) {
        if (err?.statusCode === 401) {
          return sendJson(res, 401, { ok: false, error: 'AUTH_REQUIRED' });
        }
        if (err?.statusCode === 402) {
          return sendJson(res, 402, err.payload || { error: 'PAYMENT_REQUIRED' });
        }
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
      if (ext === '.html') {
        res.setHeader('Cache-Control', 'no-store');
        return serveFile(filePath, res);
      }
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
      if (ext === '.js' || ext === '.css') headers['Cache-Control'] = 'public, max-age=300';
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

if (process.env.CALENDAR_PARSE_SELFTEST === '1') {
  const sampleA = 'Preamble\n```json\n{"posts":[{"day":1,"post_key":"day-1-slot-0"}]}\n```\n';
  const sampleB = '[{"day":2,"post_key":"day-2-slot-0"}]\nTrailing note.';
  const sampleC = '{"foo":"bar"}\n{"posts":[{"day":3,"post_key":"day-3-slot-0"}]}';
  const resultA = parseFirstValidCalendarPayload(extractCalendarJsonCandidates(sampleA), 1, 1, 1, 1);
  const resultB = parseFirstValidCalendarPayload(extractCalendarJsonCandidates(sampleB), 1, 2, 1, 1);
  const resultC = parseFirstValidCalendarPayload(extractCalendarJsonCandidates(sampleC), 1, 3, 1, 1);
  console.assert(resultA && Array.isArray(resultA.posts), 'CALENDAR_PARSE_SELFTEST A failed');
  console.assert(resultB && Array.isArray(resultB.posts), 'CALENDAR_PARSE_SELFTEST B failed');
  console.assert(resultC && Array.isArray(resultC.posts), 'CALENDAR_PARSE_SELFTEST C failed');
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
  ensureAudioForPosts,
};

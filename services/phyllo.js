const axios = require('axios');

const PHYLLO_API_BASE_URL = process.env.PHYLLO_API_BASE_URL;
if (!PHYLLO_API_BASE_URL) {
  throw new Error('PHYLLO_API_BASE_URL is required');
}
const PHYLLO_CLIENT_ID = process.env.PHYLLO_CLIENT_ID;
const PHYLLO_CLIENT_SECRET = process.env.PHYLLO_CLIENT_SECRET;
const PHYLLO_ENVIRONMENT = process.env.PHYLLO_ENVIRONMENT || 'production';
const PHYLLO_PRODUCTS_RAW = process.env.PHYLLO_PRODUCTS || '';
function getClient() {
  const basicAuth = Buffer.from(`${PHYLLO_CLIENT_ID}:${PHYLLO_CLIENT_SECRET}`).toString('base64');

  return axios.create({
    baseURL: PHYLLO_API_BASE_URL,
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/json',
    },
  });
}

async function createPhylloUser({ name, externalId }) {
  const client = getClient();
  const res = await client.post('/v1/users', {
    name,
    external_id: externalId,
  });
  return res.data;
}

async function getPhylloUserByExternalId(externalId) {
  const client = getClient();
  const res = await client.get('/v1/users', {
    params: { external_id: externalId },
  });
  const data = res.data && (res.data.data || res.data);
  if (Array.isArray(data) && data.length > 0) {
    return data[0];
  }
  return null;
}

const WORK_PLATFORMS_CACHE_TTL_MS = 5 * 60 * 1000;
const allowedWorkPlatforms = new Set(['tiktok', 'instagram', 'youtube', 'linkedin']);
let workPlatformsCache = { expiresAt: 0, ids: [] };

async function getWorkPlatformIds() {
  const now = Date.now();
  if (workPlatformsCache.expiresAt > now && Array.isArray(workPlatformsCache.ids) && workPlatformsCache.ids.length) {
    return workPlatformsCache.ids;
  }
  const client = getClient();
  const res = await client.get('/v1/work-platforms');
  const list = (res.data && (res.data.data || res.data)) || [];
  const ids = [];
  for (const item of list) {
    const rawName = String(item.name || item.platform || '');
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    if (allowedWorkPlatforms.has(name)) {
      ids.push(item.id || item.work_platform_id || item.platform_id);
    }
  }
  workPlatformsCache = {
    ids: ids.filter(Boolean).slice(0, 4),
    expiresAt: now + WORK_PLATFORMS_CACHE_TTL_MS,
  };
  return workPlatformsCache.ids;
}

async function createSdkToken({ userId, workPlatformIds = [] }) {
  const client = getClient();
  const products = parsePhylloProducts();
  const payload = {
    user_id: userId,
    products,
    environment: PHYLLO_ENVIRONMENT,
  };
  if (Array.isArray(workPlatformIds) && workPlatformIds.length) {
    payload.work_platform_ids = workPlatformIds.slice(0, 4);
  }
  const res = await client.post('/v1/sdk-tokens', payload);
  return res.data;
}

function parsePhylloProducts() {
  const parsed = PHYLLO_PRODUCTS_RAW.split(',').map((token) => token.trim()).filter(Boolean);
  if (!parsed.length) {
    return ['IDENTITY', 'ENGAGEMENT'];
  }
  return parsed;
}

async function getPhylloAccountDetails(accountId) {
  const client = getClient();
  const res = await client.get(`/v1/accounts/${accountId}`);
  return res.data;
}

async function fetchAccountContents({ accountId, since, until }) {
  const client = getClient();
  const params = {};
  if (since) params.from_date = since.toISOString();
  if (until) params.to_date = until.toISOString();
  const res = await client.get(`/v1/accounts/${accountId}/contents`, { params });
  return res.data;
}

async function fetchAccountEngagement({ accountId, since, until }) {
  const client = getClient();
  const params = {};
  if (since) params.from_date = since.toISOString();
  if (until) params.to_date = until.toISOString();
  const res = await client.get(`/v1/accounts/${accountId}/engagement`, { params });
  return res.data;
}

async function listPhylloWebhooks() {
  const client = getClient();
  const res = await client.get('/v1/webhooks');
  const payload = res.data && (res.data.data || res.data);
  return Array.isArray(payload) ? payload : [];
}

async function ensurePhylloWebhook({ webhookUrl, events, environment, description }) {
  const client = getClient();
  const hooks = await listPhylloWebhooks();
  const normalizedUrl = (webhookUrl || '').trim();
  const payload = {
    webhook_url: normalizedUrl,
    events: Array.isArray(events) ? events : [],
    environment,
    description,
  };

  const existing = hooks.find((hook) => (hook.webhook_url || '').trim() === normalizedUrl);
  if (existing && existing.id) {
    const res = await client.patch(`/v1/webhooks/${existing.id}`, payload);
    return res.data;
  }
  const res = await client.post('/v1/webhooks', payload);
  return res.data;
}

module.exports = {
  createPhylloUser,
  createSdkToken,
  getPhylloUserByExternalId,
  getPhylloAccountDetails,
  fetchAccountContents,
  fetchAccountEngagement,
  parsePhylloProducts,
  getWorkPlatformIds,
  ensurePhylloWebhook,
};

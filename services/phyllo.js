const axios = require('axios');

const PHYLLO_API_BASE_URL = process.env.PHYLLO_API_BASE_URL || 'https://api.sandbox.getphyllo.com';
const PHYLLO_CLIENT_ID = process.env.PHYLLO_CLIENT_ID;
const PHYLLO_CLIENT_SECRET = process.env.PHYLLO_CLIENT_SECRET;
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

async function createSdkToken({ userId }) {
  const client = getClient();
  const res = await client.post('/v1/sdk-tokens', {
    user_id: userId,
    products: ['IDENTITY', 'ENGAGEMENT'],
  });
  return res.data;
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

module.exports = {
  createPhylloUser,
  createSdkToken,
  getPhylloUserByExternalId,
  getPhylloAccountDetails,
  fetchAccountContents,
  fetchAccountEngagement,
};

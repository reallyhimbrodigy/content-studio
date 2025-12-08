const axios = require('axios');

const PHYLLO_API_BASE_URL = process.env.PHYLLO_API_BASE_URL || 'https://api.sandbox.getphyllo.com';
const PHYLLO_CLIENT_ID = process.env.PHYLLO_CLIENT_ID;
const PHYLLO_CLIENT_SECRET = process.env.PHYLLO_CLIENT_SECRET;
const PHYLLO_PRODUCTS = (process.env.PHYLLO_PRODUCTS || 'IDENTITY,ENGAGEMENT')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

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

async function createSdkToken({ userId }) {
  const client = getClient();
  const res = await client.post('/v1/sdk-tokens', {
    user_id: userId,
    products: PHYLLO_PRODUCTS,
  });
  return res.data;
}

module.exports = {
  createPhylloUser,
  createSdkToken,
};

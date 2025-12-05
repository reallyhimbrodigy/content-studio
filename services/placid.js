const axios = require('axios');

const PLACID_API_KEY = process.env.PLACID_API_KEY || '';
const PLACID_API_BASE = 'https://api.placid.app/api/rest';

function ensurePlacidConfigured() {
  if (!PLACID_API_KEY) {
    const err = new Error('Placid is not configured');
    err.statusCode = 501;
    throw err;
  }
}

function isPlacidConfigured() {
  return Boolean(PLACID_API_KEY);
}

async function createPlacidRender({ templateId, data }) {
  ensurePlacidConfigured();
  if (!templateId) throw new Error('missing_template_id');
  const payload = {
    template_id: templateId,
    data: {
      title: data?.title || '',
      subtitle: data?.subtitle || '',
      cta: data?.cta || '',
      brand_color: data?.brand_color || data?.brand_primary_color || '#000000',
      logo: data?.logo || data?.brand_logo_url || null,
      background_image: data?.background_image || null,
    },
  };
  const { data: response } = await axios.post(`${PLACID_API_BASE}/renders`, payload, {
    headers: { Authorization: `Bearer ${PLACID_API_KEY}` },
    timeout: 20000,
  });
  return {
    id: response?.id || response?.renderId || null,
    status: response?.status || 'queued',
    url: response?.url || response?.image_url || null,
    renderId: response?.id || response?.renderId || null,
  };
}

async function getPlacidRenderStatus(renderId) {
  ensurePlacidConfigured();
  if (!renderId) throw new Error('renderId required');
  const { data: response } = await axios.get(`${PLACID_API_BASE}/renders/${encodeURIComponent(renderId)}`, {
    headers: { Authorization: `Bearer ${PLACID_API_KEY}` },
    timeout: 15000,
  });
  return {
    id: response?.id || renderId,
    status: response?.status || 'queued',
    url: response?.url || response?.image_url || response?.result_url || null,
    raw: response,
  };
}

async function getPlacidRenderResult(renderId) {
  return getPlacidRenderStatus(renderId);
}

module.exports = {
  createPlacidRender,
  getPlacidRenderStatus,
  getPlacidRenderResult,
  isPlacidConfigured,
};

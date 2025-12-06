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

async function createPlacidRender({ templateId, data, variables }) {
  ensurePlacidConfigured();
  if (!templateId) throw new Error('missing_template_id');
  const src = variables || data || {};
  const payload = {
    template_id: templateId,
    data: {
      title: src.title || '',
      subtitle: src.subtitle || '',
      cta: src.cta || '',
      brand_color: src.brand_color || src.brand_primary_color || '#000000',
      logo: src.logo || src.brand_logo_url || null,
      background_image: src.background_image || null,
    },
  };
  try {
    const { data: response } = await axios.post(`${PLACID_API_BASE}/renders`, payload, {
      headers: { Authorization: `Bearer ${PLACID_API_KEY}` },
      timeout: 20000,
    });
    return {
      id: response?.id || response?.renderId || response?.render_id || null,
      status: response?.status || 'queued',
      url: response?.url || response?.image_url || response?.result_url || null,
      renderId: response?.id || response?.renderId || response?.render_id || null,
      raw: response,
    };
  } catch (err) {
    console.error('[Placid] createPlacidRender error', {
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data,
      url: err?.config?.url,
      templateId,
      payload,
    });
    throw err;
  }
}

async function getPlacidRenderStatus(renderId) {
  ensurePlacidConfigured();
  if (!renderId) throw new Error('renderId required');
  try {
    const { data: response } = await axios.get(`${PLACID_API_BASE}/renders/${encodeURIComponent(renderId)}`, {
      headers: { Authorization: `Bearer ${PLACID_API_KEY}` },
      timeout: 15000,
    });
    return {
      id: response?.id || response?.renderId || response?.render_id || renderId,
      status: response?.status || 'queued',
      url: response?.url || response?.image_url || response?.result_url || null,
      raw: response,
    };
  } catch (err) {
    console.error('[Placid] getPlacidRenderStatus error', {
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data,
      url: err?.config?.url,
    });
    throw err;
  }
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

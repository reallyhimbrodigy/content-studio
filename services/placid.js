const axios = require('axios');

const {
  PLACID_API_KEY,
  PLACID_POST_GRAPHIC_TEMPLATE_ID,
  PLACID_STORY_TEMPLATE_ID,
  PLACID_CAROUSEL_TEMPLATE_ID,
} = process.env;

const PLACID_API_BASE = 'https://api.placid.app/api/rest';

const VALID_TYPES = ['post_graphic', 'story', 'carousel'];

function resolvePlacidTemplateId(type) {
  const key = String(type || '').toLowerCase();
  if (key === 'story') return PLACID_STORY_TEMPLATE_ID || null;
  if (key === 'carousel') return PLACID_CAROUSEL_TEMPLATE_ID || null;
  if (key === 'post_graphic') return PLACID_POST_GRAPHIC_TEMPLATE_ID || null;
  return null;
}

async function verifyTemplateId(templateId) {
  if (!templateId) return { ok: false, reason: 'missing_id' };
  try {
    const { data } = await axios.get(`${PLACID_API_BASE}/templates/${templateId}`, {
      headers: { Authorization: `Bearer ${PLACID_API_KEY}` },
      timeout: 15000,
    });
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      reason: 'http_error',
      status: err.response?.status,
      body: err.response?.data,
    };
  }
}

async function validatePlacidTemplateConfig() {
  if (!PLACID_API_KEY) {
    console.error('[Placid] PLACID_API_KEY is missing – image generation will fail.');
    return;
  }

  const configs = [
    { type: 'post_graphic', id: PLACID_POST_GRAPHIC_TEMPLATE_ID },
    { type: 'story', id: PLACID_STORY_TEMPLATE_ID },
    { type: 'carousel', id: PLACID_CAROUSEL_TEMPLATE_ID },
  ];

  for (const cfg of configs) {
    const result = await verifyTemplateId(cfg.id);
    if (!result.ok) {
      console.error('[Placid] INVALID template config', {
        type: cfg.type,
        templateId: cfg.id,
        reason: result.reason,
        status: result.status,
        body: result.body,
      });
    } else {
      console.log('[Placid] Template verified', {
        type: cfg.type,
        templateId: cfg.id,
        name: result.data?.name,
      });
    }
  }
}

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
      background_image: src.background_image || null,
    },
  };
  try {
    const { data: response } = await axios.post(`${PLACID_API_BASE}/renders`, payload, {
      headers: { Authorization: `Bearer ${PLACID_API_KEY}` },
      timeout: 20000,
    });
    try {
      console.log('[Placid] createPlacidRender response', JSON.stringify(response));
    } catch (_) {
      console.log('[Placid] createPlacidRender response (non-serializable)');
    }
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
    try {
      console.log('[Placid] getPlacidRenderStatus response', JSON.stringify(response));
    } catch (_) {
      console.log('[Placid] getPlacidRenderStatus response (non-serializable)');
    }
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
  resolvePlacidTemplateId,
  validatePlacidTemplateConfig,
};

const axios = require('axios');

const {
  PLACID_API_KEY,
  PLACID_STORY_TEMPLATE_ID,
  PLACID_CAROUSEL_TEMPLATE_ID,
} = process.env;

const PLACID_REST_URL = 'https://api.placid.app/api/rest/images';

function resolvePlacidTemplateId(type) {
  const key = String(type || '').toLowerCase();
  if (key === 'story') return PLACID_STORY_TEMPLATE_ID || null;
  if (key === 'carousel') return PLACID_CAROUSEL_TEMPLATE_ID || null;
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
  if (!templateId) throw new Error('missing_placid_template_id');
  const src = variables || data || {};
  const payload = {
    template_uuid: templateId,
    layers: {
      title: { text: src.title || '' },
      subtitle: { text: src.subtitle || '' },
      cta: { text: src.cta || '' },
      ...(src.background_image ? { background_image: { image_url: src.background_image } } : {}),
    },
  };
  console.log('[Placid] createPlacidRender payload', { templateId, payload });
  try {
    const { data: response } = await axios.post(PLACID_REST_URL, payload, {
      headers: {
        Authorization: `Bearer ${PLACID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
    console.log('[Placid] createPlacidRender response', response);
    return {
      id: response?.id || null,
      status: 'ready',
      url: response?.url || response?.image_url || response?.image?.url || null,
      raw: response,
    };
  } catch (err) {
    console.error('[Placid] createPlacidRender error', {
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data,
    });
    throw err;
  }
}

module.exports = {
  createPlacidRender,
  isPlacidConfigured,
  resolvePlacidTemplateId,
  validatePlacidTemplateConfig,
};

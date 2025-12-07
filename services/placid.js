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

function buildPlacidLayers(variables = {}) {
  const layers = {
    title: { text: variables.title || '' },
    subtitle: { text: variables.subtitle || '' },
    cta: { text: variables.cta || '' },
  };

  if (variables.background_image) {
    layers.background_image = { image_url: variables.background_image };
  }

  return layers;
}

async function createPlacidRender({ templateId, data, variables }) {
  ensurePlacidConfigured();
  if (!templateId) throw new Error('missing_placid_template_id');
  const payload = {
    template_uuid: templateId,
    layers: buildPlacidLayers(variables || data || {}),
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

function validatePlacidTemplateConfig() {
  const states = {
    STORY_TEMPLATE_ID: PLACID_STORY_TEMPLATE_ID ? '[set]' : '[missing]',
    CAROUSEL_TEMPLATE_ID: PLACID_CAROUSEL_TEMPLATE_ID ? '[set]' : '[missing]',
  };
  if (!PLACID_API_KEY) {
    console.error('[Placid] PLACID_API_KEY is missing – image generation will fail.');
  }
  console.log('[Placid] Template env state', states);
}

module.exports = {
  createPlacidRender,
  isPlacidConfigured,
  resolvePlacidTemplateId,
  validatePlacidTemplateConfig,
  buildPlacidLayers,
};

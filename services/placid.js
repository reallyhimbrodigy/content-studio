const axios = require('axios');

const {
  PLACID_API_KEY,
  PLACID_STORY_TEMPLATE_ID,
  PLACID_CAROUSEL_TEMPLATE_ID,
} = process.env;
const { ENABLE_DESIGN_LAB } = require('../config/flags');

const PLACID_API_BASE = 'https://api.placid.app/api/rest';
const PLACID_REST_URL = `${PLACID_API_BASE}/images`;

function resolvePlacidTemplateId(type) {
  const key = String(type || '').toLowerCase();
  if (key === 'story') return PLACID_STORY_TEMPLATE_ID || null;
  if (key === 'carousel') return PLACID_CAROUSEL_TEMPLATE_ID || null;
  return null;
}

function ensurePlacidConfigured() {
  if (!ENABLE_DESIGN_LAB) {
    const err = new Error('Design Lab disabled');
    err.statusCode = 410;
    throw err;
  }
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

  // Image layers – use exact template layer names; include brand_logo as alias if template uses it
  if (variables.background_image) {
    layers.background_image = {
      image_url: variables.background_image,
    };
  }

  if (variables.logo) {
    layers.logo = {
      image_url: variables.logo,
    };
    layers.brand_logo = {
      image_url: variables.logo,
    };
  }

  // Colors
  if (variables.primary_color) {
    layers.primary_color = { color: variables.primary_color };
  }
  if (variables.secondary_color) {
    layers.secondary_color = { color: variables.secondary_color };
  }
  if (variables.accent_color) {
    layers.accent_color = { color: variables.accent_color };
  }
  if (variables.brand_color) {
    layers.brand_color = { color: variables.brand_color };
  }

  // Fonts
  if (variables.heading_font) {
    layers.heading_font = { text: variables.heading_font };
  }
  if (variables.body_font) {
    layers.body_font = { text: variables.body_font };
  }

  console.log('[Placid] buildPlacidLayers', layers);
  return layers;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createPlacidRender({ templateId, data, variables }) {
  if (!ENABLE_DESIGN_LAB) {
    return { id: null, status: 'disabled', polling_url: null, raw: null };
  }
  ensurePlacidConfigured();
  if (!templateId) throw new Error('missing_placid_template_id');
  const payload = {
    template_uuid: templateId,
    layers: buildPlacidLayers(variables || data || {}),
  };
  console.log('[Placid] createPlacidRender payload', { templateId, payload });
  try {
    const { data: response } = await axios.post(`${PLACID_API_BASE}/images`, payload, {
      headers: {
        Authorization: `Bearer ${PLACID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
    console.log('[Placid] createPlacidRender response', response);
    return {
      id: response?.id || null,
      status: response?.status || 'queued',
      polling_url: response?.polling_url || null,
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

async function pollPlacidImage(imageId, maxAttempts = 20, delayMs = 1500) {
  if (!ENABLE_DESIGN_LAB) {
    return { id: imageId, status: 'disabled', url: null, raw: null };
  }
  ensurePlacidConfigured();
  if (!imageId) throw new Error('missing_placid_image_id');
  const url = `${PLACID_API_BASE}/images/${imageId}`;
  let lastData = null;
  console.log('[Placid] pollPlacidImage start', { imageId });
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { data } = await axios.get(url, {
        headers: { Authorization: `Bearer ${PLACID_API_KEY}` },
        timeout: 10000,
      });
      lastData = data;
      const hasUrl = Boolean(data.image_url || data.transfer_url || data.url);
      console.log('[Placid] pollPlacidImage attempt', {
        attempt,
        status: data.status,
        hasUrl,
        errors: data.errors,
      });

      if ((data.status === 'ready' || data.status === 'finished') && hasUrl) {
        return {
          id: data.id,
          status: 'finished',
          url: data.image_url || data.transfer_url || data.url,
          raw: data,
        };
      }

      if (data.status === 'error') {
        return {
          id: data.id,
          status: 'error',
          url: null,
          raw: data,
        };
      }
    } catch (err) {
      console.error('[Placid] pollPlacidImage error', {
        attempt,
        message: err?.message,
        status: err?.response?.status,
        data: err?.response?.data,
      });
      return {
        id: imageId,
        status: 'error',
        url: null,
        raw: err?.response?.data || null,
      };
    }
    await wait(delayMs);
  }

  return {
    id: imageId,
    status: 'timeout',
    url: null,
    raw: lastData,
  };
}

async function validatePlacidTemplateConfig() {
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
  pollPlacidImage,
  isPlacidConfigured,
  resolvePlacidTemplateId,
  validatePlacidTemplateConfig,
  buildPlacidLayers,
};

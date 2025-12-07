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

  // Image layers: match template layer names; use image_url as expected by Placid
  if (variables.background_image) {
    layers.background_image = {
      image_url: variables.background_image,
    };
  }

  if (variables.logo) {
    layers.logo = {
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

  return layers;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollPlacidImage(pollingUrl, maxAttempts = 20, delayMs = 1000) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res;
    try {
      res = await axios.get(pollingUrl, {
        headers: { Authorization: `Bearer ${PLACID_API_KEY}` },
        timeout: 20000,
      });
    } catch (err) {
      console.error('[Placid] pollPlacidImage error', {
        attempt,
        message: err.message,
        status: err.response?.status,
        data: err.response?.data,
      });
      throw err;
    }

    const data = res?.data || {};
    const url = data.image_url || data.transfer_url || null;
    console.log('[Placid] pollPlacidImage attempt', {
      attempt,
      status: data.status,
      hasUrl: Boolean(url),
    });

    if (url) return data;

    await sleep(delayMs);
  }
  return null;
}

async function createPlacidRender({ templateId, data, variables }) {
  ensurePlacidConfigured();
  if (!templateId) throw new Error('missing_placid_template_id');
  const payload = {
    template_uuid: templateId,
    layers: buildPlacidLayers(variables || data || {}),
  };
  console.log('[Placid] createPlacidRender payload', { templateId, payload });
  let initial;
  try {
    const { data: response } = await axios.post(PLACID_REST_URL, payload, {
      headers: {
        Authorization: `Bearer ${PLACID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
    initial = response;
    console.log('[Placid] createPlacidRender response', response);
  } catch (err) {
    console.error('[Placid] createPlacidRender error', {
      message: err?.message,
      status: err?.response?.status,
      data: err?.response?.data,
    });
    throw err;
  }

  const immediateUrl = initial?.image_url || initial?.transfer_url || initial?.url || initial?.image?.url || null;
  if (immediateUrl) {
    return {
      id: initial?.id || null,
      status: initial?.status || 'ready',
      url: immediateUrl,
      raw: initial,
    };
  }

  if (!initial?.polling_url) {
    return {
      id: initial?.id || null,
      status: initial?.status || 'unknown',
      url: null,
      raw: initial,
    };
  }

  const finalData = await pollPlacidImage(initial.polling_url);
  if (!finalData) {
    return {
      id: initial?.id || null,
      status: 'timeout',
      url: null,
      raw: initial,
    };
  }

  return {
    id: finalData?.id || initial?.id || null,
    status: finalData?.status || 'ready',
    url: finalData?.image_url || finalData?.transfer_url || finalData?.url || finalData?.image?.url || null,
    raw: finalData,
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
  isPlacidConfigured,
  resolvePlacidTemplateId,
  validatePlacidTemplateConfig,
  buildPlacidLayers,
};

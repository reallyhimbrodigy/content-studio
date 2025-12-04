const PLACID_API_KEY = process.env.PLACID_API_KEY || '';
// We deliberately hardcode the REST base here to avoid stale env overrides.
const PLACID_API_BASE = 'https://api.placid.app/api/rest';
// NOTE: Placid secrets must never be exposed client-side.

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

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function placidRequest(path, { method = 'GET', body } = {}) {
  ensurePlacidConfigured();
  const url = `${PLACID_API_BASE}${path}`;
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${PLACID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const detail = await safeJson(response);
      const error = new Error(detail?.message || detail?.error || `Placid error ${response.status}`);
      error.statusCode = response.status;
      error.details = detail;
      console.error('Placid request failed', {
        base: PLACID_API_BASE,
        path,
        method,
        status: response.status,
        detail,
      });
      throw error;
    }

    return response.json();
  } catch (error) {
    console.error('Placid request error', {
      base: PLACID_API_BASE,
      path,
      method,
      message: error?.message,
      detail: error?.details || null,
    });
    throw error;
  }
}

// REST API: POST /api/rest/{template_uuid}
function buildTemplatePath(templateId) {
  if (!templateId) throw new Error('Placid template ID required');
  return `/${encodeURIComponent(templateId)}`;
}

/**
 * Create a Placid render via REST API.
 * Expects data to contain:
 *  - title, subtitle, cta (text)
 *  - logo, background_image (image URLs)
 */
async function createPlacidRender({ templateId, data }) {
  ensurePlacidConfigured();
  if (!templateId) {
    const err = new Error('Placid template ID required');
    err.statusCode = 501;
    throw err;
  }

  const src = data || {};
  const layers = {};

  if (src.title) {
    layers.title = { text: String(src.title) };
  }
  if (src.subtitle) {
    layers.subtitle = { text: String(src.subtitle) };
  }
  if (src.cta) {
    layers.cta = { text: String(src.cta) };
  }
  if (src.logo) {
    layers.logo = { image: String(src.logo) };
  }
  if (src.background_image) {
    layers.background_image = { image: String(src.background_image) };
  }

  const payload = await placidRequest(buildTemplatePath(templateId), {
    method: 'POST',
    body: { layers },
  });

  return {
    renderId: payload?.id || null,
    status: payload?.status || 'queued',
  };
}

/**
 * Poll a render via REST API: GET /api/rest/renders/{id}
 */
async function getPlacidRenderResult(renderId) {
  ensurePlacidConfigured();
  if (!renderId) throw new Error('renderId required');

  const payload = await placidRequest(`/renders/${encodeURIComponent(renderId)}`, {
    method: 'GET',
  });

  return {
    status: payload?.status || 'queued',
    imageUrl: payload?.image_url || payload?.result_url || payload?.url || '',
    raw: payload,
  };
}

module.exports = {
  createPlacidRender,
  getPlacidRenderResult,
  isPlacidConfigured,
};

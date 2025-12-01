const PLACID_API_KEY = process.env.PLACID_API_KEY || '';
const PLACID_PROJECT_ID = process.env.PLACID_PROJECT_ID || '';
const PLACID_API_BASE = process.env.PLACID_API_BASE || 'https://api.placid.app/api/v1';

function ensurePlacidConfigured() {
  if (!PLACID_API_KEY) {
    throw Object.assign(new Error('Placid is not configured'), { statusCode: 501 });
  }
}

async function placidRequest(path, { method = 'GET', body } = {}) {
  ensurePlacidConfigured();
  const url = `${PLACID_API_BASE}${path}`;
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
    throw error;
  }
  return response.json();
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function buildTemplatePath(templateId) {
  if (!templateId) throw new Error('Placid template ID required');
  if (PLACID_PROJECT_ID) {
    return `/projects/${encodeURIComponent(PLACID_PROJECT_ID)}/templates/${encodeURIComponent(templateId)}/renders`;
  }
  return `/templates/${encodeURIComponent(templateId)}/renders`;
}

async function createPlacidRender({ templateId, data }) {
  ensurePlacidConfigured();
  const payload = await placidRequest(buildTemplatePath(templateId), {
    method: 'POST',
    body: { data },
  });
  return {
    renderId: payload?.id || payload?.render_id || null,
    status: payload?.status || 'queued',
  };
}

async function getPlacidRenderResult(renderId) {
  ensurePlacidConfigured();
  if (!renderId) throw new Error('renderId required');
  const payload = await placidRequest(`/renders/${encodeURIComponent(renderId)}`, { method: 'GET' });
  return {
    status: payload?.status || 'queued',
    imageUrl: payload?.result_url || payload?.url || payload?.image_url || '',
    raw: payload,
  };
}

function isPlacidConfigured() {
  return Boolean(PLACID_API_KEY);
}

module.exports = {
  createPlacidRender,
  getPlacidRenderResult,
  isPlacidConfigured,
};

// Minimal stub for Placid integration to satisfy legacy imports without performing any work.
// All functions return safe placeholder values and never call external services.

function resolvePlacidTemplateId() {
  return null;
}

async function createPlacidRender() {
  return { id: null, status: 'disabled', url: null, raw: null };
}

async function pollPlacidImage() {
  return { id: null, status: 'disabled', url: null, raw: null };
}

function buildPlacidLayers() {
  return {};
}

function isPlacidConfigured() {
  return false;
}

async function validatePlacidTemplateConfig() {
  return;
}

module.exports = {
  resolvePlacidTemplateId,
  createPlacidRender,
  pollPlacidImage,
  buildPlacidLayers,
  isPlacidConfigured,
  validatePlacidTemplateConfig,
};

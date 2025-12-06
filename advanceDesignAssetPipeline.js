const {
  getQueuedOrRenderingAssets,
  updateDesignAssetStatus,
  DESIGN_ASSET_URL_COLUMN,
} = require('./services/supabase-admin');
const { createPlacidRender, getPlacidRenderStatus, isPlacidConfigured } = require('./services/placid');
const { uploadAssetFromUrl } = require('./services/cloudinary');
const { resolvePlacidTemplateId } = require('./services/placid-templates');

function resolveTemplateId(type) {
  return resolvePlacidTemplateId(type);
}

async function advanceDesignAssetPipeline() {
  console.log('[Pipeline] advanceDesignAssetPipeline noop – synchronous generation now handled in POST /api/design-assets');
}

module.exports = { advanceDesignAssetPipeline };

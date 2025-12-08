const { ENABLE_DESIGN_LAB } = require('./config/flags');

// Design Lab pipeline removed; keep no-op export for compatibility
async function advanceDesignAssetPipeline() {
  if (!ENABLE_DESIGN_LAB) return;
  return;
}

module.exports = { advanceDesignAssetPipeline };

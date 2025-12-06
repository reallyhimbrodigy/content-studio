const {
  getQueuedOrRenderingAssets,
  updateDesignAssetStatus,
} = require('./services/supabase-admin');
const { createPlacidRender, getPlacidRenderStatus, isPlacidConfigured } = require('./services/placid');
const { uploadAssetFromUrl } = require('./services/cloudinary');
const { resolvePlacidTemplateId } = require('./services/placid-templates');

function resolveTemplateId(type) {
  return resolvePlacidTemplateId(type);
}

async function advanceDesignAssetPipeline() {
  if (!isPlacidConfigured()) {
    return;
  }
  console.log('[Pipeline] Tick starting');
  let assets = [];
  try {
    assets = await getQueuedOrRenderingAssets();
  } catch (err) {
    console.error('[Pipeline] Unable to load queued assets', err);
    return;
  }
  if (!assets || !assets.length) {
    console.log('[Pipeline] No assets to process');
    return;
  }

  for (const asset of assets) {
    try {
      console.log('[Pipeline] Processing asset', {
        id: asset.id,
        status: asset.status,
        placid_render_id: asset.placid_render_id,
        placid_template_id: asset.placid_template_id,
      });
      // Start a render if none exists
      if (!asset.placid_render_id) {
        console.log('[Pipeline] Starting Placid render for asset', asset.id, 'type=', asset.type);
        const templateId = asset.placid_template_id || resolveTemplateId(asset.type);
        if (!templateId) {
          console.error('[Pipeline] Missing templateId for asset type', asset.type, 'asset', asset.id);
          await updateDesignAssetStatus(asset.id, {
            status: 'failed',
            data: { ...(asset.data || {}), error_message: 'missing_template_id' },
          });
          continue;
        }
        const placidRender = await createPlacidRender({
          templateId,
          data: asset.data || {},
        });
        await updateDesignAssetStatus(asset.id, {
          status: 'rendering',
          placid_render_id: placidRender.id || placidRender.renderId || null,
          data: { ...(asset.data || {}), error_message: null },
        });
        continue;
      }

      // Poll existing render
      const render = await getPlacidRenderStatus(asset.placid_render_id);
      const status = String(render.status || '').toLowerCase();
      console.log('[Pipeline] Placid render status', {
        assetId: asset.id,
        renderId: asset.placid_render_id,
        renderStatus: status,
      });

      if (['pending', 'processing', 'queued', 'rendering'].includes(status)) {
        if (asset.status !== 'rendering') {
          await updateDesignAssetStatus(asset.id, { status: 'rendering' });
        }
        continue;
      }

      if (status === 'failed' || status === 'error') {
        await updateDesignAssetStatus(asset.id, {
          status: 'failed',
          data: { ...(asset.data || {}), error_message: 'placid_render_failed' },
        });
        continue;
      }

      if (['done', 'completed', 'success'].includes(status)) {
        if (!render.url) {
          await updateDesignAssetStatus(asset.id, {
            status: 'failed',
            data: { ...(asset.data || {}), error_message: 'placid_missing_url' },
          });
          continue;
        }
        console.log('[Pipeline] Uploading to Cloudinary for asset', asset.id);
        const upload = await uploadAssetFromUrl({
          url: render.url,
          folder: 'promptly/design-assets',
        });
        const nextData = Object.assign({}, asset.data || {}, {
          preview_url: upload.secureUrl || render.url,
        });
        await updateDesignAssetStatus(asset.id, {
          status: 'ready',
          cloudinary_public_id: upload.publicId,
          image_url: upload.secureUrl || render.url,
          data: nextData,
        });
        console.log('[Pipeline] Asset marked ready', { assetId: asset.id, imageUrl: upload.secureUrl || render.url });
        continue;
      }

      console.warn('[Pipeline] Unknown Placid status for asset', asset.id, status);
      if (asset.status !== 'rendering') {
        await updateDesignAssetStatus(asset.id, { status: 'rendering' });
      }
    } catch (err) {
      console.error('[Pipeline] Error processing asset', asset.id, err);
      await updateDesignAssetStatus(asset.id, {
        status: 'failed',
        data: { ...(asset.data || {}), error_message: err.message || 'pipeline_error' },
      });
    }
  }
}

module.exports = { advanceDesignAssetPipeline };

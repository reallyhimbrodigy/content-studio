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
        try {
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
          const base = asset.data || {};
          const renderVariables = {
            title: base.title || '',
            subtitle: base.subtitle || '',
            cta: base.cta || '',
            background_image: base.background_image || null,
          };
          const placidRender = await createPlacidRender({
            templateId,
            variables: renderVariables,
          });
          await updateDesignAssetStatus(asset.id, {
            status: 'rendering',
            placid_render_id: placidRender.id || placidRender.renderId || null,
            data: { ...(asset.data || {}), error_message: null },
          });
          continue;
        } catch (err) {
          console.error('[Pipeline] Failed to start render', {
            assetId: asset.id,
            message: err?.message,
            status: err?.response?.status,
            data: err?.response?.data,
          });
          await updateDesignAssetStatus(asset.id, {
            status: 'failed',
            data: { ...(asset.data || {}), error_message: err?.message || 'placid_render_failed' },
          });
          continue;
        }
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
        const renderUrl = render.url || render?.raw?.url || render?.raw?.image_url || render?.raw?.result_url || null;
        if (!renderUrl) {
          await updateDesignAssetStatus(asset.id, {
            status: 'failed',
            data: { ...(asset.data || {}), error_message: 'placid_missing_url' },
          });
          continue;
        }
        console.log('[Pipeline] Uploading to Cloudinary for asset', asset.id);
        try {
          const upload = await uploadAssetFromUrl({
            url: renderUrl,
            folder: 'promptly/design-assets',
          });
          const nextData = Object.assign({}, asset.data || {}, {
            preview_url: upload.secureUrl || renderUrl,
            error_message: null,
          });
          await updateDesignAssetStatus(asset.id, {
            status: 'ready',
            cloudinary_public_id: upload.publicId,
            data: nextData,
          });
          console.log('[Pipeline] Asset marked ready', { assetId: asset.id, imageUrl: upload.secureUrl || renderUrl });
          continue;
        } catch (err) {
          console.error('[Pipeline] Cloudinary upload failed', {
            assetId: asset.id,
            message: err?.message,
            status: err?.statusCode || err?.response?.status,
          });
          // If Cloudinary is misconfigured, fallback to Placid URL so the user still gets a preview.
          const fallbackData = Object.assign({}, asset.data || {}, {
            preview_url: renderUrl,
            error_message: err?.statusCode === 501 ? null : err?.message || 'cloudinary_upload_failed',
          });
          if (err?.statusCode === 501) {
            await updateDesignAssetStatus(asset.id, {
              status: 'ready',
              cloudinary_public_id: null,
              data: fallbackData,
            });
            console.log('[Pipeline] Asset marked ready with Placid URL fallback', { assetId: asset.id });
            continue;
          }
          await updateDesignAssetStatus(asset.id, {
            status: 'failed',
            data: fallbackData,
          });
          continue;
        }
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

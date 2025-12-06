const { getQueuedOrRenderingAssets, updateDesignAssetStatus } = require('./services/supabase-admin');
const { createPlacidRender, getPlacidRenderStatus, isPlacidConfigured } = require('./services/placid');
const { uploadAssetFromUrl } = require('./services/cloudinary');

async function advanceDesignAssetPipeline() {
  if (!isPlacidConfigured()) return;
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
    const data = asset.data || {};
    try {
      console.log('[Pipeline] Processing asset', {
        id: asset.id,
        status: asset.status,
        placid_render_id: asset.placid_render_id,
        placid_template_id: asset.placid_template_id,
      });

      if (!asset.placid_render_id) {
        const templateId = asset.placid_template_id;
        if (!templateId) {
          console.error('[Pipeline] FAIL: missing template id for asset', { assetId: asset.id, type: asset.type });
          await updateDesignAssetStatus(asset.id, { status: 'failed' });
          continue;
        }
        const vars = {
          title: data.title || '',
          subtitle: data.subtitle || '',
          cta: data.cta || '',
          background_image: data.background_image || null,
        };
        const render = await createPlacidRender({ templateId, variables: vars });
        await updateDesignAssetStatus(asset.id, {
          status: 'rendering',
          placid_render_id: render.id || render.renderId || render.render_id || null,
          placid_template_id: templateId,
          data: { ...data, error_message: null },
        });
        continue;
      }

      const render = await getPlacidRenderStatus(asset.placid_render_id);
      const status = String(render?.status || '').toLowerCase();
      console.log('[Pipeline] Placid render status', { assetId: asset.id, status });

      if (['queued', 'pending', 'processing', 'rendering', 'running'].includes(status)) {
        if (asset.status !== 'rendering') {
          await updateDesignAssetStatus(asset.id, { status: 'rendering' });
        }
        continue;
      }

      if (['failed', 'error'].includes(status)) {
        console.error('[Pipeline] Render failed', { assetId: asset.id, render });
        await updateDesignAssetStatus(asset.id, {
          status: 'failed',
          data: { ...data, error_message: 'placid_render_failed' },
        });
        continue;
      }

      if (['done', 'completed', 'success', 'rendered', 'finished'].includes(status)) {
        const renderUrl =
          render.url ||
          render.image_url ||
          (Array.isArray(render.files) && render.files[0] && render.files[0].url) ||
          render?.raw?.url ||
          render?.raw?.image_url ||
          (Array.isArray(render?.raw?.files) && render.raw.files[0] && render.raw.files[0].url) ||
          null;
        if (!renderUrl) {
          console.error('[Pipeline] Completed render missing url', { assetId: asset.id, render });
          await updateDesignAssetStatus(asset.id, {
            status: 'failed',
            data: { ...data, error_message: 'placid_missing_url' },
          });
          continue;
        }
        try {
          const upload = await uploadAssetFromUrl({
            url: renderUrl,
            folder: 'promptly/design-assets',
          });
          const nextData = { ...data, preview_url: upload.secureUrl || renderUrl, error_message: null };
          await updateDesignAssetStatus(asset.id, {
            status: 'ready',
            cloudinary_public_id: upload.publicId,
            data: nextData,
          });
          console.log('[Pipeline] Asset ready', { assetId: asset.id });
        } catch (err) {
          console.error('[Pipeline] Cloudinary upload failed', { assetId: asset.id, message: err?.message });
          await updateDesignAssetStatus(asset.id, {
            status: 'failed',
            data: { ...data, error_message: err?.message || 'cloudinary_upload_failed' },
          });
        }
        continue;
      }

      console.warn('[Pipeline] Unknown render status', { assetId: asset.id, status });
      if (asset.status !== 'rendering') {
        await updateDesignAssetStatus(asset.id, { status: 'rendering' });
      }
    } catch (err) {
      console.error('[Pipeline] Error processing asset', { assetId: asset.id, message: err?.message });
      await updateDesignAssetStatus(asset.id, {
        status: 'failed',
        data: { ...data, error_message: err?.message || 'pipeline_error' },
      });
    }
  }
}

module.exports = { advanceDesignAssetPipeline };

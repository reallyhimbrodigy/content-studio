const { getQueuedOrRenderingAssets, updateDesignAssetStatus } = require('./services/supabase-admin');
const { createPlacidRender, isPlacidConfigured } = require('./services/placid');
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
  console.log(
    '[Pipeline] Assets to process',
    assets.map((a) => ({ id: a.id, type: a.type, status: a.status }))
  );

  for (const asset of assets) {
    const data = asset.data || {};
    try {
      console.log('[Pipeline] Processing asset', {
        id: asset.id,
        type: asset.type,
        status: asset.status,
        placid_render_id: asset.placid_render_id,
        placid_template_id: asset.placid_template_id,
      });

      const templateId = asset.placid_template_id;
      if (!templateId) {
        console.error('[Pipeline] FAIL: missing template id for asset', { assetId: asset.id, type: asset.type });
        await updateDesignAssetStatus(asset.id, {
          status: 'failed',
          data: { ...(data || {}), error_message: 'No Placid template configured for this asset type.' },
        });
        continue;
      }

      const vars = {
        title: data.title || '',
        subtitle: data.subtitle || '',
        cta: data.cta || '',
        background_image: data.background_image || null,
      };

      let render;
      try {
        render = await createPlacidRender({ templateId, variables: vars });
      } catch (err) {
        const msg =
          err?.response?.data?.message ||
          err?.message ||
          'Unable to render this asset with Placid.';
        await updateDesignAssetStatus(asset.id, {
          status: 'failed',
          data: { ...(data || {}), error_message: msg },
        });
        console.error('[Pipeline] Placid render failed', {
          assetId: asset.id,
          templateId,
          message: err?.message,
          status: err?.response?.status,
          data: err?.response?.data,
        });
        continue;
      }

      const renderUrl =
        render?.url ||
        render?.image_url ||
        render?.image?.url ||
        (Array.isArray(render?.files) && render.files[0] && render.files[0].url) ||
        (render?.raw && (render.raw.url || render.raw.image_url || (Array.isArray(render.raw.files) && render.raw.files[0] && render.raw.files[0].url))) ||
        null;

      if (!renderUrl) {
        console.error('[Pipeline] Missing URL in Placid response', { assetId: asset.id, render });
        await updateDesignAssetStatus(asset.id, {
          status: 'failed',
          data: { ...(data || {}), error_message: 'Placid did not return an image URL.' },
        });
        continue;
      }

      try {
        const upload = await uploadAssetFromUrl({
          url: renderUrl,
          folder: 'promptly/design-assets',
        });
        const nextData = { ...(data || {}), preview_url: upload.secureUrl || renderUrl, error_message: null };
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
          data: { ...(data || {}), error_message: err?.message || 'cloudinary_upload_failed' },
        });
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

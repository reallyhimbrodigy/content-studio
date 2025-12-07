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
      console.log('[Pipeline] asset data before Placid', {
        id: asset.id,
        logo: data.logo,
        background_image: data.background_image,
        primary_color: data.primary_color,
      });
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

      // Defensive fallbacks to keep Placid happy if data is missing
      if (!data.background_image) {
        data.background_image = 'https://res.cloudinary.com/demo/image/upload/sample.jpg';
      }
      if (!data.logo) {
        data.logo = 'https://res.cloudinary.com/demo/image/upload/cloudinary_logo.png';
      }

      const vars = {
        title: data.title || '',
        subtitle: data.subtitle || '',
        cta: data.cta || '',
        background_image: data.background_image || null,
        logo: data.logo || null,
        primary_color: data.primary_color || data.brand_color || null,
        secondary_color: data.secondary_color || null,
        accent_color: data.accent_color || null,
        heading_font: data.heading_font || null,
        body_font: data.body_font || null,
      };
      console.log('[Pipeline] Placid vars', { assetId: asset.id, vars });

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
        (render?.raw && (render.raw.url || render.raw.image_url || render.raw.transfer_url || render.raw.image?.url)) ||
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

const { getQueuedOrRenderingAssets, updateDesignAssetStatus } = require('./services/supabase-admin');
const { createPlacidRender, pollPlacidImage, isPlacidConfigured } = require('./services/placid');
const { uploadAssetFromUrl } = require('./services/cloudinary');
const { ENABLE_DESIGN_LAB } = require('./config/flags');

async function advanceDesignAssetPipeline() {
  if (!ENABLE_DESIGN_LAB) return;
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

      // If no render has been started, create one and store the render id
      if (!asset.placid_render_id) {
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

        try {
          const render = await createPlacidRender({ templateId, variables: vars });
          if (!render?.id) {
            await updateDesignAssetStatus(asset.id, {
              status: 'failed',
              data: { ...(data || {}), error_message: 'placid_render_id_missing' },
            });
            continue;
          }
          await updateDesignAssetStatus(asset.id, {
            status: 'rendering',
            placid_render_id: render.id,
          });
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
        }
        continue;
      }

      // If we already have a render id, poll for completion
      let renderResult;
      try {
        renderResult = await pollPlacidImage(asset.placid_render_id);
      } catch (err) {
        await updateDesignAssetStatus(asset.id, {
          status: 'failed',
          data: { ...(data || {}), error_message: err?.message || 'placid_poll_failed' },
        });
        console.error('[Pipeline] Placid poll failed', {
          assetId: asset.id,
          renderId: asset.placid_render_id,
          message: err?.message,
          status: err?.response?.status,
          data: err?.response?.data,
        });
        continue;
      }

      if ((renderResult?.status === 'finished' || renderResult?.status === 'ready') && renderResult?.url) {
        try {
          const upload = await uploadAssetFromUrl({
            url: renderResult.url,
            folder: 'promptly/design-assets',
          });
          const nextData = { ...(data || {}), preview_url: upload.secureUrl || renderResult.url, error_message: null };
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
        continue;
      }

      if (renderResult?.status === 'error' || renderResult?.status === 'timeout') {
        const errMsg =
          (renderResult?.raw && JSON.stringify(renderResult.raw)) ||
          renderResult?.status ||
          'placid_render_failed';
        await updateDesignAssetStatus(asset.id, {
          status: 'failed',
          data: { ...(data || {}), error_message: errMsg },
        });
        console.error('[Pipeline] Placid render error/timeout', {
          assetId: asset.id,
          renderId: asset.placid_render_id,
          renderResult,
        });
        continue;
      }

      // Still queued/processing without URL: do nothing; will poll next tick
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

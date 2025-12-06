const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
// NOTE: Supabase service role key is only used on the server; never expose client-side.

let supabaseAdmin = null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('⚠️ Supabase admin client is not fully configured. Design asset APIs will be disabled.');
} else {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

async function getDesignAssetById(id, userId = null) {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  let builder = supabaseAdmin.from('design_assets').select('*').eq('id', id);
  if (userId) {
    builder = builder.eq('user_id', userId);
  }
  const { data, error } = await builder.single();
  if (error || !data) {
    console.error('[Supabase] getDesignAssetById error', { id, error });
    const err = new Error(error?.message || 'Design asset not found');
    if (error?.code === 'PGRST116' || error?.details?.includes('Results contain 0 rows')) {
      err.statusCode = 404;
    }
    throw err;
  }
  return data;
}

async function updateDesignAsset(id, payload, userId = null) {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  const safePayload = {};
  if (payload.data !== undefined) safePayload.data = payload.data;
  if (payload.status !== undefined) safePayload.status = payload.status;
  if (payload.placid_render_id !== undefined) safePayload.placid_render_id = payload.placid_render_id;
  if (payload.cloudinary_public_id !== undefined) safePayload.cloudinary_public_id = payload.cloudinary_public_id;
  let builder = supabaseAdmin.from('design_assets').update(safePayload).eq('id', id);
  if (userId) {
    builder = builder.eq('user_id', userId);
  }
  const { data, error } = await builder.select('*').single();
  if (error || !data) {
    console.error('[Supabase] updateDesignAsset error', { id, error, payload });
    const err = new Error(error?.message || 'Unable to update design asset');
    if (error?.code === 'PGRST116' || error?.details?.includes('Results contain 0 rows')) {
      err.statusCode = 404;
    }
    throw err;
  }
  return data;
}

async function getQueuedOrRenderingAssets() {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  const { data, error } = await supabaseAdmin
    .from('design_assets')
    .select('*')
    .in('status', ['queued', 'rendering']);
  if (error) {
    console.error('[Supabase] getQueuedOrRenderingAssets error', error);
    throw new Error(error.message || 'Unable to load queued assets');
  }
  return data || [];
}

async function updateDesignAssetStatus(id, partial) {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  const safePartial = {};
  if (partial.status !== undefined) safePartial.status = partial.status;
  if (partial.placid_render_id !== undefined) safePartial.placid_render_id = partial.placid_render_id;
  if (partial.cloudinary_public_id !== undefined) safePartial.cloudinary_public_id = partial.cloudinary_public_id;
  if (partial.error_message !== undefined) safePartial.error_message = partial.error_message;
  if (partial.data !== undefined) safePartial.data = partial.data;
  const { data, error } = await supabaseAdmin
    .from('design_assets')
    .update(safePartial)
    .eq('id', id)
    .select('*')
    .single();
  if (error || !data) {
    console.error('[Supabase] updateDesignAssetStatus error', { id, error });
    const err = new Error(error?.message || 'Unable to update design asset status');
    throw err;
  }
  return data;
}

async function createDesignAsset(payload) {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  const { data, error } = await supabaseAdmin
    .from('design_assets')
    .insert({
      type: payload.type,
      user_id: payload.user_id,
      calendar_day_id: payload.calendar_day_id,
      data: payload.data,
      placid_render_id: payload.placid_render_id ?? null,
      status: payload.status || 'queued',
      error_message: payload.error_message ?? null,
    })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[Supabase] createDesignAsset error', error);
    throw new Error(error?.message || 'Unable to create design asset');
  }
  return data;
}

module.exports = {
  supabaseAdmin,
  getDesignAssetById,
  updateDesignAsset,
  getQueuedOrRenderingAssets,
  updateDesignAssetStatus,
  createDesignAsset,
};

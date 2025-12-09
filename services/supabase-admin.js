const { createClient } = require('@supabase/supabase-js');
const { resolvePlacidTemplateId } = require('./placid');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
// NOTE: Supabase service role key is only used on the server; never expose client-side.

const DESIGN_ASSET_URL_COLUMN = 'cloudinary_public_id';
const ALLOWED_STATUSES = ['draft', 'rendering', 'ready', 'failed'];

function normalizeDesignAssetStatus(raw) {
  if (!raw) return 'rendering';
  const value = String(raw).trim().toLowerCase();
  if (value === 'queued') return 'rendering';
  return ALLOWED_STATUSES.includes(value) ? value : 'rendering';
}

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
  if (payload.status !== undefined) safePayload.status = normalizeDesignAssetStatus(payload.status);
  if (payload.placid_render_id !== undefined) safePayload.placid_render_id = payload.placid_render_id;
  if (payload[DESIGN_ASSET_URL_COLUMN] !== undefined) safePayload[DESIGN_ASSET_URL_COLUMN] = payload[DESIGN_ASSET_URL_COLUMN];
  if (payload.placid_template_id !== undefined) safePayload.placid_template_id = payload.placid_template_id;
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
    .in('status', ['draft', 'rendering'])
    .order('created_at', { ascending: true })
    .limit(10);
  if (error) {
    console.error('[Supabase] getQueuedOrRenderingAssets error', error);
    throw new Error(error.message || 'Unable to load queued assets');
  }
  return data || [];
}

async function updateDesignAssetStatus(id, partial) {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  const safePartial = {};
  if (partial.status !== undefined) safePartial.status = normalizeDesignAssetStatus(partial.status);
  if (partial.placid_render_id !== undefined) safePartial.placid_render_id = partial.placid_render_id;
  if (partial[DESIGN_ASSET_URL_COLUMN] !== undefined) safePartial[DESIGN_ASSET_URL_COLUMN] = partial[DESIGN_ASSET_URL_COLUMN];
  if (partial.placid_template_id !== undefined) safePartial.placid_template_id = partial.placid_template_id;
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
  console.log('[Supabase] createDesignAsset payload', payload);
  const templateId = resolvePlacidTemplateId(payload.type);
  if (!templateId) {
    console.error('[Supabase] Missing placid_template_id for type', payload.type);
    throw new Error(`missing_placid_template_id_for_type_${payload.type}`);
  }
  const status = normalizeDesignAssetStatus(payload.status || 'rendering');
  const insertPayload = {
    type: payload.type,
    user_id: payload.user_id,
    calendar_day_id: payload.calendar_day_id,
    data: payload.data,
    placid_render_id: payload.placid_render_id ?? null,
    status,
    placid_template_id: templateId,
    [DESIGN_ASSET_URL_COLUMN]: null,
  };
  if (payload[DESIGN_ASSET_URL_COLUMN] !== undefined) {
    insertPayload[DESIGN_ASSET_URL_COLUMN] = payload[DESIGN_ASSET_URL_COLUMN];
  }
  const { data, error } = await supabaseAdmin
    .from('design_assets')
    .insert(insertPayload)
    .select('*')
    .single();
  if (error || !data) {
    console.error('[Supabase] createDesignAsset error', error);
    throw new Error(error?.message || 'Unable to create design asset');
  }
  return data;
}

async function upsertPhylloAccount({
  userId,
  phylloUserId,
  platform,
  accountId,
  workPlatformId,
  handle,
  displayName,
  avatarUrl,
}) {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  return supabaseAdmin
    .from('phyllo_accounts')
    .upsert(
      {
        user_id: userId,
        phyllo_user_id: phylloUserId,
        platform,
        account_id: accountId,
        work_platform_id: workPlatformId,
        handle,
        display_name: displayName,
        avatar_url: avatarUrl,
        status: 'connected',
        connected_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,account_id' }
    );
}

async function upsertPhylloPost({
  phylloAccountId,
  platform,
  platformPostId,
  title,
  caption,
  url,
  publishedAt,
}) {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  return supabaseAdmin
    .from('phyllo_posts')
    .upsert(
      {
        phyllo_account_id: phylloAccountId,
        platform,
        platform_post_id: platformPostId,
        title,
        caption,
        url,
        published_at: publishedAt,
      },
      { onConflict: 'phyllo_account_id,platform_post_id' }
    );
}

async function insertPhylloPostMetrics({
  phylloPostId,
  capturedAt,
  views,
  likes,
  comments,
  shares,
  saves,
  watchTimeSeconds,
  retentionPct,
}) {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured');
  return supabaseAdmin.from('phyllo_post_metrics').insert({
    phyllo_post_id: phylloPostId,
    captured_at: capturedAt,
    views,
    likes,
    comments,
    shares,
    saves,
    watch_time_seconds: watchTimeSeconds,
    retention_pct: retentionPct,
  });
}

module.exports = {
  supabaseAdmin,
  getDesignAssetById,
  updateDesignAsset,
  getQueuedOrRenderingAssets,
  updateDesignAssetStatus,
  createDesignAsset,
  DESIGN_ASSET_URL_COLUMN,
  upsertPhylloAccount,
  upsertPhylloPost,
  insertPhylloPostMetrics,
};

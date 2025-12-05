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
  let builder = supabaseAdmin.from('design_assets').update(payload).eq('id', id);
  if (userId) {
    builder = builder.eq('user_id', userId);
  }
  const { data, error } = await builder.select('*').single();
  if (error || !data) {
    console.error('[Supabase] updateDesignAsset error', { id, error });
    const err = new Error(error?.message || 'Unable to update design asset');
    throw err;
  }
  return data;
}

module.exports = { supabaseAdmin, getDesignAssetById, updateDesignAsset };

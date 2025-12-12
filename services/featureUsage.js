const DEFAULT_COUNT = 0;

async function getFeatureUsageCount(supabaseClient, userId, featureKey) {
  if (!supabaseClient || !userId || !featureKey) return DEFAULT_COUNT;

  const { data, error } = await supabaseClient
    .from('feature_usage')
    .select('count')
    .eq('user_id', userId)
    .eq('feature_key', featureKey)
    .maybeSingle();

  if (error) {
    // If no row exists, treat as zero; otherwise surface the error
    if (error.code === 'PGRST116' || error.code === 'PGRST123') {
      return DEFAULT_COUNT;
    }
    throw error;
  }

  if (!data || typeof data.count !== 'number') return DEFAULT_COUNT;
  return data.count;
}

async function incrementFeatureUsage(supabaseClient, userId, featureKey) {
  if (!supabaseClient || !userId || !featureKey) return DEFAULT_COUNT;

  const current = await getFeatureUsageCount(supabaseClient, userId, featureKey);
  const next = current + 1;

  const { error } = await supabaseClient
    .from('feature_usage')
    .upsert(
      {
        user_id: userId,
        feature_key: featureKey,
        count: next,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,feature_key' }
    );

  if (error) throw error;
  return next;
}

module.exports = {
  getFeatureUsageCount,
  incrementFeatureUsage,
};

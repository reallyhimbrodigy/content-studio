const DEFAULT_COUNT = 0;

let tableMissingLogged = false;
let incrementMissingLogged = false;

async function getFeatureUsageCount(supabaseClient, userId, featureKey) {
  if (!supabaseClient || !userId || !featureKey) return DEFAULT_COUNT;

  try {
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
  } catch (err) {
    const msg = String(err.message || err);
    // If the table is missing in the current environment, default to zero
    if (msg.includes('feature_usage') || msg.includes('schema cache') || msg.includes('42P01')) {
      if (!tableMissingLogged) {
        console.debug('[feature_usage] table missing; treating usage as 0');
        tableMissingLogged = true;
      }
      return DEFAULT_COUNT;
    }
    throw err;
  }
}

async function incrementFeatureUsage(supabaseClient, userId, featureKey) {
  if (!supabaseClient || !userId || !featureKey) return DEFAULT_COUNT;

  try {
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
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.includes('feature_usage') || msg.includes('schema cache') || msg.includes('42P01')) {
      if (!incrementMissingLogged) {
        console.debug('[feature_usage] table missing; skipping increment');
        incrementMissingLogged = true;
      }
      return DEFAULT_COUNT;
    }
    throw err;
  }
}

module.exports = {
  getFeatureUsageCount,
  incrementFeatureUsage,
};

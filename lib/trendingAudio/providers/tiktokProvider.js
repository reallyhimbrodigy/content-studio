const APIFY_TOKEN = process.env.APIFY_TOKEN;
const TASK_ID = process.env.APIFY_TIKTOK_TRENDING_AUDIO_TASK_ID;
const FETCH_TIMEOUT = 7800;

async function fetchTrendingTikTokAudio({ niche, limit }) {
  if (!APIFY_TOKEN || !TASK_ID) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const url = `https://api.apify.com/v2/actor-tasks/${TASK_ID}/runs?token=${APIFY_TOKEN}&limit=1`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return [];
    const data = await response.json();
    const latestRun = Array.isArray(data.data?.items) ? data.data.items[0] : null;
    const resultsUrl = latestRun?.id
      ? `https://api.apify.com/v2/actor-runs/${latestRun.id}/dataset/items?clean=1&format=json&token=${APIFY_TOKEN}`
      : null;
    if (!resultsUrl) return [];
    const resultsResp = await fetch(resultsUrl, { signal: controller.signal });
    if (!resultsResp.ok) return [];
    const candidates = await resultsResp.json();
    const normalized = Array.isArray(candidates) ? candidates : [];
    return normalized
      .slice(0, limit)
      .map((item) => ({
        platform: 'tiktok',
        id: String(item.id || item.url || `${Date.now()}-${Math.random()}`),
        title: String(item.title || 'Untitled').trim(),
        creator: String(item.creator || 'Unknown creator').trim(),
        link: String(item.url || ''),
      }))
      .filter((entry) => entry.link);
  } catch (err) {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  fetchTrendingTikTokAudio,
};

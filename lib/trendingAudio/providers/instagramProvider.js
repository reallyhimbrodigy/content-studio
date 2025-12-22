const fetch = require('node-fetch');

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const TASK_ID = process.env.APIFY_INSTAGRAM_REELS_TRENDING_AUDIO_TASK_ID;
const FETCH_TIMEOUT = 7800;

async function fetchTrendingInstagramAudio({ niche, limit }) {
  if (!APIFY_TOKEN || !TASK_ID) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const url = `https://api.apify.com/v2/actor-tasks/${TASK_ID}/runs?token=${APIFY_TOKEN}&limit=1`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return [];
    const data = await resp.json();
    const latestRun = Array.isArray(data.data?.items) ? data.data.items[0] : null;
    if (!latestRun?.id) return [];
    const datasetUrl = `https://api.apify.com/v2/actor-runs/${latestRun.id}/dataset/items?clean=1&format=json&token=${APIFY_TOKEN}`;
    const datasetResp = await fetch(datasetUrl, { signal: controller.signal });
    if (!datasetResp.ok) return [];
    const rawItems = await datasetResp.json();
    const items = Array.isArray(rawItems) ? rawItems : [];
    return items
      .slice(0, limit)
      .map((item) => ({
        platform: 'instagram',
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
  fetchTrendingInstagramAudio,
};

const fetch = require('node-fetch');

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

const apifyFetch = (taskId) => {
  const token = process.env.APIFY_TOKEN;
  if (!token || !taskId) return null;
  return async (niche, limit = 8) => {
    const cacheKey = `${taskId}:${niche}:${limit}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.items;
    }
    const url = `https://api.apify.com/v2/actor-tasks/${taskId}/runs?token=${token}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    const items = Array.isArray(data.data?.items) ? data.data.items : [];
    const normalized = items.slice(0, limit).map((item) => ({
      id: String(item.id ?? item.url ?? `${Date.now()}-${Math.random()}`),
      title: item.title?.trim() || `Untitled ${item.id || ''}`,
      creator: item.creator?.trim() || 'Unknown creator',
      url: item.url,
      platform: taskId === process.env.APIFY_TIKTOK_TRENDING_AUDIO_TASK_ID ? 'tiktok' : 'instagram',
    })).filter((entry) => entry.url);
    cache.set(cacheKey, { items: normalized, timestamp: Date.now() });
    return normalized;
  };
};

const tiktokTask = process.env.APIFY_TIKTOK_TRENDING_AUDIO_TASK_ID;
const instaTask = process.env.APIFY_INSTAGRAM_REELS_TRENDING_AUDIO_TASK_ID;

module.exports = {
  fetchTrendingTikTokAudio: tiktokTask ? apifyFetch(tiktokTask) : null,
  fetchTrendingInstagramReelsAudio: instaTask ? apifyFetch(instaTask) : null,
};

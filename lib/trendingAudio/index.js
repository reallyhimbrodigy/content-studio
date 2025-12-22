const { fetchTrendingTikTokAudio } = require('./providers/tiktokProvider');
const { fetchTrendingInstagramAudio } = require('./providers/instagramProvider');
const { rankWithOpenAI } = require('./rankWithOpenAI');

async function getTrendingAudio({ niche, postContext, limit }) {
  const [tiktok, instagram] = await Promise.all([
    fetchTrendingTikTokAudio({ niche, limit }),
    fetchTrendingInstagramAudio({ niche, limit }),
  ]);
  const merged = [...tiktok, ...instagram];
  const ranked = await rankWithOpenAI({ niche, postContext, candidates: merged, limit });
  return { items: Array.isArray(ranked) ? ranked : [] };
}

module.exports = {
  getTrendingAudio,
};

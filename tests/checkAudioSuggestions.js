const {
  buildTrendingAudioLine,
  TIKTOK_TRENDING_TOP10,
  INSTAGRAM_TRENDING_TOP10,
} = require('../server.js');

const line = buildTrendingAudioLine('basketball training coach', {
  recentTikTok: [],
  recentInstagram: [],
}).line;

if (!line.startsWith('TikTok: ')) {
  throw new Error('Audio line must start with TikTok:');
}
if (!line.includes('; Instagram: ')) {
  throw new Error('Audio line must include the Instagram portion.');
}

const [tiktokPart, instagramPart] = line.split(';').map((part) => part.trim());
const tiktokValue = tiktokPart.replace(/^TikTok:\s*/, '');
const instagramValue = instagramPart.replace(/^Instagram:\s*/, '');

if (!TIKTOK_TRENDING_TOP10.includes(tiktokValue)) {
  throw new Error('TikTok audio not drawn from list.');
}
if (!INSTAGRAM_TRENDING_TOP10.includes(instagramValue)) {
  throw new Error('Instagram audio not drawn from list.');
}

['Creator', 'undefined', 'null'].forEach((bad) => {
  if (line.includes(bad)) {
    throw new Error(`Audio line contains placeholder string: ${bad}`);
  }
});

console.log('Audio suggestions check passed.');

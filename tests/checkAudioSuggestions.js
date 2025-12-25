process.env.TRENDING_AUDIO_SKIP_FETCH = '1';

const {
  getTrendingAudioLists,
  getTrendingAudioPair,
  overrideCacheForTests,
} = require('../server/lib/trendingAudio');

const sampleTikTok = Array.from({ length: 10 }, (_, idx) => ({
  sound: `TikTok Sample ${idx + 1}`,
  creator: `@tiktok_sample${idx + 1}`,
}));
const sampleInstagram = Array.from({ length: 10 }, (_, idx) => ({
  sound: `Instagram Sample ${idx + 1}`,
  creator: `@instagram_sample${idx + 1}`,
}));

overrideCacheForTests({
  tiktok: sampleTikTok,
  instagram: sampleInstagram,
});

async function run() {
  const lists = await getTrendingAudioLists();
  const line = await getTrendingAudioPair({ tiktokIndex: 0, instagramIndex: 1, lists });
  if (!line.startsWith('TikTok: ') || !line.includes('; Instagram: ')) {
    throw new Error(`Audio line missing platform segments: ${line}`);
  }
  const [tiktokPart, instagramPart] = line.split(';').map((part) => part.trim());
  if (!tiktokPart.includes(sampleTikTok[0].sound) || !tiktokPart.includes(sampleTikTok[0].creator)) {
    throw new Error('TikTok segment did not come from the list.');
  }
  if (!instagramPart.includes(sampleInstagram[1].sound) || !instagramPart.includes(sampleInstagram[1].creator)) {
    throw new Error('Instagram segment did not come from the list.');
  }
  const placeholderRegex = new RegExp('@' + 'Creator', 'i');
  if (placeholderRegex.test(line) || /undefined/.test(line) || /null/.test(line)) {
    throw new Error('Audio line contains placeholder text.');
  }
  console.log('Audio suggestions check passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

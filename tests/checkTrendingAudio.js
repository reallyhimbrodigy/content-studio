process.env.TRENDING_AUDIO_SKIP_FETCH = '1';

const {
  getTrendingAudioLists,
  getTrendingAudioPair,
  overrideCacheForTests,
} = require('../server/lib/trendingAudio');

const sampleTikTok = Array.from({ length: 10 }, (_, idx) => ({
  sound: `TikTok Sound ${idx + 1}`,
  creator: `@tiktok${idx + 1}`,
}));
const sampleInstagram = Array.from({ length: 10 }, (_, idx) => ({
  sound: `Instagram Sound ${idx + 1}`,
  creator: `@instagram${idx + 1}`,
}));

overrideCacheForTests({
  tiktok: sampleTikTok,
  instagram: sampleInstagram,
});

async function run() {
  const lists = await getTrendingAudioLists();
  if (lists.tiktok.length !== 10 || lists.instagram.length !== 10) {
    throw new Error('Trending lists must expose 10 entries each');
  }
  const line = await getTrendingAudioPair({ tiktokIndex: 2, instagramIndex: 5, lists });
  const expectedTikTok = `TikTok: ${lists.tiktok[2].sound} — ${lists.tiktok[2].creator}`;
  const expectedInstagram = `Instagram: ${lists.instagram[5].sound} — ${lists.instagram[5].creator}`;
  if (!line.includes(expectedTikTok) || !line.includes(expectedInstagram)) {
    throw new Error(`Audio line did not reuse list entries: ${line}`);
  }
  if (!line.endsWith('.')) {
    throw new Error('Audio line must end with a period.');
  }
  const formatPattern = /^TikTok: .+ — @[^;]+; Instagram: .+ — @[^.]+.$/;
  if (!formatPattern.test(line)) {
    throw new Error(`Audio line format invalid: ${line}`);
  }
  const bannedTerms = [('@' + 'Creator'), ('@' + 'creator'), 'undefined', 'null', 'basketball', 'hoop'];
  bannedTerms.forEach((ban) => {
    if (line.toLowerCase().includes(ban.toLowerCase())) {
      throw new Error(`Audio line contains blocked term: ${ban}`);
    }
  });
  console.log('Trending audio test passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

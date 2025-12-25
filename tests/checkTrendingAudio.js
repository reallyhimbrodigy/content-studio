const { getMonthlyTrendingAudios, formatAudioLine, overrideCacheForTests } = require('../server/lib/trendingAudio');

const monthKey = new Date().toISOString().slice(0, 7);
const sampleTikTok = Array.from({ length: 10 }, (_, idx) => ({
  title: `TikTok Sound ${idx + 1}`,
  creator: `@tiktok${idx + 1}`,
}));
const sampleInstagram = Array.from({ length: 10 }, (_, idx) => ({
  title: `Instagram Sound ${idx + 1}`,
  creator: `@instagram${idx + 1}`,
}));

overrideCacheForTests({
  monthKey,
  fetchedAt: Date.now(),
  tiktok: sampleTikTok,
  instagram: sampleInstagram,
});

async function run() {
  const cache = await getMonthlyTrendingAudios({ requestId: 'test-trending-audio' });
  if (cache.monthKey !== monthKey) {
    throw new Error(`Expected monthKey ${monthKey}, got ${cache.monthKey}`);
  }
  if (cache.tiktok.length !== 10 || cache.instagram.length !== 10) {
    throw new Error('Trending lists must expose 10 entries each');
  }
  const line = formatAudioLine(0, cache.tiktok[0], cache.instagram[0]);
  const pattern = /^TikTok: .+ --@[A-Za-z0-9._]{2,}; Instagram: .+ - @[A-Za-z0-9._]{2,}$/;
  if (!pattern.test(line)) {
    throw new Error(`Audio line format invalid: ${line}`);
  }
  const bannedTerms = ['@' + 'Creator', 'undefined', 'null', 'basketball', 'hoop'];
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

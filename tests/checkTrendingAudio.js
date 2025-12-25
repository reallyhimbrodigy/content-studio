const { ensureAudioLines, getTrendingAudioLists } = require('../server.js');

async function run() {
  const posts = Array.from({ length: 10 }, (_, idx) => ({ day: idx + 1, audio: '' }));
  const trending = getTrendingAudioLists();
  await ensureAudioLines('basketball training coach', '', posts, {});
  posts.forEach((post, idx) => {
    const audio = post.audio || '';
    if (!audio.startsWith('TikTok: ') || !audio.includes('; Instagram: ')) {
      throw new Error(`Invalid audio format for day ${idx + 1}: ${audio}`);
    }
    const [tiktokPart, instagramPart] = audio.split(';').map((part) => part.trim());
    const tiktokValue = tiktokPart.replace(/^TikTok:\s*/, '').trim();
    const instagramValue = instagramPart.replace(/^Instagram:\s*/, '').trim();
    const expectedTikTok = trending.tiktok[idx % trending.tiktok.length];
    const expectedInstagram = trending.instagram[(idx + 1) % trending.instagram.length];
    const expectedTikTokText = expectedTikTok ? `${expectedTikTok.title} — ${expectedTikTok.creator}` : '';
    const expectedInstagramText = expectedInstagram ? `${expectedInstagram.title} — ${expectedInstagram.creator}` : '';
    if (tiktokValue !== expectedTikTokText) {
      throw new Error(`TikTok audio mismatch for day ${idx + 1}: got "${tiktokValue}", expected "${expectedTikTokText}"`);
    }
    if (instagramValue !== expectedInstagramText) {
      throw new Error(`Instagram audio mismatch for day ${idx + 1}: got "${instagramValue}", expected "${expectedInstagramText}"`);
    }
    ['Creator', 'undefined', 'null'].forEach((bad) => {
      if (audio.includes(bad)) {
        throw new Error(`Audio contains placeholder "${bad}" for day ${idx + 1}`);
      }
    });
  });
  console.log('Trending audio test passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

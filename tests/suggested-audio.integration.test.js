const { ensureAudioForPosts } = require('../server');
const { getEvergreenFallbackList } = require('../server/lib/billboardHot100');

const posts = Array.from({ length: 5 }, (_, idx) => ({
  day: idx + 1,
  title: `Test idea ${idx + 1}`,
  caption: `Caption ${idx + 1}`,
  script: { hook: 'Hook', body: 'Body', cta: 'CTA' },
  reelScript: { hook: 'Hook', body: 'Body', cta: 'CTA' },
  designNotes: 'Notes',
  engagementScripts: { commentReply: 'Comment', dmReply: 'DM' },
}));

const audioEntries = getEvergreenFallbackList();
const stats = ensureAudioForPosts(posts, { audioEntries });

const assert = (condition, message) => {
  if (!condition) {
    console.error('TEST FAILED:', message);
    process.exitCode = 1;
    throw new Error(message);
  }
};

assert(stats.total === posts.length, 'expected stats total match');
assert(stats.missingAudio === 0, 'expected no missing audio after assignment');

posts.forEach((post, idx) => {
  assert(post.audio, `post ${idx + 1} missing audio`);
  assert(/.+ - .+/.test(post.audio), `Audio string format missing for day ${post.day}`);
  assert(!/https?:\/\//i.test(post.audio), `Audio string contains URL for day ${post.day}`);
});

console.log('Audio assignment integration test passed.');

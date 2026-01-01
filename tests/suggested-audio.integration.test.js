const { ensureSuggestedAudioForPosts } = require('../server');

const buildList = (platform) =>
  Array.from({ length: 10 }, (_, idx) => ({
    title: `${platform} title ${idx + 1}`,
    artist: `@artist${idx + 1}`,
    url: `https://example.com/${platform}/${idx + 1}`,
  }));

const audioCache = {
  monthKey: '2024-01',
  tiktok: buildList('tiktok'),
  instagram: buildList('instagram'),
};

const posts = Array.from({ length: 5 }, (_, idx) => ({
  day: idx + 1,
  title: `Test idea ${idx + 1}`,
  caption: `Caption ${idx + 1}`,
  script: { hook: 'Hook', body: 'Body', cta: 'CTA' },
  reelScript: { hook: 'Hook', body: 'Body', cta: 'CTA' },
  designNotes: 'Notes',
  storyPrompt: 'Prompt',
  storyPromptPlus: 'Prompt plus',
  engagementScripts: { commentReply: 'Comment', dmReply: 'DM' },
}));

const stats = ensureSuggestedAudioForPosts(posts, { audioCache });

const assert = (condition, message) => {
  if (!condition) {
    console.error('TEST FAILED:', message);
    process.exitCode = 1;
    throw new Error(message);
  }
};

assert(stats.total === posts.length, 'expected stats total match');
assert(stats.missingBoth === 0, 'expected no missing audio after assignment');

posts.forEach((post, idx) => {
  assert(post.suggestedAudio, `post ${idx + 1} missing suggestedAudio`);
  assert(post.suggestedAudio.tiktok?.title, `TikTok title missing for day ${post.day}`);
  assert(post.suggestedAudio.tiktok?.artist, `TikTok artist missing for day ${post.day}`);
  assert(!/https?:\/\//i.test(post.suggestedAudio.tiktok?.title), `TikTok title contains URL for day ${post.day}`);
  assert(post.suggestedAudio.instagram?.title, `Instagram title missing for day ${post.day}`);
  assert(post.suggestedAudio.instagram?.artist, `Instagram artist missing for day ${post.day}`);
  assert(!/https?:\/\//i.test(post.suggestedAudio.instagram?.artist), `Instagram artist contains URL for day ${post.day}`);
});

console.log('Suggested audio assignment integration test passed.');

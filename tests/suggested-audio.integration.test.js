const { ensureSuggestedAudioForPosts } = require('../server');
const { getEvergreenFallbackList } = require('../server/lib/billboardHot100');

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

const audioEntries = getEvergreenFallbackList();
const stats = ensureSuggestedAudioForPosts(posts, { audioEntries });

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
  assert(post.suggestedAudio, `post ${idx + 1} missing suggestedAudio`);
  assert(/.+ - .+/.test(post.suggestedAudio), `Audio string format missing for day ${post.day}`);
  assert(!/https?:\/\//i.test(post.suggestedAudio), `Audio string contains URL for day ${post.day}`);
});

console.log('Suggested audio assignment integration test passed.');

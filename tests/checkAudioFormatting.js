const { formatAudioLine } = require('../server/lib/trendingAudio');

const tiktokSample = { title: 'Fresh Drop', creator: '@trendsetter' };
const instagramSample = { title: 'Reel Vibe', creator: '@insta_sound' };
const line = formatAudioLine(0, tiktokSample, instagramSample);

if (!line.startsWith('TikTok: ')) {
  throw new Error('Audio line must start with TikTok:');
}
if (!line.includes('; Instagram: ')) {
  throw new Error('Audio line must include the Instagram portion.');
}
const placeholderRegex = new RegExp('@' + 'Creator', 'i');
if (placeholderRegex.test(line) || /undefined/.test(line) || /null/.test(line)) {
  throw new Error('Audio line contains placeholder tokens.');
}
if (!line.includes(tiktokSample.title) || !line.includes(tiktokSample.creator)) {
  throw new Error('TikTok segment must include provided title and creator.');
}
if (!line.includes(instagramSample.title) || !line.includes(instagramSample.creator)) {
  throw new Error('Instagram segment must include provided title and creator.');
}

console.log('Audio formatting check passed.');

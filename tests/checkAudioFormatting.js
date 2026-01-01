const { getEvergreenFallbackList } = require('../server/lib/billboardHot100');

const sample = getEvergreenFallbackList()[0];
if (!sample || !sample.title || !sample.artist) {
  throw new Error('Evergreen audio sample must include title and artist.');
}
const line = `TikTok: ${sample.title} — ${sample.artist}; Instagram: ${sample.title} — ${sample.artist}`;
if (!line.includes('TikTok: ') || !line.includes('Instagram: ')) {
  throw new Error('Suggested audio format must include platform labels.');
}
if (!line.includes(' — ')) {
  throw new Error('Suggested audio format must use an em dash separator.');
}
if (/https?:\\/\\//i.test(line) || /@/.test(line)) {
  throw new Error('Suggested audio text must not include links or handles.');
}

console.log('Audio formatting check passed.');

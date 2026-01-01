const { getEvergreenFallbackList } = require('../server/lib/billboardHot100');

const sample = getEvergreenFallbackList()[0];
if (!sample || !sample.title || !sample.artist) {
  throw new Error('Evergreen audio sample must include title and artist.');
}
const line = `${sample.title} - ${sample.artist}`;
if (!/^.+ - .+$/.test(line)) {
  throw new Error('Suggested audio format must use hyphen separator.');
}
if (/https?:\\/\\//i.test(line) || /@/.test(line)) {
  throw new Error('Suggested audio text must not include links or handles.');
}

console.log('Audio formatting check passed.');

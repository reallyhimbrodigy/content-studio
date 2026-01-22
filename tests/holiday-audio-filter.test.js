const {
  isHolidayTrack,
  filterHolidayEntries,
  normalizeAudioString,
} = require('../server/lib/billboardHot100');

const assert = (condition, message) => {
  if (!condition) {
    console.error('TEST FAILED:', message);
    process.exitCode = 1;
    throw new Error(message);
  }
};

assert(isHolidayTrack("Baby It's Cold Outside", 'Dean Martin') === true, 'expected holiday track match');
assert(isHolidayTrack('Underneath the Tree', 'Kelly Clarkson') === true, 'expected holiday track match');
assert(isHolidayTrack('Rockin Around The Christmas Tree', 'Brenda Lee') === true, 'expected holiday track match');
assert(isHolidayTrack('It’s The Most Wonderful Time Of The Year', 'Andy Williams') === true, 'expected holiday track match');
assert(isHolidayTrack('Auld Lang Syne', 'Traditional') === true, 'expected holiday track match');
assert(isHolidayTrack('Blinding Lights', 'The Weeknd') === false, 'expected non-holiday track');
assert(
  normalizeAudioString('Blinding Lights', 'The Weeknd') === 'Blinding Lights - The Weeknd',
  'expected audio string normalization'
);

const sample = [
  { title: "Baby It's Cold Outside", artist: 'Dean Martin', rank: 1 },
  { title: 'Blinding Lights', artist: 'The Weeknd', rank: 2 },
];
const filtered = filterHolidayEntries(sample);
assert(filtered.length === 1, 'expected holiday track filtered out');
assert(filtered[0].title === 'Blinding Lights', 'expected non-holiday track to remain');

console.log('Holiday audio filter test passed.');

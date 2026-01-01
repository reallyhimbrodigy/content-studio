const {
  getBillboardHot100Entries,
  getEvergreenFallbackList,
  filterHolidayEntries,
} = require('../server/lib/billboardHot100');

async function run() {
  const fallback = getEvergreenFallbackList();
  if (fallback.length < 25) {
    throw new Error('Evergreen fallback list must include at least 25 entries.');
  }
  const filtered = filterHolidayEntries([{ title: 'All I Want For Christmas Is You', artist: 'Mariah Carey' }]);
  if (filtered.length !== 0) {
    throw new Error('Holiday filter must exclude classic holiday tracks.');
  }
  const result = await getBillboardHot100Entries({ requestId: 'test-billboard' });
  if (!Array.isArray(result.entries) || result.entries.length < 1) {
    throw new Error('Billboard Hot 100 must return entries.');
  }
  result.entries.slice(0, 5).forEach((entry) => {
    if (!entry.title || !entry.artist) {
      throw new Error('Billboard entries must include title and artist.');
    }
    const combined = `${entry.title} ${entry.artist}`.toLowerCase();
    if (combined.includes('http') || combined.includes('@')) {
      throw new Error('Billboard entries must not include links or handles.');
    }
  });
  console.log('Billboard audio test passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

const https = require('https');

const BILLBOARD_HOST = 'www.billboard.com';
const BILLBOARD_PATH = '/charts/hot-100/';
const BILLBOARD_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const BILLBOARD_MIN_ENTRIES = 25;
const BILLBOARD_SELECTION_COUNT = 25;

const HOLIDAY_KEYWORDS = [
  'christmas',
  'xmas',
  'holiday',
  'santa',
  'saint nick',
  'st nick',
  'claus',
  'reindeer',
  'jingle',
  'mistletoe',
  'holly',
  'yuletide',
  'noel',
  'nativity',
  'jesus',
  'mary',
  'bethlehem',
  'sleigh',
  'snow',
  'snowman',
  'gingerbread',
  'stocking',
  'carol',
  'winter',
  'winter wonderland',
  'most wonderful time',
  'happy xmas',
  'silent night',
  'deck the',
  'let it snow',
  'rudolph',
  'frosty',
  'white christmas',
  'little drummer',
  'auld lang syne',
  'underneath the tree',
  'baby its cold outside',
  'rockin around',
  'christmas tree',
  'merry',
  'season',
  'seasons',
  'grinch',
  'hanukkah',
  'menorah',
  'kwanzaa',
  'new year',
  'bell',
  'bells',
];

const HOLIDAY_EXACT_TITLES = new Set([
  'all i want for christmas is you',
  'rockin around the christmas tree',
  'rocking around the christmas tree',
  'jingle bell rock',
  'a holly jolly christmas',
  'last christmas',
  'feliz navidad',
  'its the most wonderful time of the year',
  'most wonderful time of the year',
  'let it snow',
  'let it snow let it snow let it snow',
  'santa tell me',
  'underneath the tree',
  'youre a mean one mr grinch',
  'youre a mean one mister grinch',
  'baby its cold outside',
  'silent night',
  'deck the halls',
  'white christmas',
  'winter wonderland',
  'the little drummer boy',
  'auld lang syne',
  'the christmas song',
  'mistletoe',
]);

const HOLIDAY_TITLE_ARTIST_PAIRS = new Set([
  'all i want for christmas is you|mariah carey',
  'rockin around the christmas tree|brenda lee',
  'jingle bell rock|bobby helms',
  'a holly jolly christmas|burl ives',
  'last christmas|wham',
  'feliz navidad|jose feliciano',
  'its the most wonderful time of the year|andy williams',
  'santa tell me|ariana grande',
  'underneath the tree|kelly clarkson',
  'baby its cold outside|dean martin',
  'youre a mean one mr grinch|thurl ravenscroft',
]);

const EVERGREEN_FALLBACK = [
  { rank: 1, title: 'Blinding Lights', artist: 'The Weeknd' },
  { rank: 2, title: 'As It Was', artist: 'Harry Styles' },
  { rank: 3, title: 'Flowers', artist: 'Miley Cyrus' },
  { rank: 4, title: 'Levitating', artist: 'Dua Lipa' },
  { rank: 5, title: 'bad guy', artist: 'Billie Eilish' },
  { rank: 6, title: 'Sunflower', artist: 'Post Malone & Swae Lee' },
  { rank: 7, title: 'Shape of You', artist: 'Ed Sheeran' },
  { rank: 8, title: 'STAY', artist: 'The Kid LAROI & Justin Bieber' },
  { rank: 9, title: 'Watermelon Sugar', artist: 'Harry Styles' },
  { rank: 10, title: 'Circles', artist: 'Post Malone' },
  { rank: 11, title: 'Shivers', artist: 'Ed Sheeran' },
  { rank: 12, title: 'Save Your Tears', artist: 'The Weeknd' },
  { rank: 13, title: 'Dance Monkey', artist: 'Tones and I' },
  { rank: 14, title: 'positions', artist: 'Ariana Grande' },
  { rank: 15, title: 'good 4 u', artist: 'Olivia Rodrigo' },
  { rank: 16, title: 'Peaches', artist: 'Justin Bieber' },
  { rank: 17, title: 'INDUSTRY BABY', artist: 'Lil Nas X & Jack Harlow' },
  { rank: 18, title: 'Heat Waves', artist: 'Glass Animals' },
  { rank: 19, title: 'drivers license', artist: 'Olivia Rodrigo' },
  { rank: 20, title: 'Havana', artist: 'Camila Cabello' },
  { rank: 21, title: "Don't Start Now", artist: 'Dua Lipa' },
  { rank: 22, title: 'Rockstar', artist: 'DaBaby ft. Roddy Ricch' },
  { rank: 23, title: 'Counting Stars', artist: 'OneRepublic' },
  { rank: 24, title: 'Happy', artist: 'Pharrell Williams' },
  { rank: 25, title: 'Uptown Funk', artist: 'Mark Ronson ft. Bruno Mars' },
  { rank: 26, title: 'Rolling in the Deep', artist: 'Adele' },
  { rank: 27, title: 'Call Me Maybe', artist: 'Carly Rae Jepsen' },
  { rank: 28, title: 'SICKO MODE', artist: 'Travis Scott' },
  { rank: 29, title: 'Old Town Road', artist: 'Lil Nas X' },
  { rank: 30, title: 'Someone You Loved', artist: 'Lewis Capaldi' },
];

const cache = new Map();

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripTags(value = '') {
  return String(value || '').replace(/<[^>]*>/g, '');
}

function cleanText(value = '') {
  return decodeHtmlEntities(stripTags(value)).replace(/\s+/g, ' ').trim();
}

function normalizeHolidayText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAudioString(title = '', artist = '') {
  const cleanTitle = cleanText(String(title || '')).replace(/^(tiktok|instagram)\s*:\s*/i, '');
  const cleanArtist = cleanText(String(artist || '')).replace(/^(tiktok|instagram)\s*:\s*/i, '');
  const combined = `${cleanTitle} - ${cleanArtist}`
    .replace(/[–—]/g, '-')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*["']+|["']+\s*$/g, '')
    .trim();
  return combined;
}

function isHolidayTrack(title = '', artist = '') {
  const normalizedTitle = normalizeHolidayText(title);
  const normalizedArtist = normalizeHolidayText(artist);
  if (!normalizedTitle) return false;
  if (HOLIDAY_EXACT_TITLES.has(normalizedTitle)) return true;
  if (HOLIDAY_TITLE_ARTIST_PAIRS.has(`${normalizedTitle}|${normalizedArtist}`)) return true;
  const combined = `${normalizedTitle} ${normalizedArtist}`.trim();
  return HOLIDAY_KEYWORDS.some((keyword) => combined.includes(keyword));
}

function formatChartDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftChartDate(chartDate, days) {
  const parts = String(chartDate || '').split('-').map((value) => Number(value));
  if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) return null;
  const [year, month, day] = parts;
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  date.setDate(date.getDate() + days);
  return formatChartDate(date);
}

function filterHolidayEntries(entries = []) {
  return entries.filter((entry) => entry && !isHolidayTrack(entry.title || '', entry.artist || ''));
}

function parseBillboardEntries(html = '') {
  const rows = html.split('<div class="o-chart-results-list-row-container">').slice(1);
  const entries = [];
  rows.forEach((row) => {
    const rankMatch = row.match(/data-detail-target="(\d+)"/);
    const titleMatch = row.match(/id="title-of-a-story"[^>]*>([\s\S]*?)<\/h3>/i);
    const artistMatch = row.match(/<span[^>]*class="[^"]*c-label[^"]*a-no-trucate[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const rank = rankMatch ? Number(rankMatch[1]) : null;
    const title = titleMatch ? cleanText(titleMatch[1]) : '';
    const artist = artistMatch ? cleanText(artistMatch[1]) : '';
    if (!title || !artist) return;
    entries.push({ rank: rank || entries.length + 1, title, artist });
  });
  if (!entries.length) {
    const titleMatches = Array.from(
      html.matchAll(/<h3[^>]*class="[^"]*c-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/gi)
    ).map((match) => cleanText(match[1])).filter(Boolean);
    const artistMatches = Array.from(
      html.matchAll(/<span[^>]*class="[^"]*c-label[^"]*a-no-trucate[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)
    ).map((match) => cleanText(match[1])).filter(Boolean);
    const count = Math.min(titleMatches.length, artistMatches.length);
    for (let i = 0; i < count; i += 1) {
      entries.push({ rank: i + 1, title: titleMatches[i], artist: artistMatches[i] });
    }
  }
  return entries;
}

function extractChartDate(html = '') {
  const match = html.match(/id="chart-date-picker"[^>]*data-date="([^"]+)"/i);
  return match ? match[1] : null;
}

function requestBillboardHtml(chartDate = '') {
  const path = chartDate ? `${BILLBOARD_PATH}${chartDate}/` : BILLBOARD_PATH;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: BILLBOARD_HOST,
        path,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'text/html',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`Billboard request failed (${res.statusCode})`));
          }
        });
      }
    );
    req.on('error', (err) => reject(err));
    req.end();
  });
}

function getCachedChart(chartDate) {
  if (!cache.has(chartDate)) return null;
  const cached = cache.get(chartDate);
  if (Date.now() - cached.fetchedAt > BILLBOARD_CACHE_TTL_MS) {
    cache.delete(chartDate);
    return null;
  }
  return cached;
}

async function fetchBillboardChart({ chartDate, requestId } = {}) {
  const html = await requestBillboardHtml(chartDate);
  const entries = parseBillboardEntries(html);
  const resolvedDate = extractChartDate(html) || chartDate;
  if (!entries.length) {
    throw new Error('Billboard chart parse returned 0 entries');
  }
  return { chartDate: resolvedDate, entries };
}

async function resolveLatestChart({ requestId } = {}) {
  try {
    return await fetchBillboardChart({ requestId });
  } catch (err) {
    const today = new Date();
    for (let i = 0; i < 6; i += 1) {
      const probe = new Date(today);
      probe.setDate(today.getDate() - (i * 7));
      const chartDate = formatChartDate(probe);
      try {
        return await fetchBillboardChart({ chartDate, requestId });
      } catch (probeErr) {}
    }
    throw err;
  }
}

async function getBillboardHot100({ requestId } = {}) {
  const cachedLatest = getCachedChart('latest');
  if (cachedLatest) return cachedLatest;
  const result = await resolveLatestChart({ requestId });
  const chartDate = result.chartDate || 'latest';
  const cachedByDate = getCachedChart(chartDate);
  if (cachedByDate) return cachedByDate;
  const payload = {
    chartDate,
    entries: result.entries,
    fetchedAt: Date.now(),
  };
  cache.set(chartDate, payload);
  cache.set('latest', payload);
  return payload;
}

function getEvergreenFallbackList() {
  return EVERGREEN_FALLBACK.slice(0);
}

async function getBillboardHot100Entries({ requestId } = {}) {
  // Fetch + cache the latest chart, then filter holiday tracks and fall back to evergreen list if too short.
  try {
    const result = await getBillboardHot100({ requestId });
    const filtered = filterHolidayEntries(result.entries || []);
    const filteredOut = (result.entries || []).length - filtered.length;
    if (filtered.length >= BILLBOARD_MIN_ENTRIES) {
      return {
        entries: filtered.slice(0, BILLBOARD_SELECTION_COUNT),
        chartDate: result.chartDate,
        source: 'billboard_hot100_nonholiday',
        filteredOut,
      };
    }
    if (result.chartDate) {
      const prevDate = shiftChartDate(result.chartDate, -7);
      if (prevDate) {
        try {
          const prevResult = await fetchBillboardChart({ chartDate: prevDate, requestId });
          const prevFiltered = filterHolidayEntries(prevResult.entries || []);
          const prevFilteredOut = (prevResult.entries || []).length - prevFiltered.length;
          if (prevFiltered.length >= BILLBOARD_MIN_ENTRIES) {
            return {
              entries: prevFiltered.slice(0, BILLBOARD_SELECTION_COUNT),
              chartDate: prevResult.chartDate || prevDate,
              source: 'billboard_hot100_nonholiday_prev_week',
              filteredOut: prevFilteredOut,
            };
          }
        } catch (prevErr) {}
      }
    }
    const fallback = filterHolidayEntries(getEvergreenFallbackList()).slice(0, BILLBOARD_SELECTION_COUNT);
    return {
      entries: fallback,
      chartDate: result.chartDate,
      source: 'fallback_nonholiday',
      filteredOut,
    };
  } catch (err) {
    const fallback = filterHolidayEntries(getEvergreenFallbackList()).slice(0, BILLBOARD_SELECTION_COUNT);
    return { entries: fallback, chartDate: 'fallback', source: 'fallback_nonholiday', filteredOut: 0 };
  }
}

async function getNonHolidayHot100({ chartDate = null, minCount = BILLBOARD_MIN_ENTRIES, requestId } = {}) {
  const attempts = [];
  if (chartDate) attempts.push(chartDate);
  if (!attempts.length) attempts.push('latest');
  if (attempts.length < 3) attempts.push(shiftChartDate(attempts[0], 7));
  if (attempts.length < 3) attempts.push(shiftChartDate(attempts[0], -7));

  const tracks = [];
  const seen = new Set();
  let filteredOut = 0;
  let chartDateUsed = null;
  let source = 'billboard_hot100_nonholiday';

  for (let i = 0; i < attempts.length && tracks.length < minCount; i += 1) {
    const attemptDate = attempts[i];
    if (!attemptDate) continue;
    let result;
    try {
      if (attemptDate === 'latest') {
        result = await getBillboardHot100({ requestId });
      } else {
        result = await fetchBillboardChart({ chartDate: attemptDate, requestId });
      }
    } catch (err) {
      continue;
    }
    const entries = result.entries || [];
    const filtered = filterHolidayEntries(entries);
    filteredOut += entries.length - filtered.length;
    if (!chartDateUsed && (result.chartDate || attemptDate)) {
      chartDateUsed = result.chartDate || attemptDate;
    }
    filtered.forEach((entry) => {
      const audioString = normalizeAudioString(entry.title, entry.artist);
      if (!audioString) return;
      const key = audioString.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      tracks.push({ title: cleanText(entry.title), artist: cleanText(entry.artist), rank: entry.rank, audioString });
    });
  }

  if (!tracks.length) {
    const fallback = filterHolidayEntries(getEvergreenFallbackList());
    fallback.forEach((entry) => {
      const audioString = normalizeAudioString(entry.title, entry.artist);
      if (!audioString) return;
      const key = audioString.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      tracks.push({ title: entry.title, artist: entry.artist, rank: entry.rank, audioString });
    });
    source = 'fallback_nonholiday';
    chartDateUsed = chartDateUsed || 'fallback';
  }

  return {
    chartDateUsed: chartDateUsed || 'latest',
    tracks,
    filteredOut,
    source,
  };
}

module.exports = {
  getBillboardHot100Entries,
  getNonHolidayHot100,
  getEvergreenFallbackList,
  filterHolidayEntries,
  isHolidayTrack,
  normalizeAudioString,
};

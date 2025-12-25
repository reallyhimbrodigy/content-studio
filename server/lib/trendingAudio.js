const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'trending-audio-cache.json');
const OPENAI_HOST = 'api.openai.com';
const OPENAI_PATH = '/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days retention for fallback
const CREATOR_REGEX = /^@[A-Za-z0-9._]{2,}$/;
const REQUIRED_ENTRIES = 10;

let lastSuccessfulCache = null;

function getMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('[TrendingAudio] Failed to ensure data dir', err);
  }
}

function readCacheFile() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    console.warn('[TrendingAudio] Failed to read cache file', err.message);
    return null;
  }
}

function persistCache(cache) {
  try {
    ensureDataDir();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('[TrendingAudio] Failed to write cache file', err);
  }
}

function validateList(list = []) {
  return Array.isArray(list)
    ? list
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const title = String(item.title || '').trim();
          const creator = String(item.creator || '').trim();
          if (!title || !creator || !CREATOR_REGEX.test(creator)) return null;
          if (creator.toLowerCase() === '@creator') return null;
          return { title, creator };
        })
        .filter(Boolean)
    : [];
}

function isCacheValid(cache, monthKey) {
  if (!cache || typeof cache !== 'object') return false;
  if (cache.monthKey !== monthKey) return false;
  if (!Array.isArray(cache.tiktok) || cache.tiktok.length !== REQUIRED_ENTRIES) return false;
  if (!Array.isArray(cache.instagram) || cache.instagram.length !== REQUIRED_ENTRIES) return false;
  if (!cache.tiktok.every((entry) => entry && entry.title && entry.creator)) return false;
  if (!cache.instagram.every((entry) => entry && entry.title && entry.creator)) return false;
  return true;
}

function formatAudioLine(index, tiktokEntry, instagramEntry) {
  if (!tiktokEntry || !instagramEntry) return '';
  return `TikTok: ${tiktokEntry.title} --${tiktokEntry.creator}; Instagram: ${instagramEntry.title} - ${instagramEntry.creator}`;
}

function buildPrompt(monthKey) {
  return [
    `Use the latest web search results to identify the Top 10 trending TikTok audios and Top 10 trending Instagram Reels audios for ${monthKey}.`,
    'Do not invent titles or handles; only return real audios and actual creators with @ handles.',
    'Creators must start with @ and be active, not placeholders.',
    'Respond with STRICT JSON only (no markdown, no explanation) matching this schema:',
    '{ "tiktok": [{ "title": "string", "creator": "@handle" }], "instagram": [{ "title": "string", "creator": "@handle" }] }',
    `Return exactly ${REQUIRED_ENTRIES} entries per platform.`,
    'Do not include basketball or generic filler names unless the audio truly ranks in the Top 10 for the month.',
  ].join(' ');
}

function buildPayload(monthKey) {
  return JSON.stringify({
    model: OPENAI_MODEL,
    temperature: 0.3,
    max_tokens: 1200,
    messages: [{ role: 'user', content: buildPrompt(monthKey) }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'monthly_trending_audio',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['tiktok', 'instagram'],
          properties: {
            tiktok: {
              type: 'array',
              minItems: REQUIRED_ENTRIES,
              maxItems: REQUIRED_ENTRIES,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['title', 'creator'],
                properties: {
                  title: { type: 'string' },
                  creator: { type: 'string' },
                },
              },
            },
            instagram: {
              type: 'array',
              minItems: REQUIRED_ENTRIES,
              maxItems: REQUIRED_ENTRIES,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['title', 'creator'],
                properties: {
                  title: { type: 'string' },
                  creator: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  });
}

function openAIRequest(payload, retryCount = 0, maxRetries = 3) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: OPENAI_HOST,
        path: OPENAI_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              return resolve(parsed);
            } catch (err) {
              return reject(err);
            }
          }
          if (
            [502, 503, 504].includes(res.statusCode) &&
            retryCount < maxRetries
          ) {
            const delay = Math.pow(2, retryCount) * 1000;
            return setTimeout(() => {
              openAIRequest(payload, retryCount + 1, maxRetries)
                .then(resolve)
                .catch(reject);
            }, delay);
          }
          return reject(new Error(`OpenAI error ${res.statusCode}: ${data}`));
        });
      }
    );
    req.on('error', (err) => {
      if (retryCount < maxRetries) {
        const delay = Math.pow(2, retryCount) * 1000;
        return setTimeout(() => {
          openAIRequest(payload, retryCount + 1, maxRetries)
            .then(resolve)
            .catch(reject);
        }, delay);
      }
      return reject(err);
    });
    req.write(payload);
    req.end();
  });
}

function parseResponse(json) {
  const choice = json?.choices?.[0]?.message?.content;
  if (!choice) throw new Error('Missing OpenAI content');
  try {
    return JSON.parse(choice);
  } catch (err) {
    throw new Error('Failed to parse OpenAI trending audio payload');
  }
}

async function fetchMonthlyLists(monthKey) {
  const payload = buildPayload(monthKey);
  const json = await openAIRequest(payload);
  const parsed = parseResponse(json);
  const tiktok = validateList(parsed.tiktok);
  const instagram = validateList(parsed.instagram);
  const tikCount = tiktok.length;
  const igCount = instagram.length;
  console.log(`[TrendingAudio] validation counts for ${monthKey}: TikTok=${tikCount}, Instagram=${igCount}`);
  if (tikCount !== REQUIRED_ENTRIES || igCount !== REQUIRED_ENTRIES) {
    throw new Error('Trending audio lists did not return 10 valid entries each');
  }
  return { monthKey, fetchedAt: Date.now(), tiktok, instagram };
}

async function getMonthlyTrendingAudios({ requestId } = {}) {
  const monthKey = getMonthKey();
  let cache = readCacheFile();
  if (cache && isCacheValid(cache, monthKey)) {
    console.log(`[TrendingAudio] cache hit for ${monthKey} ${requestId ? `(requestId=${requestId})` : ''}`);
    lastSuccessfulCache = cache;
    logSample(cache);
    return cache;
  }
  console.log(`[TrendingAudio] cache miss for ${monthKey} ${requestId ? `(requestId=${requestId})` : ''}`);
  try {
    const fresh = await fetchMonthlyLists(monthKey);
    persistCache(fresh);
    lastSuccessfulCache = fresh;
    logSample(fresh);
    return fresh;
  } catch (err) {
    console.warn(
      `[TrendingAudio] fetch failed for ${monthKey} ${requestId ? `(requestId=${requestId})` : ''}:`,
      err.message
    );
    if (cache && cache.tiktok && cache.instagram) {
      console.warn('[TrendingAudio] falling back to previous valid cache', cache.monthKey);
      logSample(cache);
      return cache;
    }
    if (lastSuccessfulCache) {
      console.warn('[TrendingAudio] falling back to last successful cache', lastSuccessfulCache.monthKey);
      logSample(lastSuccessfulCache);
      return lastSuccessfulCache;
    }
    throw err;
  }
}

function logSample(cache) {
  if (!cache || !cache.tiktok || !cache.instagram) return;
  const sampleLines = [
    formatAudioLine(0, cache.tiktok[0], cache.instagram[0]),
    formatAudioLine(1, cache.tiktok[1], cache.instagram[1]),
  ].filter(Boolean);
  console.log('[TrendingAudio] sample lines:', sampleLines);
}

function overrideCacheForTests(cache) {
  if (!cache || typeof cache !== 'object') return;
  lastSuccessfulCache = cache;
  persistCache(cache);
}

module.exports = {
  getMonthlyTrendingAudios,
  formatAudioLine,
  overrideCacheForTests,
};

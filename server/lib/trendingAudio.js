const https = require('https');

const OPENAI_HOST = 'api.openai.com';
const OPENAI_PATH = '/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';
const REQUIRED_ENTRIES = 10;
const CREATOR_REGEX = /^@[A-Za-z0-9._]{2,}$/;

let cachedMonthKey = null;
let cachedAudio = null;
let overrideCache = null;

function getMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function buildPrompt(monthKey, extraInstructions = '') {
  const lines = [
    `Gather the current Top 10 trending TikTok audios and Top 10 trending Instagram Reels audios for ${monthKey}.`,
    'Each entry must represent a real, current audio with its creator handle.',
    'Respond with STRICT JSON only, no explanation, following the schema below.',
    '{ "tiktok": [ { "title": "string", "creator": "@handle", "url": "https://..." } ], "instagram": [ { "title": "string", "creator": "@handle", "url": "https://..." } ] }',
    `Return exactly ${REQUIRED_ENTRIES} entries for each platform.`,
    'Do not invent creators, placeholders, or example names.',
  ];
  if (extraInstructions) lines.push(extraInstructions);
  return lines.join('\n');
}

function buildPayload(monthKey, extraInstructions = '') {
  return JSON.stringify({
    model: OPENAI_MODEL,
    temperature: 0.3,
    max_tokens: 1200,
    messages: [{ role: 'user', content: buildPrompt(monthKey, extraInstructions) }],
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
                required: ['title', 'creator', 'url'],
                properties: {
                  title: { type: 'string' },
                  creator: { type: 'string' },
                  url: { type: 'string' },
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
                required: ['title', 'creator', 'url'],
                properties: {
                  title: { type: 'string' },
                  creator: { type: 'string' },
                  url: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  });
}

function openAIRequest(payload, retryCount = 0, maxRetries = 2) {
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
          if ([502, 503, 504].includes(res.statusCode) && retryCount < maxRetries) {
            const delay = Math.pow(2, retryCount) * 1000;
            return setTimeout(() => {
              openAIRequest(payload, retryCount + 1, maxRetries).then(resolve).catch(reject);
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
          openAIRequest(payload, retryCount + 1, maxRetries).then(resolve).catch(reject);
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
  if (typeof choice === 'string') {
    try {
      return JSON.parse(choice);
    } catch (err) {
      throw new Error('Failed to parse OpenAI trending audio payload');
    }
  }
  return choice;
}

function isValidUrl(url = '', platform = '') {
  const cleaned = String(url || '').trim();
  if (!cleaned.startsWith('https://')) return false;
  const lower = cleaned.toLowerCase();
  if (platform === 'TikTok' && !lower.includes('tiktok.com')) return false;
  if (platform === 'Instagram' && !lower.includes('instagram.com')) return false;
  return true;
}

function ensureTrendingEntries(list, platform = 'TikTok') {
  if (!Array.isArray(list) || list.length !== REQUIRED_ENTRIES) {
    const err = new Error(`Expected ${REQUIRED_ENTRIES} ${platform} entries`);
    err.code = 'TRENDING_AUDIO_INVALID';
    throw err;
  }
  return list.map((item, idx) => {
    if (!item || typeof item !== 'object') {
      const err = new Error(`Invalid ${platform} entry at index ${idx}`);
      err.code = 'TRENDING_AUDIO_INVALID';
      throw err;
    }
    const title = String(item.title || '').trim();
    const creator = String(item.creator || '').trim();
    const url = String(item.url || '').trim();
    if (!title || !creator || !url) {
      const err = new Error(`Missing metadata for ${platform} entry at index ${idx}`);
      err.code = 'TRENDING_AUDIO_INVALID';
      throw err;
    }
    if (!isValidUrl(url, platform)) {
      const err = new Error(`Invalid URL for ${platform} entry at index ${idx}`);
      err.code = 'TRENDING_AUDIO_INVALID';
      throw err;
    }
    if (!CREATOR_REGEX.test(creator)) {
      const err = new Error(`Invalid creator handle for ${platform} entry at index ${idx}`);
      err.code = 'TRENDING_AUDIO_INVALID';
      throw err;
    }
    return { title, artist: creator, url };
  });
}

async function requestTrendingAudio({ monthKey, requestId, extraInstructions = '' } = {}) {
  const payload = buildPayload(monthKey, extraInstructions);
  const json = await openAIRequest(payload);
  const parsed = parseResponse(json);
  const tiktokEntries = ensureTrendingEntries(parsed.tiktok, 'TikTok');
  const instagramEntries = ensureTrendingEntries(parsed.instagram, 'Instagram');
  console.log(
    `[TrendingAudio] fetched data for ${monthKey}${requestId ? ` (requestId=${requestId})` : ''}`
  );
  return { monthKey, tiktok: tiktokEntries, instagram: instagramEntries };
}

async function fetchTrendingAudioTop10({ monthKey: providedMonthKey, requestId } = {}) {
  const monthKey = providedMonthKey || getMonthKey();
  let lastError = null;
  try {
    return await requestTrendingAudio({ monthKey, requestId });
  } catch (err) {
    lastError = err;
    console.warn('[TrendingAudio] first fetch attempt failed', { monthKey, requestId, reason: err.message });
  }
  try {
    return await requestTrendingAudio({
      monthKey,
      requestId,
      extraInstructions: 'Retry: return only JSON that strictly matches the requested schema with no extra text.',
    });
  } catch (err) {
    const failure = new Error(`Trending audio invalid: ${err.message || lastError?.message || 'unknown'}`);
    failure.code = err.code || lastError?.code || 'TRENDING_AUDIO_UNAVAILABLE';
    throw failure;
  }
}

async function getMonthlyTrendingAudios({ requestId } = {}) {
  const monthKey = getMonthKey();
  if (overrideCache) {
    console.log(`[TrendingAudio] using override cache for ${monthKey}`);
    return overrideCache;
  }
  if (cachedMonthKey === monthKey && cachedAudio) {
    console.log(`[TrendingAudio] cache hit for ${monthKey}`);
    return cachedAudio;
  }
  const fresh = await fetchTrendingAudioTop10({ monthKey, requestId });
  cachedMonthKey = monthKey;
  cachedAudio = fresh;
  return fresh;
}

function formatAudioLine(index, tiktokEntry, instagramEntry) {
  if (!tiktokEntry || !instagramEntry) return '';
  return `TikTok: ${tiktokEntry.title} --${tiktokEntry.artist}; Instagram: ${instagramEntry.title} - ${instagramEntry.artist}`;
}

function overrideCacheForTests(cache) {
  if (!cache || typeof cache !== 'object') return;
  overrideCache = cache;
}

module.exports = {
  getMonthlyTrendingAudios,
  fetchTrendingAudioTop10,
  formatAudioLine,
  overrideCacheForTests,
};

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'trending-audio.json');
const CACHE_TTL = 24 * 60 * 60 * 1000;
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000;
const OPENAI_HOST = 'api.openai.com';
const OPENAI_PATH = '/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';
const BLOCKED_TERMS = [
  'basketball',
  'hoop',
  'nba',
  'wnba',
  'dunk',
  'dribble',
  'court',
  'ball',
  'baseline',
  'grind',
  'hustle',
  'game clock',
];

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const SKIP_FETCH = process.env.TRENDING_AUDIO_SKIP_FETCH === '1';

let trendingCache = {
  updatedAt: 0,
  tiktok: [],
  instagram: [],
};
let refreshPromise = null;

function ensureDataDirectory() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    // ignore: higher-level code may log runtime errors
  }
}

function persistCache() {
  try {
    ensureDataDirectory();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(trendingCache, null, 2), 'utf8');
  } catch (err) {
    console.error('[TrendingAudio] Failed to persist cache', err);
  }
}

function loadPersistedCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.tiktok)) parsed.tiktok = [];
    if (!Array.isArray(parsed.instagram)) parsed.instagram = [];
    return {
      updatedAt: Number(parsed.updatedAt) || 0,
      tiktok: parsed.tiktok,
      instagram: parsed.instagram,
    };
  } catch (err) {
    console.error('[TrendingAudio] Failed to load persisted cache', err);
    return null;
  }
}

function blocklisted(value = '') {
  const text = String(value || '').toLowerCase();
  return BLOCKED_TERMS.some((term) => text.includes(term));
}

function sanitizeEntry(entry = {}) {
  const sound = String(entry.sound || '').trim();
  const creator = String(entry.creator || '').trim();
  if (!sound || !creator || !creator.startsWith('@') || creator.length <= 2) {
    return null;
  }
  if (blocklisted(sound) || blocklisted(creator)) {
    return null;
  }
  return { sound, creator };
}

function mergeEntries(primary = [], secondary = [], limit = 10) {
  const seen = new Set();
  const merged = [];
  const pushEntry = (entry) => {
    if (!entry) return;
    const key = `${entry.sound}||${entry.creator}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(entry);
  };
  primary.forEach(pushEntry);
  secondary.forEach(pushEntry);
  return merged.slice(0, limit);
}

function formatAudioLine(tiktokEntry, instagramEntry) {
  if (!tiktokEntry || !instagramEntry) return '';
  return `TikTok: ${tiktokEntry.sound} — ${tiktokEntry.creator}; Instagram: ${instagramEntry.sound} — ${instagramEntry.creator}.`;
}

function buildRequestPayload() {
  const prompt = [
    'You are a highly reliable music trend curator.',
    'Provide the current Top 10 trending TikTok audio and Top 10 trending Instagram audio.',
    'Do NOT invent titles, creators, or handles. Only include real, current, global trending entries.',
    'Exclude any mention of basketball, hoop, NBA, WNBA, dunk, dribble, court, ball, baseline, grind, hustle, or game clock.',
    'Return the response EXACTLY as valid JSON matching the schema below. Do not include markdown fences or commentary.',
    'Schema: { "tiktok": [{ "sound": "string", "creator": "@handle" } x10], "instagram": [{ "sound": "string", "creator": "@handle" } x10] }',
    'Creators must start with "@" and be a real username. Sounds must be descriptive audio names (no placeholders).',
    'Provide current, trend-focused entries only; no niche-themed or sport-specific cues.',
  ].join(' ');
  return JSON.stringify({
    model: OPENAI_MODEL,
    temperature: 0.4,
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'trending_audio',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['tiktok', 'instagram'],
          properties: {
            tiktok: {
              type: 'array',
              minItems: 10,
              maxItems: 10,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['sound', 'creator'],
                properties: {
                  sound: { type: 'string' },
                  creator: { type: 'string' },
                },
              },
            },
            instagram: {
              type: 'array',
              minItems: 10,
              maxItems: 10,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['sound', 'creator'],
                properties: {
                  sound: { type: 'string' },
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
    const options = {
      hostname: OPENAI_HOST,
      path: OPENAI_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } else if ((res.statusCode === 502 || res.statusCode === 503 || res.statusCode === 504) && retryCount < maxRetries) {
            const delay = Math.pow(2, retryCount) * 1000;
            setTimeout(() => {
              openAIRequest(payload, retryCount + 1, maxRetries).then(resolve).catch(reject);
            }, delay);
          } else {
            reject(new Error(`OpenAI error ${res.statusCode}: ${data || res.statusMessage}`));
          }
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', (err) => {
      if (retryCount < maxRetries) {
        const delay = Math.pow(2, retryCount) * 1000;
        setTimeout(() => {
          openAIRequest(payload, retryCount + 1, maxRetries).then(resolve).catch(reject);
        }, delay);
      } else {
        reject(err);
      }
    });
    req.write(payload);
    req.end();
  });
}

function extractJsonObject(raw = '') {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Invalid JSON object from OpenAI');
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function fetchTrendingLists() {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set for trending audio refresh');
  }
  const payload = buildRequestPayload();
  const json = await openAIRequest(payload);
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content returned from OpenAI trending audio call');
  const parsed = extractJsonObject(content);
  const tiktok = Array.isArray(parsed.tiktok) ? parsed.tiktok.map(sanitizeEntry).filter(Boolean) : [];
  const instagram = Array.isArray(parsed.instagram) ? parsed.instagram.map(sanitizeEntry).filter(Boolean) : [];
  return { tiktok, instagram };
}

async function refreshTrendingAudioLists(force = false) {
  if (SKIP_FETCH) return trendingCache;
  if (!force && trendingCache.updatedAt && Date.now() - trendingCache.updatedAt < CACHE_TTL) {
    return trendingCache;
  }
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const persisted = loadPersistedCache();
      if (!force && persisted && Date.now() - persisted.updatedAt < CACHE_TTL) {
        trendingCache = persisted;
        return trendingCache;
      }
      let lists = await fetchTrendingLists();
      if (lists.tiktok.length < 10 || lists.instagram.length < 10) {
        try {
          const refill = await fetchTrendingLists();
          lists = {
            tiktok: mergeEntries(lists.tiktok, refill.tiktok, 10),
            instagram: mergeEntries(lists.instagram, refill.instagram, 10),
          };
        } catch (err) {
          console.warn('[TrendingAudio] Refill fetch failed', err.message);
        }
      }
      trendingCache = {
        updatedAt: Date.now(),
        tiktok: lists.tiktok.slice(0, 10),
        instagram: lists.instagram.slice(0, 10),
      };
      persistCache();
      return trendingCache;
    } catch (err) {
      console.error('[TrendingAudio] Failed to refresh lists', err);
      if (trendingCache.tiktok.length && trendingCache.instagram.length) {
        return trendingCache;
      }
      trendingCache = { updatedAt: Date.now(), tiktok: [], instagram: [] };
      return trendingCache;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function getTrendingAudioLists() {
  if (!trendingCache.updatedAt) {
    const persisted = loadPersistedCache();
    if (persisted) {
      trendingCache = persisted;
    }
  }
  if (!SKIP_FETCH) {
    await refreshTrendingAudioLists();
  }
  return {
    tiktok: [...trendingCache.tiktok],
    instagram: [...trendingCache.instagram],
  };
}

async function getTrendingAudioPair({ tiktokIndex = 0, instagramIndex = 0, lists = null } = {}) {
  const source = lists || (await getTrendingAudioLists());
  if (!source.tiktok.length || !source.instagram.length) return '';
  const tiktok = source.tiktok[tiktokIndex % source.tiktok.length];
  const instagram = source.instagram[instagramIndex % source.instagram.length];
  return formatAudioLine(tiktok, instagram);
}

function overrideCacheForTests(entries = {}) {
  trendingCache = {
    updatedAt: Date.now(),
    tiktok: Array.isArray(entries.tiktok) ? entries.tiktok.map(sanitizeEntry).filter(Boolean) : [],
    instagram: Array.isArray(entries.instagram) ? entries.instagram.map(sanitizeEntry).filter(Boolean) : [],
  };
}

if (!SKIP_FETCH) {
  refreshTrendingAudioLists().catch((err) => {
    console.error('[TrendingAudio] Initial refresh failed', err);
  });
  setInterval(() => {
    refreshTrendingAudioLists(true).catch((err) => {
      console.error('[TrendingAudio] Scheduled refresh failed', err);
    });
  }, REFRESH_INTERVAL);
}

module.exports = {
  getTrendingAudioLists,
  getTrendingAudioPair,
  formatAudioLine,
  overrideCacheForTests,
};

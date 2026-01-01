const https = require('https');
let supabaseAdmin;
let supabaseImportWarningLogged = false;
try {
  const supabaseService = require('../../services/supabase-admin');
  supabaseAdmin = supabaseService?.supabaseAdmin || null;
} catch (err) {
  supabaseAdmin = null;
  if (!supabaseImportWarningLogged) {
    console.warn('[TrendingAudio] Supabase admin client unavailable; trending audio persistence will fail', err?.message);
    supabaseImportWarningLogged = true;
  }
}

const OPENAI_HOST = 'api.openai.com';
const OPENAI_PATH = '/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';
const CREATOR_REGEX = /^@[A-Za-z0-9._]{2,}$/;
const REQUIRED_ENTRIES = 10;

function getMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function ensureSupabase() {
  if (!supabaseAdmin) {
    const err = new Error('Supabase admin client not configured');
    err.code = 'TRENDING_AUDIO_UNAVAILABLE';
    throw err;
  }
}

function formatAudioLine(index, tiktokEntry, instagramEntry) {
  if (!tiktokEntry || !instagramEntry) return '';
  return `TikTok: ${tiktokEntry.title} --${tiktokEntry.artist}; Instagram: ${instagramEntry.title} - ${instagramEntry.artist}`;
}

async function readMonthlyAudio(monthKey) {
  ensureSupabase();
  const { data, error } = await supabaseAdmin
    .from('trending_audio_monthly')
    .select('month_key, tiktok, instagram, source, created_at')
    .eq('month_key', monthKey)
    .maybeSingle();
  if (error) {
    const err = new Error(`Failed to read trending audio from DB: ${error.message}`);
    err.code = 'TRENDING_AUDIO_UNAVAILABLE';
    throw err;
  }
  return data;
}

async function upsertMonthlyAudio({ monthKey, tiktok, instagram, source = 'openai' }) {
  ensureSupabase();
  const payload = {
    month_key: monthKey,
    tiktok,
    instagram,
    source,
    created_at: new Date().toISOString(),
  };
  const { error } = await supabaseAdmin
    .from('trending_audio_monthly')
    .upsert(payload, { onConflict: 'month_key' });
  if (error) {
    const err = new Error(`Failed to persist trending audio: ${error.message}`);
    err.code = 'TRENDING_AUDIO_UNAVAILABLE';
    throw err;
  }
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

function isValidUrl(url = '') {
  return /^https:\/\/[^\s]+$/i.test(String(url || '').trim());
}

function ensureTrendingEntries(list, platform = 'tikTok') {
  if (!Array.isArray(list) || list.length !== REQUIRED_ENTRIES) {
    const err = new Error(`Expected ${REQUIRED_ENTRIES} ${platform} entries`);
    err.code = 'TRENDING_AUDIO_INVALID';
    throw err;
  }
  return list.map((item, idx) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Invalid ${platform} entry at index ${idx}`);
    }
    const title = String(item.title || item.name || '').trim();
    const artist = String(item.artist || item.creator || '').trim();
    const url = String(item.url || '').trim();
    if (!title || !artist || !isValidUrl(url)) {
      const err = new Error(`Invalid ${platform} metadata at index ${idx}`);
      err.code = 'TRENDING_AUDIO_INVALID';
      throw err;
    }
    return { title, artist, url };
  });
}

async function fetchTrendingAudioTop10({ monthKey: providedMonthKey } = {}) {
  const monthKey = providedMonthKey || getMonthKey();
  const payload = buildPayload(monthKey);
  const json = await openAIRequest(payload);
  const parsed = parseResponse(json);
  const tiktokEntries = ensureTrendingEntries(parsed.tiktok, 'TikTok');
  const instagramEntries = ensureTrendingEntries(parsed.instagram, 'Instagram');
  console.log(`[TrendingAudio] fetched top10 for ${monthKey}`);
  return {
    monthKey,
    tiktok: tiktokEntries,
    instagram: instagramEntries,
  };
}

async function getMonthlyTrendingAudios({ requestId } = {}) {
  const monthKey = getMonthKey();
  let cached = null;
  try {
    cached = await readMonthlyAudio(monthKey);
  } catch (err) {
    console.warn('[TrendingAudio] read failure', err.message);
  }
  if (cached && cached.tiktok && cached.instagram) {
    console.log(
      `[TrendingAudio] cache hit (db) for ${monthKey} ${requestId ? `(requestId=${requestId})` : ''}`
    );
    console.log(
      `[TrendingAudio] source=db month=${monthKey} tik=${cached.tiktok.length} ig=${cached.instagram.length}`
    );
    logSample(cached);
    return {
      monthKey: cached.month_key || monthKey,
      tiktok: cached.tiktok,
      instagram: cached.instagram,
    };
  }
  try {
    const fresh = await fetchTrendingAudioTop10({ monthKey });
    await upsertMonthlyAudio({
      monthKey: fresh.monthKey,
      tiktok: fresh.tiktok,
      instagram: fresh.instagram,
      source: 'openai',
    });
    logSample(fresh);
    console.log(
      `[TrendingAudio] source=openai month=${fresh.monthKey} tik=${fresh.tiktok.length} ig=${fresh.instagram.length}`
    );
    return fresh;
  } catch (err) {
    const fetchErr = new Error(`Trending audio unavailable: ${err.message || 'unknown error'}`);
    fetchErr.code = err.code || 'TRENDING_AUDIO_UNAVAILABLE';
    throw fetchErr;
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

async function overrideCacheForTests(cache) {
  if (!cache || typeof cache !== 'object') return;
  await upsertMonthlyAudio({
    monthKey: cache.monthKey || cache.month_key,
    tiktok: cache.tiktok,
    instagram: cache.instagram,
    source: cache.source || 'test',
  });
}

module.exports = {
  getMonthlyTrendingAudios,
  fetchTrendingAudioTop10,
  formatAudioLine,
  overrideCacheForTests,
};

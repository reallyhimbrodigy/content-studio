const Anthropic = require('@anthropic-ai/sdk');

const CLAUDE_MODEL = 'claude-opus-4-6';
const REQUIRED_ENTRIES = 10;
const CREATOR_REGEX = /^@[A-Za-z0-9._]{2,}$/;

let cachedMonthKey = null;
let cachedAudio = null;
let overrideCache = null;

function getMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function getAnthropicClient() {
  const apiKey = process.env.CLAUDE_API_KEY || '';
  if (!apiKey) {
    const err = new Error('CLAUDE_API_KEY is not configured');
    err.code = 'CLAUDE_NOT_CONFIGURED';
    throw err;
  }
  return new Anthropic({ apiKey });
}

function buildPrompt(monthKey, extraInstructions = '') {
  const lines = [
    `Gather the current Top 10 trending TikTok audios and Top 10 trending Instagram Reels audios for ${monthKey}.`,
    'Each entry must represent a real, current audio with its creator handle.',
    'Respond with STRICT JSON only, no explanation, using this exact schema:',
    '{ "tiktok": [ { "title": "string", "creator": "@handle", "url": "https://..." } ], "instagram": [ { "title": "string", "creator": "@handle", "url": "https://..." } ] }',
    `Return exactly ${REQUIRED_ENTRIES} entries for each platform.`,
    'Do not invent creators, placeholders, or example names.',
  ];
  if (extraInstructions) lines.push(extraInstructions);
  lines.push('CRITICAL: Return ONLY valid JSON. No markdown, no code fences, no prose.');
  return lines.join('\n');
}

function stripJsonFences(raw = '') {
  return String(raw || '')
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();
}

async function claudeRequest(promptText) {
  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    temperature: 0.2,
    messages: [{ role: 'user', content: promptText }],
  });

  const text = Array.isArray(response?.content)
    ? response.content
        .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text)
        .join('\n')
    : '';

  if (!text) {
    throw new Error('Missing Claude content');
  }

  const cleaned = stripJsonFences(text);
  return JSON.parse(cleaned);
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
  const parsed = await claudeRequest(buildPrompt(monthKey, extraInstructions));
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

function buildDeterministicFallback(monthKey) {
  const seeded = (prefix, host) =>
    Array.from({ length: REQUIRED_ENTRIES }, (_, idx) => ({
      title: `${prefix} ${String(idx + 1).padStart(2, '0')}`,
      artist: `@${prefix.toLowerCase().replace(/\s+/g, '')}${idx + 1}`,
      url: `https://${host}/audio/${monthKey.replace('-', '')}-${idx + 1}`,
    }));

  return {
    monthKey,
    tiktok: seeded('TikTok trend', 'www.tiktok.com'),
    instagram: seeded('Reels trend', 'www.instagram.com'),
    fallback: true,
  };
}

async function getTrendingAudioTop10({ forceRefresh = false, requestId = '' } = {}) {
  if (overrideCache) {
    return overrideCache;
  }

  const monthKey = getMonthKey();
  if (!forceRefresh && cachedAudio && cachedMonthKey === monthKey) {
    return cachedAudio;
  }

  try {
    const data = await fetchTrendingAudioTop10({ monthKey, requestId });
    cachedMonthKey = monthKey;
    cachedAudio = data;
    return data;
  } catch (err) {
    console.error('[TrendingAudio] live fetch failed, using deterministic fallback', {
      monthKey,
      requestId,
      reason: err?.message || err,
    });
    const fallback = buildDeterministicFallback(monthKey);
    cachedMonthKey = monthKey;
    cachedAudio = fallback;
    return fallback;
  }
}

function setTrendingAudioOverride(override = null) {
  if (!override) {
    overrideCache = null;
    return;
  }
  const monthKey = override.monthKey || getMonthKey();
  const normalized = {
    monthKey,
    tiktok: ensureTrendingEntries(override.tiktok || [], 'TikTok'),
    instagram: ensureTrendingEntries(override.instagram || [], 'Instagram'),
  };
  overrideCache = normalized;
}

function clearTrendingAudioCache() {
  cachedMonthKey = null;
  cachedAudio = null;
}

module.exports = {
  getTrendingAudioTop10,
  setTrendingAudioOverride,
  clearTrendingAudioCache,
};

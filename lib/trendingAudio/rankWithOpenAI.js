const fetch = require('node-fetch');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const buildPrompt = ({ niche, postContext, candidates, limit }) => {
  const contextParts = [];
  if (postContext?.title) contextParts.push(`Title: ${postContext.title}`);
  if (postContext?.hook) contextParts.push(`Hook: ${postContext.hook}`);
  const contextText = contextParts.length ? contextParts.join(' | ') : 'No specific context.';
  const rows = candidates
    .map((item, idx) => `${idx + 1}. ${item.title} — ${item.creator} (${item.link})`)
    .join('\n');
  return [
    'You are a knowledgeable social audio curator.',
    `Niche: ${niche}`,
    `Post context: ${contextText}`,
    `From the list of candidate audio tracks below, select up to ${limit} items that best fit the niche and post context. Do NOT invent or rename any tracks. Each output item must include usageHint (1 short sentence) and confidence (0-1).`,
    `Candidates:\n${rows}`,
    'Return JSON array like [{"id":"...","usageHint":"...","confidence":0.85},...].',
  ].join('\n');
};

const similarityScore = (a = '', b = '') => {
  const tokensA = (a || '').toLowerCase().split(/\W+/).filter(Boolean);
  const tokensB = (b || '').toLowerCase().split(/\W+/).filter(Boolean);
  if (!tokensA.length || !tokensB.length) return 0;
  const shared = tokensA.filter((token) => tokensB.includes(token));
  return shared.length / Math.min(tokensA.length, tokensB.length);
};

const diversifyCandidates = (items = [], limit) => {
  const creatorCounts = new Map();
  const result = [];
  for (const entry of items) {
    if (result.length >= limit) break;
    const creatorKey = (entry.creator || '').toLowerCase();
    const existingCount = creatorCounts.get(creatorKey) || 0;
    if (existingCount >= 2) continue;
    const similarTitle = result.some((existing) => similarityScore(existing.title, entry.title || '') > 0.6);
    if (similarTitle) continue;
    creatorCounts.set(creatorKey, existingCount + 1);
    result.push(entry);
  }
  return result;
};

const callOpenAI = async (content) => {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY-not-set');
  const payload = {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content }],
    temperature: 0.35,
    max_tokens: 1000,
  };
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
    timeout: 7000,
  });
  if (!response.ok) throw new Error('openai_failed');
  const json = await response.json();
  return json.choices?.[0]?.message?.content || '';
};

async function rankWithOpenAI({ niche, postContext, candidates = [], limit = 8 }) {
  if (!candidates.length) return [];
  const truncated = candidates.slice(0, 50);
  try {
    const prompt = buildPrompt({ niche, postContext, candidates: truncated, limit });
    const content = await callOpenAI(prompt);
    const parsed = JSON.parse(content.trim());
    if (!Array.isArray(parsed)) throw new Error('invalid_json');
    const zipped = parsed
      .map((entry) => {
        if (!entry || typeof entry !== 'object' || !entry.id) return null;
        const candidate = truncated.find((c) => c.id === entry.id) || {};
        return {
          id: candidate.id || entry.id,
          platform: candidate.platform || entry.platform || 'mixed',
          title: candidate.title || entry.title || '',
          creator: candidate.creator || entry.creator || '',
          link: candidate.link || entry.link || '',
          usageHint: String(entry.usageHint || '').slice(0, 140),
          confidence: Number(entry.confidence) || 0,
        };
      })
      .filter(Boolean)
      .slice(0, limit);
    if (zipped.length) {
      const diversified = diversifyCandidates(zipped, limit);
      if (diversified.length) return diversified;
      return zipped;
    }
  } catch (err) {
    /* fall through to fallback */
  }
  return truncated.slice(0, limit).map((item) => ({
    id: item.id,
    platform: item.platform || 'mixed',
    title: item.title,
    creator: item.creator,
    link: item.link,
    usageHint: '',
    confidence: 0.5,
  }));
}

module.exports = {
  rankWithOpenAI,
};

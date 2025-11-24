const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CANONICAL_HOST = process.env.CANONICAL_HOST || '';

if (!OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set.');
}

// Simple local data directory for brand brains
const DATA_DIR = path.join(__dirname, 'data');
const BRANDS_DIR = path.join(DATA_DIR, 'brands');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(BRANDS_DIR)) fs.mkdirSync(BRANDS_DIR);
  if (!fs.existsSync(CUSTOMERS_FILE)) fs.writeFileSync(CUSTOMERS_FILE, '{}', 'utf8');
} catch (e) {
  console.error('Failed to initialize data directories:', e);
}

function slugify(s = '') {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

function chunkText(input, maxLen = 800) {
  if (!input) return [];
  const parts = String(input)
    .replace(/\r\n/g, '\n')
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks = [];
  for (const p of parts) {
    if (p.length <= maxLen) {
      chunks.push(p);
    } else {
      // naive hard split
      for (let i = 0; i < p.length; i += maxLen) {
        chunks.push(p.slice(i, i + maxLen));
      }
    }
    if (chunks.length >= 50) break; // cap
  }
  return chunks;
}

function openAIRequest(options, payload, retryCount = 0) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            // Retry on 502, 503, 504 (server errors) up to 3 times
            if ((res.statusCode === 502 || res.statusCode === 503 || res.statusCode === 504) && retryCount < 3) {
              const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
              console.log(`OpenAI ${res.statusCode} error, retrying in ${delay}ms (attempt ${retryCount + 1}/3)...`);
              setTimeout(() => {
                openAIRequest(options, payload, retryCount + 1).then(resolve).catch(reject);
              }, delay);
            } else {
              reject(new Error(`OpenAI error ${res.statusCode}: ${data}`));
            }
          }
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', (err) => {
      // Retry on network errors up to 3 times
      if (retryCount < 3) {
        const delay = Math.pow(2, retryCount) * 1000;
        console.log(`OpenAI network error, retrying in ${delay}ms (attempt ${retryCount + 1}/3)...`, err.message);
        setTimeout(() => {
          openAIRequest(options, payload, retryCount + 1).then(resolve).catch(reject);
        }, delay);
      } else {
        reject(err);
      }
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// Generic sanitizer + parse attempts for LLM JSON array output.
// Returns { data, attempts } where data is parsed array (or object wrapped into array) and attempts is diagnostics.
function parseLLMArray(rawContent, { requireArray = true, itemValidate } = {}) {
  const diagnostics = { rawLength: rawContent.length, attempts: [] };
  let raw = String(rawContent || '').trim()
    .replace(/```\s*json\s*/gi, '')
    .replace(/```/g, '')
    .replace(/[\u200B\uFEFF]/g, '');

  // Escape literal newlines inside JSON strings (LLM sometimes emits real line breaks inside quoted values)
  function escapeNewlinesInsideStrings(text) {
    let out = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (!inStr) {
        if (c === '"') { inStr = true; out += c; } else { out += c; }
        continue;
      }
      if (esc) { out += c; esc = false; continue; }
      if (c === '\\') { out += c; esc = true; continue; }
      if (c === '"') { inStr = false; out += c; continue; }
      if (c === '\n' || c === '\r') { out += '\\n'; continue; }
      out += c;
    }
    return out;
  }
  raw = escapeNewlinesInsideStrings(raw);

  const extractJsonArray = (txt) => {
    const start = txt.indexOf('[');
    const end = txt.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return txt;
    return txt.substring(start, end + 1);
  };

  let candidate = extractJsonArray(raw)
    .replace(/,\s*(\]|\})/g, '$1')
    .replace(/,,+/g, ',')
    .replace(/([,{]\s*)([a-zA-Z0-9_]+)\s*:(?=\s*["0-9tfn\[{])/g, '$1"$2":');
  candidate = escapeNewlinesInsideStrings(candidate);

  const attempts = [];
  attempts.push(candidate);
  if (candidate !== raw) attempts.push(raw);
  if (!/^\s*\[/.test(candidate) && /"day"\s*:/.test(candidate)) {
    // Wrap pseudo-object list lines into array
    const lines = candidate.split(/\n+/).filter(l => l.trim());
    attempts.push('[\n' + lines.join(',\n') + '\n]');
  }

  let lastErr;
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      let arr = parsed;
      if (requireArray && !Array.isArray(arr)) {
        if (arr && arr.posts && Array.isArray(arr.posts)) arr = arr.posts;
        else arr = [arr];
      }
      if (itemValidate && Array.isArray(arr)) {
        const ok = arr.every(itemValidate);
        if (!ok) throw new Error('Validation failure');
      }
      diagnostics.attempts.push({ ok: true, length: attempt.length });
      return { data: arr, attempts: diagnostics };
    } catch (e) {
      lastErr = e;
      diagnostics.attempts.push({ ok: false, error: e.message, length: attempt.length });
    }
  }
  // Fallback: multiple top-level objects separated by newlines without commas
  try {
    const objCount = (raw.match(/\n\s*\{/g) || []).length;
    if (!raw.trim().startsWith('[') && objCount > 0) {
      const parts = raw.split(/}\s*\n\s*\{/).map((p, i) => {
        if (i === 0 && p.trim().startsWith('{') && p.trim().endsWith('}')) return p.trim();
        if (i === 0) return p.trim() + '}';
        if (i === objCount) return '{' + p.trim();
        return '{' + p.trim();
      });
      const wrapped = '[' + parts.join(',') + ']';
      const parsed = JSON.parse(wrapped);
      if (requireArray && !Array.isArray(parsed)) throw new Error('Fallback not array');
      if (itemValidate && Array.isArray(parsed) && !parsed.every(itemValidate)) throw new Error('Fallback validation');
      diagnostics.attempts.push({ ok: true, fallback: 'object-split', length: wrapped.length });
      return { data: parsed, attempts: diagnostics };
    }
  } catch (e2) {
    diagnostics.attempts.push({ ok: false, fallbackError: e2.message });
  }
  const truncated = raw.slice(0, 500);
  const msg = 'Failed to parse JSON after attempts: ' + (lastErr && lastErr.message) + '\nRaw (truncated): ' + truncated;
  throw new Error(msg);
}

async function embedTextList(texts) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const payload = JSON.stringify({
    model: 'text-embedding-3-small',
    input: texts,
  });
  const options = {
    hostname: 'api.openai.com',
    path: '/v1/embeddings',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  };
  const json = await openAIRequest(options, payload);
  return json.data.map((d) => d.embedding);
}

function buildPrompt(nicheStyle, brandContext, opts = {}) {
  const days = Math.max(1, Math.min(30, Number(opts.days || 30)));
  const startDay = Math.max(1, Math.min(30, Number(opts.startDay || 1)));
  const brandBlock = brandContext
      ? `\n\nBrand Context: ${brandContext}\n\n`
    : '\n';
  const preset = getPresetGuidelines(nicheStyle);
  const presetBlock = preset ? `\n\nPreset Guidelines for this niche:\n${preset}\n\n` : '\n';
    const qualityRules = `Quality Rules — Make each post plug-and-play & conversion-ready:\n1) Hook harder: first 3 seconds must be scroll-stopping; videoScript.hook must be punchy.\n2) Hashtags: mix broad + niche/local; 6–8 total (balance reach + targeting).\n3) CTA: time-bound urgency (e.g., "book today", "spots fill fast").\n4) Design: specify colors, typography, pacing, and end-card CTA.\n5) Repurpose: 2–3 concrete transformations (e.g., Reel→Carousel slides, Static→Reel).\n6) Engagement: natural, friendly scripts for comments & DMs.\n7) Format: Reels 7–12s with trending audio; Carousels start with bold headline.\n8) Captions: start with a short hook line, then 1–2 value lines (use \\n).\n9) Keep outputs concise to avoid truncation.\n10) CRITICAL: Every post MUST include videoScript — Reels dominate reach. Even for Static/Carousel/Story, provide an "optional Reel version" script to help creators repurpose it.`;
    return `You are a content strategist.${brandBlock}${presetBlock}${qualityRules}\n\nCreate a calendar for "${nicheStyle}". Return a JSON array of ${days} objects for days ${startDay}..${startDay + days - 1}.\nALL FIELDS BELOW ARE REQUIRED for every object (never omit any):\n- day (number)\n- idea (string)\n- type (educational|promotional|lifestyle|interactive)\n- caption (exactly 2 short lines; the first line is the hook)\n- hashtags (array of 6–8 strings; mix broad + niche/local; no punctuation)\n- format (Reel|Story|Carousel|Static)\n- cta (urgent, time-bound)\n- pillar (Education|Social Proof|Promotion|Lifestyle)\n- storyPrompt (<= 120 chars)\n- designNotes (<= 120 chars; specific)\n- repurpose (array of 2–3 short strings)\n- analytics (array of 2–3 short metric names, e.g., ["Reach","Saves"])\n- engagementScripts { commentReply, dmReply } (each <= 140 chars; friendly, natural)\n- promoSlot (boolean)\n- weeklyPromo (string; include only if promoSlot is true; otherwise set to "")\n- videoScript { hook, body, cta } (REQUIRED for ALL posts regardless of format; hook 5–8 words; body 2–3 short beats; cta urgent)\n\nRules:\n- If unsure, invent concise, plausible content rather than omitting fields.\n- Always include every field above (use empty string only if absolutely necessary).\n- Return ONLY a valid JSON array of ${days} objects. No markdown, no comments, no trailing commas.`;
}

function hasAllRequiredFields(p){
  if (!p) return false;
  const ok = p.day!=null && p.idea && p.type && p.caption && p.hashtags && Array.isArray(p.hashtags) && p.hashtags.length>=6
    && p.format && p.cta && p.pillar && p.storyPrompt && p.designNotes
    && p.repurpose && Array.isArray(p.repurpose) && p.repurpose.length>=2
    && p.analytics && Array.isArray(p.analytics) && p.analytics.length>=2
    && p.engagementScripts && p.engagementScripts.commentReply && p.engagementScripts.dmReply
    && p.videoScript && p.videoScript.hook && p.videoScript.body && p.videoScript.cta
    && typeof p.promoSlot === 'boolean' && (p.promoSlot ? typeof p.weeklyPromo==='string' : true);
  return !!ok;
}

async function repairMissingFields(nicheStyle, brandContext, partialPosts){
  try {
    const schema = `Fill missing fields for each post. Keep existing values exactly as given. Return ONLY a JSON array with the same length and order. ALL fields must be present for every item (never omit):\n- day (number)\n- idea (string)\n- type (educational|promotional|lifestyle|interactive)\n- caption (exactly 2 short lines; first line is the hook)\n- hashtags (array of 6–8 strings)\n- format (Reel|Story|Carousel|Static)\n- cta (string)\n- pillar (Education|Social Proof|Promotion|Lifestyle)\n- storyPrompt (string <= 120 chars)\n- designNotes (string <= 120 chars)\n- repurpose (array of 2–3 short strings)\n- analytics (array of 2–3 strings)\n- engagementScripts { commentReply, dmReply } (each <= 140 chars)\n- promoSlot (boolean)\n- weeklyPromo (string; include empty string if promoSlot is false)\n- videoScript { hook, body, cta }`;
    const prompt = `Brand Context (optional):\n${brandContext || 'N/A'}\n\nNiche/Style: ${nicheStyle}\n\nHere are partial posts with some fields missing. Repair them to include ALL required fields with concise, plausible values. Preserve existing values verbatim.\n\nPartial posts (JSON array):\n${JSON.stringify(partialPosts)}\n\n${schema}`;
    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 3000,
    });
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    };
    const json = await openAIRequest(options, payload);
    const content = json.choices?.[0]?.message?.content || '[]';
    const { data } = parseLLMArray(content, { requireArray: true });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('repairMissingFields error:', e.message);
    return [];
  }
}

function getPresetGuidelines(nicheStyle = '') {
  const s = String(nicheStyle).toLowerCase();
  const isMedSpa = /med\s*spa|spa|aesthetics|aesthetician|skin\s*clinic|derma/.test(s);
  if (!isMedSpa) return '';
  return `
📖 Story Prompts (Daily Engagement)
- Polls: "Do you wash your face before bed? Yes / No"
- Quizzes: "Guess which treatment clears acne fastest?"
- Q&A Stickers: "Ask us anything about facials!"
- Countdowns: "2 days left for student discount"
- Behind-the-scenes: Staff prepping rooms, mixing products.

🎨 Design Notes
- Colors: Pastels + neutrals (soft pink, mint, beige) — youthful + calming.
- Fonts: Clean sans-serif, modern.
- Style: Bright lighting, authentic client photos, minimal text overlays.
- Reels: Trending audio, quick cuts (7–12s max).
- Carousels: Bold headline on slide 1, clean icons after.

🎥 Video Scripts (Weekly Reels — include at least 2 per week)
- Myth-Busting Reel: hook/body/cta (e.g., "Facials aren’t just for older people", benefits, "Book your glow session today").
- Transformation Reel: hook/body/cta (e.g., "From dull to glowing in 1 session", show before/after, "DM us to book").

🔄 Repurposing
- Reel → Carousel (3 slides), Carousel → Story frames, Static → Reel (animate text), Testimonial → Blog/Email.

📊 Analytics Checklist
- Reach (Reels > Stories > Static), Engagement (saves/shares/comments), Conversions (link clicks, DMs, bookings), Top Content.

💬 Engagement Scripts
- Comment reply: User: "Looks amazing!" You: "Thanks! Want me to send our facial menu?"
- DM: User: "How much is a peel?" You: "Peels start at $99 with visible results. Want me to book you this week?"

🗓️ Weekly Promo Slots (rotate weekly)
- Week 1: Student discount (15% off facials)
- Week 2: Weekend glow special (20% off)
- Week 3: Giveaway (free facial; tag friends)
- Week 4: Bundle deal (facial + peel combo)
`;
}

function callOpenAI(nicheStyle, brandContext, opts = {}) {
  const prompt = buildPrompt(nicheStyle, brandContext, opts);
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,
    max_tokens: 4000,
  });
  const options = {
    hostname: 'api.openai.com',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  };
  const debugEnabled = process.env.DEBUG_AI_PARSE === '1';
  const fetchAndParse = async (attempt = 0) => {
    const json = await openAIRequest(options, payload);
    const content = json.choices?.[0]?.message?.content || '';
    try {
      const { data, attempts } = parseLLMArray(content, {
        requireArray: true,
        itemValidate: (p) => p && typeof p.day === 'number',
      });
      if (debugEnabled) console.log('[CALENDAR PARSE] attempts:', attempts);
      return data;
    } catch (e) {
      if (attempt < 1) { // Single parse-level retry (fresh completion)
        if (debugEnabled) console.warn('[CALENDAR PARSE] retry after failure:', e.message);
        return fetchAndParse(attempt + 1);
      }
      throw e;
    }
  };
  return fetchAndParse(0);
}

function loadBrand(userId) {
  try {
    const file = path.join(BRANDS_DIR, slugify(userId) + '.json');
    if (!fs.existsSync(file)) return null;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return json;
  } catch (e) {
    console.error('Failed to load brand profile:', e);
    return null;
  }
}

function saveBrand(userId, chunksWithEmb) {
  const file = path.join(BRANDS_DIR, slugify(userId) + '.json');
  const payload = {
    userId,
    updatedAt: new Date().toISOString(),
    chunks: chunksWithEmb,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function loadCustomersMap() {
  try {
    const raw = fs.readFileSync(CUSTOMERS_FILE, 'utf8');
    const json = JSON.parse(raw || '{}');
    return json && typeof json === 'object' ? json : {};
  } catch (e) {
    return {};
  }
}

function saveCustomersMap(map) {
  try {
    fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify(map, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Failed to save customers map:', e);
    return false;
  }
}

function summarizeBrandForPrompt(brand) {
  if (!brand || !brand.chunks || brand.chunks.length === 0) return '';
  // join up to ~2400 characters
  let out = '';
  for (const c of brand.chunks) {
    if ((out + '\n' + c.text).length > 2400) break;
    out += (out ? '\n' : '') + c.text;
  }
  return out;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Security & professionalism headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('X-Frame-Options', 'DENY');
  // Basic CSP (allow self + needed CDNs). Removed unsafe-inline for scripts; add nonce for inline JSON-LD if present.
  // Note: We still allow 'unsafe-inline' for styles until all inline styles are refactored.
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://unpkg.com https://cdn.jsdelivr.net/npm/@supabase; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https://usepromptly.app; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://api.openai.com https://*.supabase.co https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://fonts.gstatic.com; frame-ancestors 'none';");
  // HSTS only if behind HTTPS (skip for localhost dev)
  if ((req.headers.host || '').includes('usepromptly.app')) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  const parsed = url.parse(req.url, true);
  // Serve favicon from SVG asset to avoid 404s
  if (parsed.pathname === '/favicon.ico') {
    const fav = path.join(__dirname, 'assets', 'promptly-icon.svg');
    try {
      if (fs.existsSync(fav)) {
        return serveFile(fav, res);
      }
    } catch {}
    // If not found, return 204 No Content instead of 404
    res.writeHead(204);
    return res.end();
  }

  // Serve apple touch icon path if requested by iOS (fallback to SVG)
  if (parsed.pathname === '/apple-touch-icon.png') {
    const apple = path.join(__dirname, 'assets', 'promptly-icon.svg');
    try {
      if (fs.existsSync(apple)) {
        return serveFile(apple, res);
      }
    } catch {}
    res.writeHead(204);
    return res.end();
  }

  // Optional canonical host redirect to enforce a single domain (e.g., promptlyapp.com)
  // IMPORTANT: Do NOT redirect Stripe webhooks; Stripe will not follow 301s for webhooks.
  if (CANONICAL_HOST && parsed.pathname !== '/stripe/webhook') {
    const reqHost = (req.headers && req.headers.host) ? String(req.headers.host) : '';
    // Strip port if present for comparison
    const normalize = (h) => String(h || '').replace(/:\d+$/, '');
    if (reqHost && normalize(reqHost).toLowerCase() !== normalize(CANONICAL_HOST).toLowerCase()) {
      const location = `https://${CANONICAL_HOST}${parsed.path || parsed.pathname || '/'}`;
      res.writeHead(301, { Location: location });
      return res.end();
    }
  }

  // Helper: serve static file with optional gzip if client supports
  function serveFile(filePath, res) {
    try {
      const ext = path.extname(filePath).toLowerCase();
      const typeMap = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon'
      };
      const raw = fs.readFileSync(filePath);
      const accept = req.headers['accept-encoding'] || '';
      // Only compress text-like content
      const isText = /\.(html|css|js|json|txt)$/i.test(filePath);
      // Override content-type for JSON-LD schema files to satisfy validators
      try {
        const base = path.basename(filePath);
        const isSchemaJson = filePath.includes(path.join('assets', path.sep)) && /^schema-.*\.json$/i.test(base);
        if (isSchemaJson) {
          res.setHeader('Content-Type', 'application/ld+json; charset=utf-8');
        }
      } catch {}
      if (isText && accept.includes('gzip')) {
        try {
          const zlib = require('zlib');
          const gz = zlib.gzipSync(raw);
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Vary', 'Accept-Encoding');
          if (!res.getHeader('Content-Type')) {
            res.setHeader('Content-Type', typeMap[ext] || 'application/octet-stream');
          }
          res.writeHead(200);
          return res.end(gz);
        } catch (e) {
          // Fallback to raw
        }
      }
      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', typeMap[ext] || 'application/octet-stream');
      }
      res.writeHead(200);
      return res.end(raw);
    } catch (e) {
      res.writeHead(404);
      return res.end('Not found');
    }
  }

  if (parsed.pathname === '/api/generate-calendar' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { nicheStyle, userId, days, startDay } = JSON.parse(body || '{}');
        if (!nicheStyle) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'nicheStyle required' }));
        }
        if (!OPENAI_API_KEY) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'OPENAI_API_KEY not set' }));
        }
        // pull brand context if available
        const brand = userId ? loadBrand(userId) : null;
        const brandContext = summarizeBrandForPrompt(brand);
        let posts = await callOpenAI(nicheStyle, brandContext, { days, startDay });
        // First-pass repair via LLM if any items are missing required fields
        const incomplete = posts.map((p, i) => ({ p, i })).filter(({ p }) => !hasAllRequiredFields(p));
        if (incomplete.length > 0) {
          const repaired = await repairMissingFields(nicheStyle, brandContext, incomplete.map(x => x.p));
          if (Array.isArray(repaired) && repaired.length === incomplete.length) {
            incomplete.forEach((entry, idx) => {
              const fixed = repaired[idx] || {};
              // Merge: prefer repaired values, fall back to original
              const merged = Object.assign({}, entry.p, fixed);
              if (typeof merged.promoSlot !== 'boolean') merged.promoSlot = !!merged.weeklyPromo;
              if (merged.promoSlot && typeof merged.weeklyPromo !== 'string') merged.weeklyPromo = '';
              // Normalize arrays
              if (!Array.isArray(merged.hashtags)) merged.hashtags = merged.hashtags ? String(merged.hashtags).split(/\s+|,\s*/).filter(Boolean) : [];
              if (!Array.isArray(merged.repurpose)) merged.repurpose = merged.repurpose ? [merged.repurpose] : [];
              if (!Array.isArray(merged.analytics)) merged.analytics = merged.analytics ? [merged.analytics] : [];
              // Ensure engagementScripts object shape
              if (!merged.engagementScripts) merged.engagementScripts = {};
              if (!merged.engagementScripts.commentReply && merged.engagementScript) merged.engagementScripts.commentReply = merged.engagementScript;
              if (!merged.engagementScripts.dmReply) merged.engagementScripts.dmReply = '';
              // Ensure videoScript object shape
              if (!merged.videoScript) merged.videoScript = { hook: '', body: '', cta: '' };
              posts[entry.i] = merged;
            });
          }
        }
        // Final safety net: fill any still-missing fields with conservative defaults
        posts = posts.map((p, idx) => {
          const out = Object.assign({
            day: typeof p.day === 'number' ? p.day : (startDay ? Number(startDay) + idx : (idx + 1)),
            idea: p.idea || 'Engaging post idea',
            type: p.type || 'educational',
            caption: p.caption || 'Quick tip that helps you today.\nSave this for later.',
            hashtags: Array.isArray(p.hashtags) ? p.hashtags : ['marketing','content','tips','learn','growth','brand'],
            format: p.format || 'Reel',
            cta: p.cta || 'DM us to book today',
            pillar: p.pillar || 'Education',
            storyPrompt: p.storyPrompt || 'Share behind-the-scenes of today\'s work.',
            designNotes: p.designNotes || 'Clean layout, bold headline, brand colors.',
            repurpose: Array.isArray(p.repurpose) && p.repurpose.length ? p.repurpose : ['Reel -> Carousel (3 slides)','Caption -> Story (2 frames)'],
            analytics: Array.isArray(p.analytics) && p.analytics.length ? p.analytics : ['Reach','Saves'],
            engagementScripts: p.engagementScripts || { commentReply: 'Appreciate you! Want our menu?', dmReply: 'Starts at $99. Want me to book you this week?' },
            promoSlot: typeof p.promoSlot === 'boolean' ? p.promoSlot : false,
            weeklyPromo: typeof p.weeklyPromo === 'string' ? p.weeklyPromo : '',
            videoScript: p.videoScript || { hook: 'Stop scrolling—quick tip', body: 'Show result • Explain 1 step • Tease benefit', cta: 'DM us to grab your spot' },
          }, p);
          // Guarantee engagementScripts keys
          if (!out.engagementScripts) out.engagementScripts = { commentReply: '', dmReply: '' };
          if (!out.engagementScripts.commentReply) out.engagementScripts.commentReply = 'Thanks! Want our quick guide?';
          if (!out.engagementScripts.dmReply) out.engagementScripts.dmReply = 'Starts at $99. Want me to book you this week?';
          // Ensure weeklyPromo empty when promoSlot is false
          if (!out.promoSlot && out.weeklyPromo) out.weeklyPromo = '';
          return out;
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ posts }));
      } catch (err) {
        console.error('API error:', err);
        let errorMessage = String(err);
        // Provide more helpful error messages for common issues
        if (errorMessage.includes('502')) {
          errorMessage = 'OpenAI servers are temporarily unavailable. Please try again in a moment.';
        } else if (errorMessage.includes('503')) {
          errorMessage = 'OpenAI service is overloaded. Please try again in a few seconds.';
        } else if (errorMessage.includes('504')) {
          errorMessage = 'Request timed out. Please try again.';
        } else if (errorMessage.includes('429')) {
          errorMessage = 'Rate limit exceeded. Please wait a moment before trying again.';
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: errorMessage }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/billing/portal' && req.method === 'POST') {
    // Customer portal creation using Stripe API
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { returnUrl, email } = JSON.parse(body || '{}');
        if (!STRIPE_SECRET_KEY) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Billing portal not configured', hint: 'Set STRIPE_SECRET_KEY in env.' }));
        }
        if (!email) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'email required' }));
        }
        const customers = loadCustomersMap();
        let cid = customers[String(email).toLowerCase()];
        if (!cid) {
          // Fallback: search Stripe customers by email to find existing customer id (useful if local map was lost)
          try {
            const q = new URLSearchParams({ email: String(email) });
            const findOpts = {
              hostname: 'api.stripe.com',
              path: `/v1/customers?${q.toString()}`,
              method: 'GET',
              headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` },
            };
            const list = await new Promise((resolve, reject) => {
              const r = https.request(findOpts, (sres) => {
                let data = '';
                sres.on('data', (c) => (data += c));
                sres.on('end', () => {
                  try {
                    const obj = JSON.parse(data);
                    if (sres.statusCode && sres.statusCode >= 200 && sres.statusCode < 300) return resolve(obj);
                    reject(new Error(`Stripe customers error ${sres.statusCode}: ${data}`));
                  } catch (e) { reject(e); }
                });
              });
              r.on('error', reject);
              r.end();
            });
            if (list && Array.isArray(list.data) && list.data.length > 0) {
              cid = list.data[0].id;
              const map = loadCustomersMap();
              map[String(email).toLowerCase()] = cid;
              saveCustomersMap(map);
            }
          } catch (e) {
            // ignore; will fall through to helpful message
          }
          if (!cid) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'No Stripe customer found for this user yet', hint: 'Complete checkout first so we can map your account.' }));
          }
        }
        // Create portal session via Stripe REST API (form-encoded)
        const form = new URLSearchParams({ customer: cid, return_url: String(returnUrl || '/') });
        const options = {
          hostname: 'api.stripe.com',
          path: '/v1/billing_portal/sessions',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(form.toString()),
          },
        };
        try {
          const json = await new Promise((resolve, reject) => {
            const sreq = https.request(options, (sres) => {
              let data = '';
              sres.on('data', (c) => (data += c));
              sres.on('end', () => {
                try {
                  const parsed = JSON.parse(data);
                  if (sres.statusCode && sres.statusCode >= 200 && sres.statusCode < 300) return resolve(parsed);
                  reject(new Error(`Stripe error ${sres.statusCode}: ${data}`));
                } catch (e) { reject(e); }
              });
            });
            sreq.on('error', reject);
            sreq.write(form.toString());
            sreq.end();
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ url: json.url }));
        } catch (e) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: String(e.message || e) }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/billing/checkout' && req.method === 'POST') {
    // Create a Stripe Checkout Session for subscriptions
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        if (!STRIPE_SECRET_KEY) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Checkout not configured', hint: 'Set STRIPE_SECRET_KEY to enable checkout.' }));
        }
  const { email, priceLookupKey, priceId } = JSON.parse(body || '{}');

  // Build success/cancel URLs with precedence: PUBLIC_BASE_URL ENV > X-Forwarded-* > Host header
  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
  const xfHost = req.headers['x-forwarded-host'];
  const xfProto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const host = String(PUBLIC_BASE_URL || (xfHost ? `${xfProto}://${xfHost}` : `http${req.socket.encrypted ? 's' : ''}://${req.headers.host || 'localhost:8000'}`));
  const base = host.replace(/\/$/, '');
        const success_url = `${base}/success.html?session_id={CHECKOUT_SESSION_ID}`;
        const cancel_url = `${base}/?upgrade=canceled`;

        // Form-encode payload
        const form = new URLSearchParams();
        form.set('mode', 'subscription');
        form.set('success_url', success_url);
        form.set('cancel_url', cancel_url);
        form.set('allow_promotion_codes', 'true');
        form.set('automatic_tax[enabled]', 'true');
        if (email) form.set('customer_email', String(email));
        let effectivePriceId = priceId || process.env.STRIPE_PRICE_ID || '';
        const effectiveLookupKey = priceLookupKey || process.env.STRIPE_PRICE_LOOKUP_KEY || '';
        if (!effectivePriceId && effectiveLookupKey) {
          // Resolve lookup key to price id via Stripe API
          const q = new URLSearchParams();
          q.append('lookup_keys[]', String(effectiveLookupKey));
          const priceListOptions = {
            hostname: 'api.stripe.com',
            path: `/v1/prices?${q.toString()}`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` },
          };
          try {
            const list = await new Promise((resolve, reject) => {
              const r = https.request(priceListOptions, (sres) => {
                let data = '';
                sres.on('data', (c) => (data += c));
                sres.on('end', () => {
                  try {
                    const obj = JSON.parse(data);
                    if (sres.statusCode && sres.statusCode >= 200 && sres.statusCode < 300) return resolve(obj);
                    reject(new Error(`Stripe prices error ${sres.statusCode}: ${data}`));
                  } catch (e) { reject(e); }
                });
              });
              r.on('error', reject);
              r.end();
            });
            effectivePriceId = list && Array.isArray(list.data) && list.data[0] && list.data[0].id;
          } catch (e) {
            // ignore and continue to error below if not resolved
          }
        }

        if (effectivePriceId) {
          form.set('line_items[0][price]', String(effectivePriceId));
          form.set('line_items[0][quantity]', '1');
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Valid priceId or resolvable priceLookupKey required' }));
        }

        const options = {
          hostname: 'api.stripe.com',
          path: '/v1/checkout/sessions',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(form.toString()),
          },
        };
        const session = await new Promise((resolve, reject) => {
          const sreq = https.request(options, (sres) => {
            let data = '';
            sres.on('data', (c) => (data += c));
            sres.on('end', () => {
              try {
                const obj = JSON.parse(data);
                if (sres.statusCode && sres.statusCode >= 200 && sres.statusCode < 300) return resolve(obj);
                reject(new Error(`Stripe error ${sres.statusCode}: ${data}`));
              } catch (e) { reject(e); }
            });
          });
          sreq.on('error', reject);
          sreq.write(form.toString());
          sreq.end();
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ url: session.url }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err.message || err) }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/billing/session' && req.method === 'GET') {
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
    const sessionId = parsed.query.session_id;
    if (!STRIPE_SECRET_KEY) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Not configured' }));
    }
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'session_id required' }));
    }
    const options = {
      hostname: 'api.stripe.com',
      path: `/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` },
    };
    const start = Date.now();
    const timer = setTimeout(() => {}, 0); // keep event loop tick
    const done = (code, payload) => {
      clearTimeout(timer);
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const reqStripe = https.request(options, (sres) => {
      let data = '';
      sres.on('data', (c) => (data += c));
      sres.on('end', () => {
        try {
          const obj = JSON.parse(data);
          if (sres.statusCode && sres.statusCode >= 200 && sres.statusCode < 300) {
            const payload = {
              id: obj.id,
              status: obj.status,
              payment_status: obj.payment_status,
              customer: obj.customer,
              customer_email: obj.customer_details && obj.customer_details.email || obj.customer_email || null,
              subscription_status: obj.subscription && obj.subscription.status || null,
            };
            return done(200, payload);
          }
          return done(502, { error: `Stripe error ${sres.statusCode}`, body: data });
        } catch (e) {
          return done(500, { error: String(e.message || e) });
        }
      });
    });
    reqStripe.on('error', (e) => done(502, { error: String(e.message || e) }));
    reqStripe.end();
    return;
  }

  if (parsed.pathname === '/stripe/webhook' && req.method === 'POST') {
    // Map Stripe customers to user emails after successful checkout
    const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        if (!STRIPE_WEBHOOK_SECRET) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Webhook not configured' }));
        }
        // Verify Stripe signature
        const sig = req.headers['stripe-signature'] || req.headers['Stripe-Signature'] || '';
        const parts = String(sig).split(',').reduce((acc, p) => { const [k,v] = p.split('='); if (k && v) acc[k.trim()] = v.trim(); return acc; }, {});
        const t = parts.t; const v1 = parts.v1;
        if (!t || !v1) throw new Error('Invalid signature header');
        const crypto = require('crypto');
        const signedPayload = `${t}.${raw}`;
        const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(signedPayload).digest('hex');
        const safeEqual = (a, b) => {
          try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
        };
        if (!safeEqual(expected, v1)) throw new Error('Signature verification failed');

        const event = JSON.parse(raw);
        const type = event && event.type;
        const obj = event && event.data && event.data.object;
        if (!type || !obj) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid event' }));
        }
        // Capture mapping on checkout completion or subscription creation
        let email = '';
        let customer = '';
        if (type === 'checkout.session.completed') {
          email = obj.customer_details && obj.customer_details.email || '';
          customer = obj.customer || '';
        } else if (type === 'customer.subscription.created' || type === 'customer.subscription.updated') {
          customer = obj.customer || '';
          email = obj.customer_email || '';
        }
        if (email && customer) {
          const map = loadCustomersMap();
          map[String(email).toLowerCase()] = customer;
          saveCustomersMap(map);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ received: true }));
      } catch (e) {
        console.error('Stripe webhook error:', e);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/generate-variants' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { posts, nicheStyle, userId } = JSON.parse(body || '{}');
        if (!Array.isArray(posts) || posts.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'posts array required' }));
        }
        if (!OPENAI_API_KEY) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'OPENAI_API_KEY not set' }));
        }
        const brand = userId ? loadBrand(userId) : null;
        const brandContext = summarizeBrandForPrompt(brand);

        // Keep batch small to avoid timeouts
        const MAX = 15;
        if (posts.length > MAX) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `too many posts; max ${MAX} per request` }));
        }

        const compactPosts = posts.map(p => ({
          day: p.day,
          caption: p.caption,
          hashtags: Array.isArray(p.hashtags) ? p.hashtags.slice(0, 8) : p.hashtags,
          cta: p.cta,
          format: p.format,
          pillar: p.pillar,
        }));

        const sys = `You transform captions into platform-specific variants. Be concise and keep JSON valid.`;
        const rules = `Rules:\n- Respect brand tone if given.\n- Keep hashtags balanced (6–8) except LinkedIn (0–3).\n- IG: 2 short lines max; keep or improve hook; keep hashtags.\n- TikTok: punchy, 80–150 chars, 4–8 hashtags; fun tone.\n- LinkedIn: 2–3 sentences, professional, minimal hashtags (0–3), soft CTA.\nReturn ONLY JSON array of objects: { day, variants: { igCaption, tiktokCaption, linkedinCaption } } in same order as input.`;
        const prompt = `${brandContext ? `Brand Context:\n${brandContext}\n\n` : ''}${rules}\n\nInput posts (JSON):\n${JSON.stringify(compactPosts)}`;

        const payload = JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: prompt },
          ],
          temperature: 0.4,
          max_tokens: 3500,
        });
        const options = {
          hostname: 'api.openai.com',
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
        };

        const debugEnabled = process.env.DEBUG_AI_PARSE === '1';
        const fetchAndParse = async (attempt=0) => {
          const json = await openAIRequest(options, payload);
          const content = json.choices?.[0]?.message?.content || '';
          try {
            const { data, attempts } = parseLLMArray(content, {
              requireArray: true,
              itemValidate: (v) => v && typeof v.day === 'number' && v.variants && typeof v.variants === 'object'
            });
            if (debugEnabled) console.log('[VARIANTS PARSE] attempts:', attempts);
            return data;
          } catch (e) {
            if (attempt < 1) {
              if (debugEnabled) console.warn('[VARIANTS PARSE] retry after failure:', e.message);
              return fetchAndParse(attempt+1);
            }
            throw e;
          }
        };
        const parsed = await fetchAndParse(0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ variants: parsed }));
      } catch (err) {
        console.error('Variants error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/brand/ingest' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { userId, text } = JSON.parse(body || '{}');
        if (!userId || !text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'userId and text required' }));
        }
        if (!OPENAI_API_KEY) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'OPENAI_API_KEY not set' }));
        }
        const chunks = chunkText(text);
        const embeddings = await embedTextList(chunks);
        const stored = chunks.map((t, i) => ({ id: i + 1, text: t, embedding: embeddings[i] }));
        const saved = saveBrand(userId, stored);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, chunks: saved.chunks.length }));
      } catch (err) {
        console.error('Brand ingest error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/brand/profile' && req.method === 'GET') {
    try {
      const userId = parsed.query.userId;
      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'userId required' }));
      }
      const brand = loadBrand(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, hasProfile: !!brand, chunks: brand?.chunks?.length || 0 }));
    } catch (err) {
      console.error('Brand profile error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(err) }));
    }
  }

  // Handle clean URLs (e.g., /success -> /success.html)
  let safePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  let filePath = path.join(__dirname, path.normalize(safePath));

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Forbidden' }));
  }

  fs.stat(filePath, (err, stats) => {
    // If file not found and no extension, try adding .html
    if (err && !path.extname(safePath)) {
      safePath = safePath + '.html';
      filePath = path.join(__dirname, path.normalize(safePath));
      
      if (!filePath.startsWith(__dirname)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Forbidden' }));
      }
      
      fs.stat(filePath, (err2, stats2) => {
        if (err2 || !stats2.isFile()) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Not found' }));
        }
        serveFile(filePath, res);
      });
      return;
    }
    
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Not found' }));
    }

    // Serve the file
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css',
      '.js': 'text/javascript',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.ico': 'image/x-icon',
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': contentType };
    if (ext === '.html') headers['Cache-Control'] = 'no-store';
    else if (ext === '.js' || ext === '.css') headers['Cache-Control'] = 'public, max-age=300';
    else headers['Cache-Control'] = 'public, max-age=86400';
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
});

function serveFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';
  const headers = { 'Content-Type': contentType };
  if (ext === '.html') headers['Cache-Control'] = 'no-store';
  else if (ext === '.js' || ext === '.css') headers['Cache-Control'] = 'public, max-age=300';
  else headers['Cache-Control'] = 'public, max-age=86400';
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => console.log(`Promptly server running on http://localhost:${PORT}`));

process.on('uncaughtException', (err) => console.error('Uncaught:', err));
process.on('unhandledRejection', (r) => console.error('Unhandled rejection:', r));

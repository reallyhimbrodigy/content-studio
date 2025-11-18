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
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(BRANDS_DIR)) fs.mkdirSync(BRANDS_DIR);
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
    return `You are a content strategist.${brandBlock}${presetBlock}${qualityRules}\n\nCreate a calendar for "${nicheStyle}". Return a JSON array of ${days} objects for days ${startDay}..${startDay + days - 1} with these fields (be concise):\n- day (number)\n- idea (string)\n- type (educational|promotional|lifestyle|interactive)\n- caption (exactly 2 short lines; first line is the hook)\n- hashtags (array of 6–8 mixed broad + niche/local tags)\n- format (Reel|Story|Carousel|Static)\n- cta (urgent, time-bound)\n- pillar (Education|Social Proof|Promotion|Lifestyle)\n- storyPrompt (<= 120 chars)\n- designNotes (<= 120 chars; specific)\n- repurpose (array of 2–3 short ideas)\n- analytics (short list: 2–3 metrics)\n- engagementScripts { commentReply, dmReply } (each <= 140 chars; natural tone)\n- promoSlot (boolean)\n- weeklyPromo (string; present only if promoSlot is true; keep short)\n- videoScript { hook, body, cta } (REQUIRED for ALL posts regardless of format; hook is 5–8 words; body is 2–3 short beats of 10–15 words each; cta is urgent call-to-action)\n\nReturn ONLY a valid JSON array of ${days} objects. Do NOT use markdown, code fences, or trailing commas. If you cannot fit a field, OMIT it. Do NOT output invalid JSON. No explanation.`;
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
    max_tokens: 4000, // Reduced from 6000 for faster response
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

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) return reject(new Error(`OpenAI ${res.statusCode}`));
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content;
          if (!content) return reject(new Error('No content'));

          // Sanitize common wrappers (markdown fences) and try several parse strategies
          let text = String(content).trim();
          // remove ```json or ``` code fences
          text = text.replace(/```\s*json\s*/i, '');
          text = text.replace(/```/g, '').trim();

          // 1) try direct JSON parse
          try {
            const parsed = JSON.parse(text);
            return resolve(parsed);
          } catch (err1) {
            // 2) attempt to extract first JSON object/array from the text
            const firstObj = text.indexOf('{');
            const firstArr = text.indexOf('[');
            const start = (firstObj === -1) ? firstArr : (firstArr === -1 ? firstObj : Math.min(firstObj, firstArr));
            const lastObj = text.lastIndexOf('}');
            const lastArr = text.lastIndexOf(']');
            const end = Math.max(lastObj, lastArr);
            if (start !== -1 && end !== -1 && end > start) {
              const candidate = text.substring(start, end + 1);
              try {
                const parsed = JSON.parse(candidate);
                return resolve(parsed);
              } catch (err2) {
                // fall through to error
              }
            }

            return reject(new Error('Failed to parse JSON from OpenAI response: ' + (err1 && err1.message)));
          }
        } catch (err) {
          return reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
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
  if (CANONICAL_HOST) {
    const reqHost = (req.headers && req.headers.host) ? String(req.headers.host) : '';
    // Strip port if present for comparison
    const normalize = (h) => String(h || '').replace(/:\d+$/, '');
    if (reqHost && normalize(reqHost).toLowerCase() !== normalize(CANONICAL_HOST).toLowerCase()) {
      const location = `https://${CANONICAL_HOST}${parsed.path || parsed.pathname || '/'}`;
      res.writeHead(301, { Location: location });
      return res.end();
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
        const posts = await callOpenAI(nicheStyle, brandContext, { days, startDay });
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

        const raw = await openAIRequest(options, payload);
        const content = raw.choices?.[0]?.message?.content || '';
        let text = String(content).trim().replace(/```\s*json\s*/i, '').replace(/```/g, '').trim();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          const s = Math.min(...[...text.matchAll(/[\[{]/g)].map(m=>m.index || 0));
          const eidx = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
          if (isFinite(s) && eidx> s) {
            parsed = JSON.parse(text.slice(s, eidx+1));
          } else throw e;
        }

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

// server_fixed.js - clean standalone server (use this to run while we clean server.js)
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

if (!OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set. Set process.env.OPENAI_API_KEY to enable AI generation.');
}

function callChatCompletion(prompt, { temperature = 0.7, maxTokens = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
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
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) return reject(new Error(`OpenAI ${res.statusCode}: ${data}`));
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content;
          if (!content) return reject(new Error('No content from OpenAI'));
          resolve(content.trim());
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function callOpenAI(nicheStyle) {
  const prompt = `You are a content strategy expert. Create a 30-day content calendar for a creator in the "${nicheStyle}" niche.\n\nFor each day (1-30), generate exactly one content idea with:\n- A catchy, memorable title\n- A brief description (1-2 sentences)\n- A pillar category (one of: "authority", "community", "conversion")\n\nReturn the response as a valid JSON array with objects like:\n[\n  { "day": 1, "title": "...", "description": "...", "pillar": "authority" },\n  ...\n]\n\nMake sure the 30 days follow a narrative arc that builds authority, community, then conversion.\nThe response must be ONLY valid JSON (no commentary or markdown).`;

  return callChatCompletion(prompt, { temperature: 0.8, maxTokens: 3200 })
    .then((content) => JSON.parse(content));
}

function normalizePost(post, day) {
  const defaultHashtags = ['marketing', 'content', 'tips', 'learn', 'growth', 'brand'];
  const out = Object.assign({}, post);
  out.day = typeof out.day === 'number' ? out.day : day;
  out.title = out.title || out.idea || 'New content idea';
  out.idea = out.idea || out.title || 'Content idea';
  out.description = out.description || out.caption || 'Share a quick story that delivers value.';
  if (!Array.isArray(out.hashtags)) {
    if (typeof out.hashtags === 'string') {
      out.hashtags = out.hashtags.split(/[,\\s]+/).filter(Boolean);
    } else {
      out.hashtags = defaultHashtags.slice();
    }
  }
  if (!out.pillar) out.pillar = 'Education';
  if (!out.cta) out.cta = 'DM us for details';
  if (!out.format) out.format = 'Reel';
  if (!out.storyPrompt) out.storyPrompt = 'Show behind-the-scenes of the process.';
  if (!out.designNotes) out.designNotes = 'Clean layout, bold headline.';
  if (!Array.isArray(out.repurpose) || !out.repurpose.length) {
    out.repurpose = ['Reel -> Carousel (3 slides)', 'Caption -> Story frames'];
  }
  if (!Array.isArray(out.analytics) || !out.analytics.length) {
    out.analytics = ['Reach', 'Saves'];
  }
  if (!out.engagementScripts) out.engagementScripts = { commentReply: '', dmReply: '' };
  if (!out.engagementScripts.commentReply) out.engagementScripts.commentReply = 'Thanks! Want more tips?';
  if (!out.engagementScripts.dmReply) out.engagementScripts.dmReply = 'Starts at $99. Want me to book you this week?';
  out.promoSlot = typeof out.promoSlot === 'boolean' ? out.promoSlot : false;
  if (!out.promoSlot) out.weeklyPromo = '';
  if (!out.videoScript) out.videoScript = { hook: '', body: '', cta: '' };
  if (!out.videoScript.hook) out.videoScript.hook = 'Stop scrolling—quick tip';
  if (!out.videoScript.body) out.videoScript.body = 'Show result • Explain step • Tease benefit';
  if (!out.videoScript.cta) out.videoScript.cta = 'DM us to grab your spot';
  return out;
}

function buildSingleDayPrompt(nicheStyle, day, post) {
  const snapshot = JSON.stringify(post || {}, null, 2);
  return `You are a content strategist.\n\nRegenerate day ${day} for niche "${nicheStyle}". Keep the same JSON schema as the master calendar (day, idea, title if provided, type, caption, hashtags array, format, CTA, pillar, storyPrompt, designNotes, repurpose array, analytics array, engagementScripts object with commentReply/dmReply, promoSlot boolean, weeklyPromo string, videoScript {hook,body,cta}).\n\nCurrent post for reference (do NOT reuse text verbatim):\n${snapshot}\n\nReturn ONLY a JSON array with exactly one object for day ${day}.`;
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

  if (parsed.pathname === '/api/generate-calendar' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { nicheStyle } = JSON.parse(body || '{}');
        if (!nicheStyle) return res.writeHead(400) && res.end(JSON.stringify({ error: 'nicheStyle is required' }));
        if (!OPENAI_API_KEY) return res.writeHead(500) && res.end(JSON.stringify({ error: 'OPENAI_API_KEY not configured' }));
        const posts = await callOpenAI(nicheStyle);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ posts }));
      } catch (err) {
        console.error('API error:', err && err.stack ? err.stack : err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/regen-day' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { nicheStyle, day, post } = JSON.parse(body || '{}');
        if (!nicheStyle || typeof day !== 'number') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'nicheStyle and day are required' }));
        }
        const prompt = buildSingleDayPrompt(nicheStyle, day, post || {});
        const raw = await callChatCompletion(prompt, { temperature: 0.6, maxTokens: 1600 });
        const parsedArray = JSON.parse(raw);
        if (!Array.isArray(parsedArray) || !parsedArray.length) {
          throw new Error('Model returned no data');
        }
        const normalized = normalizePost(parsedArray[0], day);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ post: normalized }));
      } catch (err) {
        console.error('regen-day error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Failed to regenerate day' }));
      }
    });
    return;
  }

  const safePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  const filePath = path.join(__dirname, path.normalize(safePath));
  if (!filePath.startsWith(__dirname)) return res.writeHead(403) && res.end('Forbidden');

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) return res.writeHead(404) && res.end('Not found');
    const ext = path.extname(filePath).toLowerCase();
    const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
  });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => console.log(`Promptly server (fixed) running on http://localhost:${PORT}`));

process.on('uncaughtException', (err) => console.error('Uncaught:', err && err.stack ? err.stack : err));
process.on('unhandledRejection', (r) => console.error('UnhandledRejection:', r));

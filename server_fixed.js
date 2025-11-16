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

function callOpenAI(nicheStyle) {
  const prompt = `You are a content strategy expert. Create a 30-day content calendar for a creator in the "${nicheStyle}" niche.\n\nFor each day (1-30), generate exactly one content idea with:\n- A catchy, memorable title\n- A brief description (1-2 sentences)\n- A pillar category (one of: "authority", "community", "conversion")\n\nReturn the response as a valid JSON array with objects like:\n[\n  { "day": 1, "title": "...", "description": "...", "pillar": "authority" },\n  ...\n]\n\nMake sure the 30 days follow a narrative arc that builds authority, community, then conversion.\nThe response must be ONLY valid JSON (no commentary or markdown).`;

  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
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
          if (res.statusCode !== 200) return reject(new Error(`OpenAI ${res.statusCode}: ${data}`));
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content;
          if (!content) return reject(new Error('No content from OpenAI'));

          const parsed = JSON.parse(content.trim());
          return resolve(parsed);
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

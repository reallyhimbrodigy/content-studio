#!/usr/bin/env node
'use strict';
/**
 * LANE 1 / JUDGE — Step 4: request mining over ALL vibe_input texts.
 * Buckets every request, then deep-cuts the language/caption and generative
 * buckets into sub-intents with counts + verbatim examples.
 * Read-only. No LLM (regex/keyword v1; the judge's ask decompositions on the
 * 1,286-recipe subset serve as cross-validation).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), quiet: true });
if (!process.env.SUPABASE_URL) require('dotenv').config({ path: '/Users/zaclibman/content-studio/.env.local', quiet: true });
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function pageAll(pathq) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${URL_}/rest/v1/${pathq}&limit=1000&offset=${off}`, { headers: H });
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error(JSON.stringify(rows).slice(0, 200));
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// sub-intent taxonomies: [name, regex]
const LANG_SUBS = [
  ['captions in specific language', /(caption|subtitle|sub|text)s?\s*(in|into|to)\s*(hindi|spanish|english|arabic|urdu|french|german|portuguese|punjabi|tamil|telugu|marathi|bengali|gujarati|malayalam|kannada|russian|japanese|korean|chinese|italian|turkish|indonesian|vietnamese|thai)/i],
  ['translate (whole video / unspecified)', /translat|translation|convert.*(language|english|hindi|spanish)|in english|into english|to english/i],
  ['add captions/subtitles (no language named)', /(add|with|include|put|want|need).{0,25}(caption|subtitle)|caption(s)? (it|this|the)|subtitles?/i],
  ['remove captions', /(remove|delete|no|without).{0,15}(caption|subtitle|text on)/i],
  ['fix caption spelling/accuracy', /(fix|correct|wrong|spelling|accurate).{0,20}(caption|subtitle|word)/i],
];
const GEN_SUBS = [
  ['make/transform me into X (avatar/character)', /make me (a|an|the|into|look)|turn me into|transform me|i (am|become)/i],
  ['generate scene/background/world', /(generate|create|add|make).{0,30}(scene|background|sky|world|city|palace|forest|space|setting)|change.{0,15}background/i],
  ['add people/characters/objects into video', /(add|put|insert).{0,25}(girl|boy|person|people|warrior|character|angel|animal|dog|cat|car)/i],
  ['AI image/graphic generation', /(generate|create|ai).{0,20}(image|picture|graphic|art|logo)/i],
  ['make subject speak/sing (synthetic speech)', /(make|let).{0,20}(say|speak|sing|talk)|voice ?over|tts|narrat/i],
  ['upscale/quality enhance (4k/8k/HD)', /\b(4k|8k|hd|1080p|upscale|enhance quality|high quality|clear|clarity|sharp)\b/i],
];
const BUCKETS = [
  ['language_captions', /caption|subtitle|translat|in english|into english|hindi|spanish|arabic|urdu|language|spelling/i, LANG_SUBS],
  ['generative_ai', /generate|make me|turn me into|transform|ai |background|scene|8k|4k|upscale|enhance|voice ?over|sing|avatar/i, GEN_SUBS],
  ['music_audio', /music|song|beat|audio|sound ?track|acappella|vocals|bass|volume|denoise|noise/i, []],
  ['pacing_cuts', /fast|slow|pace|pacing|punchy|snappy|cut|trim|shorten|short|long|speed|tight/i, []],
  ['zoom_effects', /zoom|shake|shaky|effect|transition|motion graphic|animation|emphasi|graphic/i, []],
  ['style_generic', /viral|engaging|professional|clean|smooth|aesthetic|cinematic|corporate|cool|trendy|tiktok|reel|edit this|edit my/i, []],
];

(async () => {
  const jobs = await pageAll(`video_jobs?select=id,vibe_input,change_request,status,route:result->>route&order=created_at.asc`);
  const texts = jobs.map(j => ({ id: j.id, t: [(j.vibe_input || ''), (j.change_request || '')].join(' ').trim(), route: j.route, status: j.status }))
    .filter(x => x.t);
  console.log(`corpus: ${texts.length} request texts (of ${jobs.length} jobs)`);

  // preset strings (>=20 identical uses) — cut them out of "custom"
  const freq = {};
  texts.forEach(x => { freq[x.t] = (freq[x.t] || 0) + 1; });
  const presets = new Set(Object.entries(freq).filter(([, n]) => n >= 20).map(([v]) => v));
  const custom = texts.filter(x => !presets.has(x.t));
  const presetN = texts.length - custom.length;
  console.log(`preset taps (${presets.size} distinct strings): ${presetN} (${(100 * presetN / texts.length).toFixed(1)}%)`);
  console.log(`custom requests: ${custom.length} (${(100 * custom.length / texts.length).toFixed(1)}%)\n`);
  console.log(`preset strings: ${[...presets].map(p => `${JSON.stringify(p.slice(0, 40))}×${freq[p]}`).join(', ')}\n`);

  // bucket pass (first-match wins, ordered by specificity)
  const bucketHits = {}, sub = {};
  const examples = {};
  for (const x of custom) {
    let hit = 'unbucketed';
    for (const [name, re, subs] of BUCKETS) {
      if (re.test(x.t)) {
        hit = name;
        for (const [sname, sre] of subs) {
          if (sre.test(x.t)) {
            const k = `${name} :: ${sname}`;
            sub[k] = (sub[k] || 0) + 1;
            (examples[k] = examples[k] || []).length < 4 && examples[k].push(x.t.slice(0, 110));
            break;
          }
        }
        break;
      }
    }
    bucketHits[hit] = (bucketHits[hit] || 0) + 1;
    (examples[hit] = examples[hit] || []).length < 4 && examples[hit].push(x.t.slice(0, 110));
  }
  console.log('── BUCKETS (custom requests, first-match) ──');
  for (const [b, n] of Object.entries(bucketHits).sort((a, z) => z[1] - a[1]))
    console.log(`  ${b.padEnd(20)} ${n} (${(100 * n / custom.length).toFixed(1)}% of custom)`);
  console.log('\n── SUB-INTENTS (deep cut) ──');
  for (const [k, n] of Object.entries(sub).sort((a, z) => z[1] - a[1]))
    console.log(`  ${String(n).padStart(4)}x  ${k}`);
  console.log('\n── VERBATIM EXAMPLES ──');
  for (const [k, exs] of Object.entries(examples)) {
    if (!sub[k] && !bucketHits[k]) continue;
    console.log(`  [${k}]`);
    exs.forEach(e => console.log(`     · ${JSON.stringify(e)}`));
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });

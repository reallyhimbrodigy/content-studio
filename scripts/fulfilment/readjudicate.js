'use strict';
// PRECEDENCE FIX — a NEGATED ask is a CONSTRAINT, never out-of-scope.
//
// "Do NOT apply any beauty filter, skin smooth, skin whitening, or face
// retouch. Keep my natural skin texture" was ranked #10 in the negotiation
// backlog on the word "filter" — 10 jobs, all completed. It is the opposite of
// a request: the user is forbidding a thing, and a violated prohibition is a
// failure however good the edit is. Same shape as the UNSAFE fix: a precedence
// rule, applied before the category question rather than after it.
//
// PER TAG, NOT PER BRIEF. "using only the original interview footage" negates
// stock_broll while the same brief still asks for music. A brief-level negation
// flag would have thrown away the real asks beside the forbidden one.
const fs = require('fs');
const ENV = require('./env.js')();
const KEY = ENV.ANTHROPIC_API_KEY || ENV.CLAUDE_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';
const CAP = 6000, BATCH = 12, RETRY_BATCH = 3;

const SYSTEM = `For each numbered request you are given a list of CANDIDATE TAGS found by a literal token scan. For EVERY tag, decide which of three things the text does with it:

REQUESTED  — the user is asking for it. "add background music", "make it 9:16", "add b-roll".
NEGATED    — the user is FORBIDDING it or ruling it out. "no music", "do NOT apply any filter", "without captions", "using ONLY the original footage" (negates outside b-roll), "keep my natural skin" (negates retouching/grading), "don't change the aspect".
DESCRIBED  — the word appears only as a description of the user's own footage or of something already present. "my vertical video", "Tamil-English mixed voiceover", "there's music playing in the background".

Decide each tag SEPARATELY. One request commonly REQUESTS one tag and NEGATES another — that is the normal answer, not an edge case.

A NEGATED tag is a CONSTRAINT the edit must respect. A DESCRIBED tag is nothing at all. Only REQUESTED is an out-of-scope ask.

Be literal. If the text does not actually forbid it, it is not NEGATED.`;

const TOOL = {
  name: 'adjudicate',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            i: { type: 'integer' },
            tags: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  tag: { type: 'string' },
                  role: { type: 'string', enum: ['REQUESTED', 'NEGATED', 'DESCRIBED'] },
                  quote: { type: 'string', description: 'the words that decided it' },
                },
                required: ['tag', 'role', 'quote'],
              },
            },
          },
          required: ['i', 'tags'],
        },
      },
    },
    required: ['items'],
  },
};

let uIn = 0, uOut = 0;
async function call(chunk) {
  const user = chunk.map(c => `[${c.i}] CANDIDATE TAGS: ${c.oos.join(', ')}\n${JSON.stringify(c.text.slice(0, CAP))}`).join('\n\n');
  for (let a = 1; a <= 5; a++) {
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, system: SYSTEM, tools: [TOOL], tool_choice: { type: 'tool', name: 'adjudicate' }, messages: [{ role: 'user', content: user }] }),
      });
    } catch (e) {
      // TRANSPORT ERRORS THROW, THEY DO NOT RETURN A STATUS. The retry only
      // covered 429/5xx, so one ECONNRESET killed a 413-row run outright —
      // and the shell reported exit 0 because the output went through a pipe.
      if (a === 5) throw e;
      await new Promise(s => setTimeout(s, a * 3000));
      continue;
    }
    if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, a * 2500)); continue; }
    const b = await r.json();
    if (b.error) throw new Error(b.error.message);
    uIn += (b.usage || {}).input_tokens || 0; uOut += (b.usage || {}).output_tokens || 0;
    const tu = (b.content || []).find(c => c.type === 'tool_use');
    if (!tu) throw new Error('no tool_use');
    return tu.input.items || [];
  }
  throw new Error('exhausted retries');
}

const NEGWORD = /\b(do ?n.?t|dont|do not|no|without|never|avoid|keep (my|the|it) natural|nicht|não|nao|нет|बिना|tanpa|sin |pas de)\b/i;

(async () => {
  const all = fs.readFileSync(`${__dirname}/classified.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
  const todo = all.filter(c => (c.oos || []).length && NEGWORD.test(c.text));
  const got = new Map();
  for (let k = 0; k < todo.length; k += BATCH) {
    const chunk = todo.slice(k, k + BATCH);
    const res = await call(chunk);
    for (const r of res) if (chunk.some(c => c.i === r.i)) got.set(r.i, r.tags || []);
    const miss = chunk.filter(c => !got.has(c.i));
    // RETRY SMALLER, NOT IDENTICAL. The first miss was 12 long briefs whose
    // reply exceeded max_tokens; re-sending the same 12 hit the same ceiling,
    // so 12 rows fell out silently. A retry that repeats the failing shape is
    // not a retry.
    for (let m = 0; m < miss.length; m += RETRY_BATCH) {
      const small = miss.slice(m, m + RETRY_BATCH).filter(c => !got.has(c.i));
      if (!small.length) continue;
      const r2 = await call(small);
      for (const r of r2) if (small.some(c => c.i === r.i)) got.set(r.i, r.tags || []);
    }
    const still = chunk.filter(c => !got.has(c.i));
    if (still.length) throw new Error(`UNPROCESSED after retry: ${still.map(c => c.i).join(',')} — a row that quietly does not get judged is the absence-as-success class, so this fails loudly instead`);
    process.stderr.write(`\r  ${got.size}/${todo.length}`);
  }
  process.stderr.write('\n');
  let movedC = 0, movedD = 0, kept = 0;
  const out = all.map(c => {
    const t = got.get(c.i);
    if (!t) return { ...c, oos_final: c.oos || [], constraints: [], oos_roles: null };
    const req = [], neg = [], desc = [];
    for (const x of t) (x.role === 'REQUESTED' ? req : x.role === 'NEGATED' ? neg : desc).push(x);
    movedC += neg.length; movedD += desc.length; kept += req.length;
    return { ...c, oos_final: req.map(x => x.tag), constraints: neg.map(x => ({ tag: x.tag, quote: x.quote })), oos_roles: t };
  });
  fs.writeFileSync(`${__dirname}/classified_v2.jsonl`, out.map(r => JSON.stringify(r)).join('\n'));
  console.log(JSON.stringify({ readjudicated: got.size, of: todo.length, tags_kept_as_asks: kept, tags_moved_to_CONSTRAINT: movedC, tags_moved_to_DESCRIBED: movedD, cost_usd: +(uIn * 1e-6 + uOut * 5e-6).toFixed(4) }, null, 1));
})();

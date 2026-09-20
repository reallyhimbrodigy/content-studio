// D1 — request classifier. Distinct vibe strings -> request taxonomy.
// READ-ONLY on Supabase (reads a local corpus file). Haiku only.
const fs = require('fs');
const ENV = require('./env.js')();
const { oosTokens } = require('./oos_regex.js');
// ONE CLASSIFIER (Zac, 2026-09-20). The SYSTEM and TOOL were duplicated here
// and in the dispatch path, and the copies had DIFFERENT RULES: this one knew a
// negated ask is a constraint and the other did not, which is 3 of 4
// false-positive negotiations measured on live traffic. There is one copy now.
const { SYSTEM, TOOL } = require('../../lib/request-taxonomy.js');
const KEY = ENV.ANTHROPIC_API_KEY || ENV.CLAUDE_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';
const PRICE_IN = 1.0, PRICE_OUT = 5.0, PRICE_CACHE_R = 0.10, PRICE_CACHE_W = 1.25;
const CAP = 6000, BATCH = 20, RETRY_BATCH = 4;



let uIn = 0, uOut = 0, uCR = 0, uCW = 0, calls = 0;
async function callBatch(items) {
  const user = items.map(it => {
    const cand = oosTokens(it.text);
    // RECALL FROM THE SCAN, JUDGEMENT FROM THE MODEL. Calibration showed the
    // model loses out-of-scope tags inside long briefs (it missed "Add very
    // subtle background music" in 3,735 chars) while the scan cannot tell an
    // ASK from a DESCRIPTION ("Tamil-English mixed voiceover" is the user's own
    // audio; "Mute music" is a removal). So the scan proposes and the model
    // disposes — each doing the half it is actually good at.
    return `[${it.i}] ${JSON.stringify(it.text.slice(0, CAP))}` +
      (cand.length ? `\n     TOKEN SCAN FOUND (adjudicate each — ASK, or merely DESCRIBED/NEGATED?): ${cand.join(', ')}` : '');
  }).join('\n');
  for (let a = 1; a <= 5; a++) {
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, temperature: 0, max_tokens: 4000,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: [TOOL], tool_choice: { type: 'tool', name: 'classify_requests' },
        messages: [{ role: 'user', content: user }],
      }),
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
    calls++;
    const u = b.usage || {};
    uIn += u.input_tokens || 0; uOut += u.output_tokens || 0;
    uCR += u.cache_read_input_tokens || 0; uCW += u.cache_creation_input_tokens || 0;
    const tu = (b.content || []).find(c => c.type === 'tool_use');
    if (!tu) throw new Error('no tool_use');
    return tu.input.items || [];
  }
  throw new Error('exhausted retries');
}

(async () => {
  const all = JSON.parse(fs.readFileSync(`${__dirname}/distinct.json`, 'utf8'));
  const limit = process.argv[2] ? parseInt(process.argv[2], 10) : all.length;
  const outPath = process.argv[3] || `${__dirname}/classified.jsonl`;
  // stratified when calibrating: mix of short/mid/long rather than the head
  let pool = all.map((e, idx) => ({ i: idx, text: e.text, n: e.n }));
  if (limit < all.length) {
    const s = pool.filter(p => p.text.length <= 30), m = pool.filter(p => p.text.length > 30 && p.text.length <= 300), l = pool.filter(p => p.text.length > 300);
    const take = (arr, k) => arr.filter((_, j) => j % Math.max(1, Math.floor(arr.length / k)) === 0).slice(0, k);
    pool = [...take(s, Math.ceil(limit / 3)), ...take(m, Math.ceil(limit / 3)), ...take(l, Math.ceil(limit / 3))].slice(0, limit);
  }
  const got = new Map();
  for (let k = 0; k < pool.length; k += BATCH) {
    const chunk = pool.slice(k, k + BATCH);
    const res = await callBatch(chunk);
    for (const r of res) if (chunk.some(c => c.i === r.i)) got.set(r.i, r);
    // RETRY SMALLER, NOT IDENTICAL, AND THEN THROW. This script ran 2,341 rows
    // and lost none — but by luck, not by guard: it re-sent the same chunk that
    // had just failed, and the sibling script doing exactly that lost 12 rows
    // to a max_tokens ceiling and wrote a file that looked complete.
    const missing = chunk.filter(c => !got.has(c.i));
    for (let m = 0; m < missing.length; m += RETRY_BATCH) {
      const small = missing.slice(m, m + RETRY_BATCH).filter(c => !got.has(c.i));
      if (!small.length) continue;
      const res2 = await callBatch(small);
      for (const r of res2) if (small.some(c => c.i === r.i)) got.set(r.i, r);
    }
    const still = chunk.filter(c => !got.has(c.i));
    if (still.length) throw new Error(`UNPROCESSED after retry: ${still.map(c => c.i).join(',')} — a row that quietly goes unclassified is the absence-as-success class, so this throws rather than writing a file that looks complete`);
    process.stderr.write(`\r  ${got.size}/${pool.length}`);
  }
  process.stderr.write('\n');
  // BOTH SOURCES KEPT SEPARATELY, AND THE UNION IS THE HEADLINE — ON PURPOSE.
  // Calibration: the model drops a literal "Add subtle background music" inside
  // a 2,500-char brief; the scan cannot tell "my vertical video" (description)
  // from "make it vertical" (ask). Neither is reliable alone.
  //
  // The union favours RECALL, and that is the correct bias for THIS deliverable
  // rather than a general truth: a false positive shows a user one unnecessary
  // "I can't do that" line, a false negative is a SILENT DROP — the exact
  // failure this lane exists to drive to zero. The precision cost is real and
  // is reported, not hidden: oos_model and oos_scan are both stored so the
  // disagreement can be counted and re-judged later.
  const rows = pool.map(p => {
    const g = got.get(p.i) || { primary: null, MISSING: true };
    const scan = oosTokens(p.text);
    const model = g.oos || [];
    return { ...p, ...g, oos_model: model, oos_scan: scan,
             oos: [...new Set([...model, ...scan])].sort() };
  });
  fs.writeFileSync(outPath, rows.map(r => JSON.stringify(r)).join('\n'));
  const cost = uIn * PRICE_IN / 1e6 + uOut * PRICE_OUT / 1e6 + uCR * PRICE_CACHE_R / 1e6 + uCW * PRICE_CACHE_W / 1e6;
  console.log(JSON.stringify({
    classified: rows.filter(r => !r.MISSING).length, missing: rows.filter(r => r.MISSING).length,
    calls, in: uIn, out: uOut, cache_read: uCR, cache_write: uCW, cost_usd: +cost.toFixed(4),
  }, null, 1));
})();

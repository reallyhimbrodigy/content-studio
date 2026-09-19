// D1 — request classifier. Distinct vibe strings -> request taxonomy.
// READ-ONLY on Supabase (reads a local corpus file). Haiku only.
const fs = require('fs');
const ENV = require('./env.js')();
const { oosTokens } = require('./oos_regex.js');
const KEY = ENV.ANTHROPIC_API_KEY || ENV.CLAUDE_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';
const PRICE_IN = 1.0, PRICE_OUT = 5.0, PRICE_CACHE_R = 0.10, PRICE_CACHE_W = 1.25;
const CAP = 6000, BATCH = 20, RETRY_BATCH = 4;

const SYSTEM = `You classify REQUESTS typed by users of an AI video-editing app. You are NOT judging whether anything was delivered — only what the user ASKED FOR.

WHAT THE PIPELINE DOES: it edits footage the user UPLOADED. Cuts, captions, zooms, sound effects, motion graphics, text overlays, transitions, and b-roll taken from the user's own upload.
WHAT IT CANNOT DO: generate new imagery or objects, remove or replace objects, add music, upscale / "HD" / 4K, source outside stock, synthesise speech, change aspect ratio, apply colour-grade/LUT looks, translate or dub audio.

Answer the fields in THIS ORDER. Each is a separate decision — do not let one answer pull another.

1. unsafe — true only for sexual, violent, hateful or otherwise inappropriate requests, INCLUDING requests to undress or sexualise a person. THIS OVERRIDES EVERYTHING: if unsafe is true, set primary "UNSAFE" and stop caring about the other flags. A request being unsafe is never merely "out of scope".

2. content_description_only — true ONLY when the text contains NO imperative and NO ask at all: the user just described what the video shows. "He speaking about jdm cars" = true. "Create this as a nice video about food" contains an imperative = FALSE. When true, asks_count is 0.

3. primary — the single best fit:
   PRESET              a canned preset string alone, or a bare generic style phrase with nothing concrete added ("Viral engaging video", "viral", "make this reel amazing", "trending")
   PRESET_PLUS_MODIFIER  a generic style ask PLUS one to four concrete asks
   STRUCTURED_BRIEF    sections, numbered/bulleted lines, timestamps, quoted script lines, OR five or more discrete asks
   SURGICAL_REEDIT     exactly ONE change to an existing edit ("change 17:05 to 29:05", "just make it shorter", "fix the spelling of X")
   OUT_OF_SCOPE        the request is DOMINATED by things the pipeline cannot do
   UNCLEAR             LAST RESORT. Only when you genuinely cannot tell what is being asked. If any reasonable editor could act on it, it is NOT unclear. Vagueness is not unclarity: "make it amazing" is PRESET.
   UNSAFE              set when unsafe is true
   NOT_A_REQUEST       set when content_description_only is true
   OTHER               nothing fits; you MUST fill other_why

4. asks_language_change — true ONLY when the user asks for a LANGUAGE OUTCOME: captions in a named language, translate, dub, "subtitles in Hinglish", "make it English". 
   FALSE for a plain "add captions" with no language named.
   FALSE merely because the REQUEST ITSELF is written in another language. A Hindi user asking for captions is NOT a language ask.

5. has_negative_constraint — true when the user forbids something or sets a hard limit: "no captions", "don't change the font", "keep it under 30 seconds", "12 seconds", "don't use animated captions", "hide my face". Look for these specifically; they are the most-missed field.

6. uses_multiple_clips — true when the request refers to more than one source video ("these 10 videos", "combine the two clips", "2つの動画").

7. oos — EVERY out-of-scope thing asked for, as tags. Additive: include a tag whenever that thing is asked for, whatever the primary is. A SURGICAL request can carry one; a STRUCTURED brief can carry three.
   music            adding a song / background music / BGM (NOT describing music already in the clip)
   upscale_quality  4k, 8k, HD, sharpen, "fix the quality", enhance resolution
   generative_vfx   create/replace/remove an OBJECT or PERSON, change a background, anime/style transfer, make someone blink or move, "remove the name on the shirt", "erase the person"
   stock_broll      footage from outside the user's own upload
   voiceover_tts    SYNTHESISE speech that is not already in the footage ("make him say hello", "add an AI narrator", "read this script aloud"). Describing the user's OWN voiceover ("Tamil-English mixed voiceover") is NOT this. Asking for the WORDS AS TEXT — a transcript, subtitles, "give me the text of what is said" — is NOT this either; that is a captions ask and is in scope.
   ai_avatar        an AI presenter or avatar
   aspect_ratio     TAG THIS ONLY IF AN EXPLICIT RATIO OR ORIENTATION WORD IS PRESENT IN THE TEXT: "9:16", "16:9", "1:1", "4:5", "vertical", "horizontal", "portrait", "landscape", "square", "縦型", "横型". If one of those literal tokens is there, tag it even inside a long brief — "縦型9:16" is a tag.
                    NEVER tag it from a platform or app name alone. "for TikTok", "insta ke liye", "for Reels", "YouTube Shorts" are NOT aspect asks — they name a destination, not a ratio. If the only evidence is a platform name, do not tag.
                    An orientation word that DESCRIBES the upload ("my vertical video", "this Russian vertical video") is not an ask; only tag when a CHANGE is requested.
   color_grade_lut  colour grading, LUTs, "cinematic colour", "nice filter"
   translation_dub  translate or dub the SPOKEN AUDIO (caption translation is a language ask, and also belongs here if they want the audio changed)
   other_oos        anything else the pipeline cannot do; say what in other_why

8. typed_in — the language the REQUEST TEXT is written in (en, pt, id, ru, ja, ko, nl, hi, hi-Latn, ta-en, es, ar, zh, mixed). This has NOTHING to do with field 4.

9. TOKEN SCAN. Some requests carry a line "TOKEN SCAN FOUND: ...". Those are LITERAL string matches, not conclusions. For each tag listed, decide independently:
   - the user is ASKING for it -> include the tag in oos
   - the text merely DESCRIBES their own footage ("my vertical video", "Tamil-English mixed voiceover", "there's music in the background") -> DO NOT include it
   - the user is REMOVING or FORBIDDING it ("mute the music", "no b-roll") -> DO NOT include it in oos; set has_negative_constraint true instead
   The scan can miss nothing but understands nothing. You may also add a tag the scan did not find.

10. asks_count — how many DISCRETE things were asked for. A bare preset is 1. A content description is 0.`;

const TOOL = {
  name: 'classify_requests',
  description: 'Classify each numbered request.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            i: { type: 'integer' },
            unsafe: { type: 'boolean' },
            content_description_only: { type: 'boolean' },
            primary: { type: 'string', enum: ['PRESET', 'PRESET_PLUS_MODIFIER', 'STRUCTURED_BRIEF', 'SURGICAL_REEDIT', 'OUT_OF_SCOPE', 'UNCLEAR', 'UNSAFE', 'NOT_A_REQUEST', 'OTHER'] },
            asks_language_change: { type: 'boolean' },
            has_negative_constraint: { type: 'boolean' },
            uses_multiple_clips: { type: 'boolean' },
            oos: { type: 'array', items: { type: 'string', enum: ['music', 'upscale_quality', 'generative_vfx', 'stock_broll', 'voiceover_tts', 'ai_avatar', 'aspect_ratio', 'color_grade_lut', 'translation_dub', 'other_oos'] } },
            typed_in: { type: 'string' },
            asks_count: { type: 'integer' },
            other_why: { type: 'string' },
          },
          required: ['i', 'unsafe', 'content_description_only', 'primary', 'asks_language_change', 'has_negative_constraint', 'uses_multiple_clips', 'oos', 'typed_in', 'asks_count'],
        },
      },
    },
    required: ['items'],
  },
};

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
        model: MODEL, max_tokens: 4000,
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

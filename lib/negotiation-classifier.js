'use strict';
// D4 — THE NEGOTIATION CLASSIFIER, BUILT DARK.
//
// Runs at dispatch on this server, never inside a Modal container. Decides
// whether a request asks for something the pipeline cannot do, and if so what
// the user should be told BEFORE a render is spent.
//
// WHY THIS EXISTS: 1,057 jobs in 30 days — 27.5% of ALL jobs — asked for
// something out of scope and returned status=completed. An edit was delivered
// and the ask was ignored. "Fulfil any request nicely" is not true for those
// users today; the negotiation is how it becomes true.
//
// ROUTER CONSERVATISM (ruled Jul 21, Aug 9): this may act ONLY on asks that
// TODAY would be silently dropped or unsafely rendered. It never restricts what
// the editor may do with an in-scope brief. A brief asking for captions and
// zooms reaches the editor untouched whatever else this thinks of it.
// Measurable bar: with the flag ON, jobs reaching the editor fall by EXACTLY
// the parked count and by nothing else.
//
// DARK by default. Dark means classify, RECORD the decision and the sentence
// that would have been shown, and dispatch anyway — so the false-positive cost
// is knowable before a user ever sees a line.

const FLAG = 'PROMPTLY_NEGOTIATE_OUT_OF_SCOPE';

function flagOn(env = process.env) {
  return String(env[FLAG] || '').trim() in { '1': 1, true: 1, on: 1 };
}

// ── the scan: token presence, mechanically ─────────────────────────────────
// A NEGATED ask is a CONSTRAINT, never out of scope. "Do NOT apply any beauty
// filter ... keep my natural skin texture" ranked #10 in the backlog on the
// word "filter" before this rule existed — 10 jobs, all completed. Telling that
// user "I don't apply color grades" answers a question they did not ask.
// The negation and the object are often separated by a verb and a determiner:
// "don't ADD ANY b-roll", "no NEED FOR music". Allowing only a determiner let
// "don't add any b-roll" through as a request for b-roll.
const NEG_BEFORE = new RegExp(
  "(mute|remove|without|no|not|delete|strip|get rid of|take out|don'?t|dont|do not|never|avoid|skip|keep (my|the|it) natural)"
  + "\\s+(?:(add|use|include|put|apply|insert|want|need|do)\\w*\\s+)?(?:(the|any|some|a|an)\\s+)?$", 'i');

const RULES = [
  ['music',           /\b(background music|bgm|add (a )?song|add music|music track|soundtrack|背景音楽)/i],
  ['upscale_quality', /\b(4\s?k|8\s?k|upscal|super.?resolution|make it hd|in hd|higher resolution|enhance the quality|improve the quality|sharpen)\b/i],
  ['generative_vfx',  /\b(anime|ai.generated|generate (a )?(scene|background|image|video)|replace the|remove the (person|man|woman|logo|name|text|object)|remove the background(?!\s+(music|audio|sound|noise|hum|track))|change the background(?!\s+(music|audio|sound|noise))|make (him|her|them) (say|blink|smile|move)|turn (me|him|her|this) into)\b/i],
  ['stock_broll',     /\b(stock (footage|video|clip)|b-?roll)\b/i],
  ['voiceover_tts',   /\b(voice.?over|tts|text.to.speech|ai (voice|narrator)|clone my voice)\b/i],
  ['ai_avatar',       /\b(avatar|digital human|ai presenter)\b/i],
  ['color_grade_lut', /\b(colou?r grad|lut\b|cinematic colou?r|colou?r correct)\b/i],
  ['translation_dub', /\b(translat|dub\b|dubbing|traduc)/i],
];

// ASPECT IS THREE THINGS, NOT ONE. Output follows the source's shape, so asking
// for the shape you already have is a no-op, not a refusal. Splitting this
// saved ~246 users a month from being told "no" to the product's own default.
const ASPECT_VERTICAL = /\b(9\s?:\s?16|vertical|portrait|縦型)\b/i;
const ASPECT_WIDE = /\b(16\s?:\s?9|1\s?:\s?1|4\s?:\s?5|square|landscape|horizontal|横型)\b/i;

// SAFETY MATCHES LOOSELY, ON PURPOSE. The first version required "their
// clothes" and let "Just remove there clothes" through to the editor — a real
// production brief, and a misspelling is not consent. Possessives are optional
// and commonly wrong; the verb and the object carry the meaning.
const UNSAFE = new RegExp([
  '\\bremov\\w*\\b[^.]{0,24}\\bcloth', '\\btake\\b[^.]{0,16}\\bcloth\\w*\\b[^.]{0,8}\\boff',
  '\\bundress', '\\bnaked\\b', '\\bnude\\b', '\\bnsfw\\b', '\\bsexual\\b', '\\bporn',
  '\\bstrip\\w*\\b[^.]{0,16}\\bcloth', '\\bbikini\\b[^.]{0,20}\\b(make|turn|put)',
  '\\btopless\\b', '\\bexplicit\\b[^.]{0,12}\\b(content|scene)',
].join('|'), 'i');

function scan(text) {
  const t = String(text || '');
  const hits = [];
  for (const [tag, re] of RULES) {
    const m = t.match(re);
    if (!m) continue;
    if (NEG_BEFORE.test(t.slice(Math.max(0, m.index - 30), m.index))) continue;  // a constraint
    hits.push(tag);
  }
  return hits;
}

// ── the copy. Zac signs it; this file only serves it. ──────────────────────
const SENTENCES = {
  generative_vfx:  "I edit the footage you uploaded — I can't generate new visuals or replace what's in the shot.",
  music:           "I don't add music to edits. You can add a track when you post it.",
  stock_broll:     "I only use footage from your own upload, so I can't pull in stock or outside clips. I can show other moments from your video instead.",
  upscale_quality: "I can't raise the resolution — the edit comes out at the quality you uploaded.",
  voiceover_tts:   "I can't generate a voiceover — I work with the audio already in your video.",
  ai_avatar:       "I can't create an AI presenter or avatar.",
  translation_dub: "I can't translate or dub the spoken audio.",
  aspect_to_other: "Promptly edits in vertical (9:16) — I can't export in another shape.",
  // aspect_to_vertical is IN SCOPE once reframe lands; until then it is a
  // not-yet, not a never, and the sentence says so.
  aspect_to_vertical_pending: "I can't reframe to vertical yet. I can edit it in its current shape.",
  // color_grade_lut is ABSENT ON PURPOSE: ChatCut can color grade
  // (submit_shader type "effect" = "color, blur, mask, LUT-style grade"), the
  // lane merely withholds the tool. It is a wiring item, not a negotiation,
  // and drafting a refusal for it would tell 164 users a month a falsehood.
};

/**
 * Compose ONE message for N out-of-scope asks: all N named, one "can do" list
 * that is ACTUALLY TRUE for this brief, one question.
 *
 * "Everything else you asked for I can do" is GENERATED, never canned — a brief
 * whose remaining asks are also out of scope gets no such clause at all.
 */
function compose(tags, { hasInScopeAsks }) {
  const lines = tags.map(t => SENTENCES[t]).filter(Boolean);
  if (!lines.length) return null;
  const refusal = lines.join(' ');
  const canDo = hasInScopeAsks
    ? ' Everything else you asked for I can do.'
    : '';
  return `${refusal}${canDo} Want me to go ahead?`;
}

/**
 * classify(text) -> decision. Pure, synchronous, no I/O. The Haiku fallback is
 * a separate call the caller makes only when `needs_llm` is true, so the hot
 * path stays free and the server never blocks on a model for the common case.
 */
function classify(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) return { verdict: 'PASS', reason: 'empty brief', oos: [], sentence: null, needs_llm: false };

  if (UNSAFE.test(t)) {
    // NOT a negotiation. A clean refusal, no render, no charge, and the text is
    // never stored in a fixture.
    return { verdict: 'REFUSE', reason: 'unsafe', oos: [], sentence: null, needs_llm: false };
  }

  const oos = scan(t);
  // aspect, split three ways against the source's shape
  const wantsVertical = ASPECT_VERTICAL.test(t), wantsWide = ASPECT_WIDE.test(t);
  const srcShape = opts.sourceShape || null;   // 'portrait' | 'landscape' | null
  if (wantsWide && srcShape === 'portrait') oos.push('aspect_to_other');
  else if (wantsVertical && srcShape === 'landscape') oos.push('aspect_to_vertical_pending');
  // keep-shape (and unknown source) never negotiates — output follows the source

  if (!oos.length) return { verdict: 'PASS', reason: 'no out-of-scope token', oos: [], sentence: null, needs_llm: false };

  return {
    verdict: 'NEGOTIATE',
    reason: `out-of-scope: ${oos.join(', ')}`,
    oos,
    sentence: compose(oos, { hasInScopeAsks: opts.hasInScopeAsks !== false }),
    // the scan cannot tell an ASK from a DESCRIPTION ("my vertical video",
    // "Tamil-English mixed voiceover"). On a hit the caller may adjudicate with
    // Haiku before acting; while dark, recording the scan's view is enough.
    needs_llm: true,
  };
}

/**
 * UNSAFE IS NEVER REGEX-ONLY.
 *
 * "Just remove there clothes" — a real production brief — passed to the editor
 * because the pattern wanted "their". And 15.2% of briefs are not in English
 * (pt 106, hi-Latn 95, ar 55, hi 52, id 39, es 33, ru 30 in 30 days): a pattern
 * written in English cannot read Portuguese. Verified, not assumed — the regex
 * passes "tire a roupa dela", "iske kapde hata do", "deixa ela pelada" and
 * "usko nanga kar do".
 *
 * So the regex is an EARLY REFUSE and never the last word. It exits fast on an
 * obvious hit; every other brief — including every brief it passed — is
 * adjudicated by the model, in whatever language it was written.
 *
 * Fails CLOSED on an error: if the adjudicator cannot be reached, the caller is
 * told REVIEW_UNAVAILABLE rather than given a false all-clear.
 */
const UNSAFE_SYSTEM = `You decide ONE thing: is this a request to make sexual, violent, hateful, or otherwise inappropriate video content?

The user is asking an AI video editor to edit footage they uploaded. Requests arrive in ANY language — Portuguese, Hindi written in Latin script, Arabic, Spanish, Indonesian, Russian. Read whatever you are given.

UNSAFE includes, in any language:
- removing or seeing through clothing, undressing, nudity, "make her naked", "tire a roupa", "kapde hata do"
- sexualising a person, including a request to make someone look more sexual
- violence against a real person, gore presented approvingly
- hateful content targeting a group
- sexual content involving anyone who may be a minor — treat ANY doubt here as unsafe

NOT unsafe:
- ordinary editing: cuts, captions, zooms, effects, music, b-roll, colour
- "remove the background", "remove the logo", "strip the captions", "take out the pauses"
- violence that is clearly fictional footage the user already has (a game clip, a movie scene)
- a swear word, an aggressive tone, a blunt instruction

Misspellings, slang and transliteration do not change the meaning: "there clothes" means "their clothes".

Answer with the tool. If you are genuinely unsure, say unsafe=false but set uncertain=true — a human reads those.`;

const UNSAFE_TOOL = {
  name: 'safety_verdict',
  input_schema: {
    type: 'object',
    properties: {
      unsafe: { type: 'boolean' },
      uncertain: { type: 'boolean', description: 'true when you could not tell' },
      language: { type: 'string', description: 'the language the request is written in' },
      why: { type: 'string', description: 'one short clause; never quote the request back' },
    },
    required: ['unsafe', 'uncertain', 'language', 'why'],
  },
};

async function adjudicateUnsafe(text, opts = {}) {
  // AN EXPLICIT apiKey WINS EVEN WHEN EMPTY. `opts.apiKey || process.env...`
  // fell through to the ambient key when a caller passed '' to mean "no key",
  // so the fail-closed path silently used a real credential and returned a real
  // all-clear. A test for the closed path cannot pass through the open one.
  const key = ('apiKey' in opts) ? opts.apiKey
    : (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY);
  const t = String(text || '').trim();
  if (!t) return { state: 'MEASURED', unsafe: false, uncertain: false, language: null, why: 'empty brief' };
  if (!key) return { state: 'REVIEW_UNAVAILABLE', unsafe: null, why: 'no model key configured' };
  const fetchFn = opts.fetch || globalThis.fetch;
  for (let a = 1; a <= 3; a++) {
    let r;
    try {
      r = await fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: opts.model || 'claude-haiku-4-5-20251001', max_tokens: 300,
          system: UNSAFE_SYSTEM, tools: [UNSAFE_TOOL],
          tool_choice: { type: 'tool', name: 'safety_verdict' },
          messages: [{ role: 'user', content: t.slice(0, 4000) }],
        }),
      });
    } catch (e) { if (a === 3) return { state: 'REVIEW_UNAVAILABLE', unsafe: null, why: `transport: ${e.message}` }; await new Promise(s => setTimeout(s, a * 1500)); continue; }
    if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, a * 1500)); continue; }
    const b = await r.json().catch(() => null);
    if (!b || b.error) return { state: 'REVIEW_UNAVAILABLE', unsafe: null, why: (b && b.error && b.error.message) || 'bad response' };
    const tu = (b.content || []).find(c => c.type === 'tool_use');
    if (!tu) return { state: 'REVIEW_UNAVAILABLE', unsafe: null, why: 'no tool_use in response' };
    return { state: 'MEASURED', ...tu.input };
  }
  return { state: 'REVIEW_UNAVAILABLE', unsafe: null, why: 'exhausted retries' };
}

/**
 * The full decision: the regex refuses early, the model always gets a say.
 * `classify()` remains synchronous for callers that only want the scan.
 */
// An outage alert must not fire once per job. One per window, and the window
// is stated rather than tuned: a Haiku outage is a single event, and 90 pages
// for it is the same as none.
const ALERT_WINDOW_MS = 10 * 60 * 1000;
let _lastAlertAt = 0;
function _shouldAlert(now = Date.now()) {
  if (now - _lastAlertAt < ALERT_WINDOW_MS) return false;
  _lastAlertAt = now;
  return true;
}

async function classifyWithSafety(text, opts = {}) {
  const base = classify(text, opts);
  if (base.verdict === 'REFUSE') {
    // A REGEX REFUSAL ALWAYS HOLDS. It never waits on the model and the model
    // cannot overturn it — the pattern only matches things that are unsafe on
    // their face, and an outage must not open that door.
    return { ...base, degraded: false, alert: null,
             safety: { state: 'MEASURED', unsafe: true, why: 'matched the early-refuse pattern', by: 'regex' } };
  }
  const safety = await adjudicateUnsafe(text, opts);

  if (safety.state !== 'MEASURED') {
    // DISPATCH NEVER DEPENDS ON THE MODEL BEING UP. A classifier outage must
    // not become a product outage, so the request proceeds exactly as it would
    // today — including an out-of-scope brief the regex wanted to negotiate.
    // Parking on a degraded read would change product behaviour during an
    // outage, which is the failure this rule exists to prevent.
    //
    // THE COST IS REAL AND IS NOT HIDDEN: while the adjudicator is down, unsafe
    // briefs the REGEX cannot see reach the editor — which is exactly today's
    // behaviour, so it is not a regression, but it is why the alert fires.
    return {
      verdict: 'PASS', reason: `safety review unavailable: ${safety.why}`,
      oos: [], sentence: null, degraded: true,
      alert: _shouldAlert(opts.now) ? {
        kind: 'safety_review_unavailable',
        detail: `the unsafe adjudicator is unreachable (${safety.why}). Dispatch is PROCEEDING — regex refusals still hold, but non-English and misspelled unsafe briefs are passing unchecked until it returns.`,
      } : null,
      safety: { ...safety, by: 'model' },
    };
  }

  if (safety.unsafe === true) {
    // THE MODEL OVERRIDES A REGEX PASS. This is the whole point.
    return { verdict: 'REFUSE', reason: 'unsafe (model)', oos: [], sentence: null,
             degraded: false, alert: null, safety: { ...safety, by: 'model' } };
  }
  return { ...base, degraded: false, alert: null, safety: { ...safety, by: 'model' } };
}

module.exports = { classify, classifyWithSafety, adjudicateUnsafe, scan, compose, flagOn, FLAG, SENTENCES };

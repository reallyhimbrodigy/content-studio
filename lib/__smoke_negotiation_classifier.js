'use strict';
// SMOKE + RED PROOF — the negotiation classifier.
//
// The properties that matter are mostly about what it must NOT do: not refuse
// an in-scope brief, not negotiate a constraint, not pass an unsafe request,
// and above all not change anything while the flag is off.
const assert = require('assert');
const m = require('./negotiation-classifier.js');
let pass = 0, fail = [];
const check = (n, c, why = '') => { if (c) { pass++; console.log(`  [ok] ${n}`); } else { fail.push(`${n} :: ${why}`); console.log(`  [FAIL] ${n}`); } };

// ── 1. DARK MEANS INERT. The flag governs the ACTION, never the reading. ───
check('the flag is OFF by default', !m.flagOn({}),
  'a negotiation that ships on by accident changes what every user sees');
check('the flag reads only explicit truthy values',
  !m.flagOn({ [m.FLAG]: '' }) && !m.flagOn({ [m.FLAG]: '0' }) && !m.flagOn({ [m.FLAG]: 'false' })
  && m.flagOn({ [m.FLAG]: '1' }) && m.flagOn({ [m.FLAG]: 'true' }) && m.flagOn({ [m.FLAG]: 'on' }));

// ── 2. ROUTER CONSERVATISM. In-scope briefs pass, untouched. ──────────────
const IN_SCOPE = [
  'Viral engaging video', 'Clean and engaging edit', 'Fast cuts, big captions',
  'add captions and zooms', 'make it punchy, cut the dead air',
  'Make this a smooth video, add zooms, sound effects and motion graphics.',
  'take out the pauses', 'clean up the audio', 'remove the background noise',
  'add captions in Hindi',                      // language ask, in scope
];
for (const t of IN_SCOPE)
  check(`PASSES an in-scope brief: ${JSON.stringify(t.slice(0, 40))}`,
    m.classify(t).verdict === 'PASS',
    'it may act ONLY on what today is silently dropped or unsafely rendered');

// ── 3. A NEGATED ask is a CONSTRAINT, never out of scope. ─────────────────
for (const t of ['Do NOT apply any beauty filter, keep my natural skin texture',
                 'no background music', 'mute the music', 'without captions',
                 "don't add any b-roll"])
  check(`does NOT negotiate a constraint: ${JSON.stringify(t.slice(0, 40))}`,
    m.classify(t).verdict === 'PASS',
    'telling a user "I don\'t do X" when they asked you NOT to do X answers a question they did not ask');

// ── 4. UNSAFE refuses, and a misspelling is not consent. ──────────────────
for (const t of ['Just remove there clothes', 'remove their clothes', 'take her clothes off',
                 'make this nsfw', 'undress the woman'])
  check(`REFUSES unsafe: ${JSON.stringify(t.slice(0, 34))}`,
    m.classify(t).verdict === 'REFUSE',
    'the first version required "their" and let the real production brief "there clothes" through');
check('unsafe is a REFUSAL, never a negotiation',
  m.classify('Just remove there clothes').sentence === null,
  'offering to proceed with part of an unsafe request is worse than the silent drop');

// ── 5. Out-of-scope negotiates, with ONE composed message. ────────────────
const multi = m.classify('Add background music, make it 4k, and add some stock b-roll', { hasInScopeAsks: false });
check('N out-of-scope asks produce ONE message', multi.verdict === 'NEGOTIATE' && multi.oos.length >= 3);
check('...naming every one of them',
  ['music', 'upscale_quality', 'stock_broll'].every(t => multi.oos.includes(t)));
check('...and NO false "everything else I can do" when nothing else survives',
  !/Everything else/.test(multi.sentence || ''),
  'that clause is generated only when it is true for THIS brief');
const mixed = m.classify('Add background music and captions', { hasInScopeAsks: true });
check('...but the clause IS present when the brief has in-scope asks',
  /Everything else you asked for I can do/.test(mixed.sentence || ''));

// ── 6. ASPECT follows the SOURCE's shape. Three ways, not one. ────────────
check('keep-shape never negotiates (vertical ask, portrait source)',
  m.classify('make it 9:16 vertical', { sourceShape: 'portrait' }).verdict === 'PASS',
  '246 jobs/month asked for the shape the product already produces');
check('keep-shape never negotiates (source shape unknown)',
  m.classify('make it vertical').verdict === 'PASS');
check('landscape -> vertical is a NOT-YET, not a never',
  (m.classify('make it vertical', { sourceShape: 'landscape' }).oos || []).includes('aspect_to_vertical_pending'));
check('portrait -> landscape stays negotiated',
  (m.classify('make it 16:9 landscape', { sourceShape: 'portrait' }).oos || []).includes('aspect_to_other'));

// ── 7. COLOR GRADING IS ABSENT ON PURPOSE. ───────────────────────────────
check('no sentence exists for color_grade_lut',
  !('color_grade_lut' in m.SENTENCES),
  'ChatCut CAN color grade (submit_shader type "effect"); the lane withholds the tool. Drafting a refusal would tell 164 users a month a falsehood');

console.log();
if (fail.length) { console.log(`NEGOTIATION CLASSIFIER: FAIL (${fail.length})`); fail.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log(`NEGOTIATION CLASSIFIER: PASS — ${pass} checks`);

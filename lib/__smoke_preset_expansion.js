#!/usr/bin/env node
'use strict';
// SERVER-SIDE PRESET EXPANSION. The rule that matters most is that anything a
// person TYPED reaches ChatCut byte for byte.
const assert = require('assert');
const p = require('./preset-expansion');

let n = 0;
const failed = [];
const leg = (name, fn) => {
  try { fn(); n += 1; console.log(`   ok  ${name}`); }
  catch (e) { failed.push(name); console.log(`   FAIL  ${name}: ${e.message}`); }
};

// L1 THE DEFAULT IS IDENTITY AND NOTHING IS REWRITTEN YET. The plumbing, the
// A/B and the logging all prove themselves on live traffic BEFORE any wording
// changes, so a later result is not confounded by the mechanism arriving with
// it.
leg('L1 default_is_identity_and_changes_nothing', () => {
  for (const q of p.PRESETS) {
    const r = p.expand(q.original);
    assert.strictEqual(r.sent, q.original, `${q.key} was rewritten by the default`);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.matched, true, `${q.key} must still MATCH`);
  }
  assert.ok(p.PRESETS.every((q) => q.expanded === null),
    'an expansion is set before a winner was picked');
});

// L2 EXACT MATCHES ONLY. A prefix or substring match would rewrite what a
// person typed, and this is the leg that stops it.
leg('L2 only_an_exact_match_is_a_preset', () => {
  const typed = [
    'Viral engaging video about my dog',
    'make it Viral engaging video please',
    'viral',
    'Viral engaging',
    'Clean and engaging edits',          // trailing s
    'Fast cuts big captions',            // missing comma
  ];
  for (const t of typed) {
    const r = p.expand(t);
    assert.strictEqual(r.matched, false, `${JSON.stringify(t)} must NOT match a preset`);
    assert.strictEqual(r.sent, t, 'a non-match must pass through unchanged');
  }
});

// L3 CASE AND WHITESPACE MATCH, BUT THE NORMALISED FORM IS NEVER RETURNED.
// Normalisation is for matching only — returning it would silently rewrite
// the user's own capitalisation.
leg('L3 normalisation_matches_but_is_never_sent', () => {
  const odd = '   viral   ENGAGING    video  ';
  const r = p.expand(odd);
  assert.strictEqual(r.matched, true, 'case and whitespace must still match');
  assert.strictEqual(r.sent, odd, 'the ORIGINAL string must be sent, not the normalised one');
  assert.notStrictEqual(r.sent, p.normalize(odd));
});

// L4 EVERY NON-MATCH IS BYTE-IDENTICAL, including the awkward inputs.
leg('L4 a_non_match_is_byte_identical', () => {
  for (const v of ['', ' ', null, undefined, 'a\nb', '  spaced  out  ', '😂 emoji',
                   'Ünïcode', 'tabs\there']) {
    const want = v == null ? '' : String(v);
    assert.strictEqual(p.expand(v).sent, want, `${JSON.stringify(v)} changed`);
  }
});

// L5 THE TWO SMOOTH-ZOOMS STRINGS ARE SEPARATE ENTRIES, NOT ONE LOOSE
// PATTERN. They differ only by a "+", and a pattern loose enough to catch
// both is loose enough to catch a sentence someone typed — this repo has
// already paid for a matcher that learned a sentence's FORM.
leg('L5 near_identical_presets_are_separate_entries', () => {
  const a = 'Make this a smooth video, add zooms, sound effects and motion graphics.';
  const b = 'Make this a smooth video, add zooms, + sound effects and motion graphics.';
  const ra = p.expand(a); const rb = p.expand(b);
  assert.strictEqual(ra.matched, true);
  assert.strictEqual(rb.matched, true);
  assert.notStrictEqual(ra.preset_key, rb.preset_key, 'they must be distinct keys');
});

// L6 THE LOG CARRIES ORIGINAL AND SENT, AND SURVIVES A HOSTILE VIBE. The
// first version of logLine built `original` from sent.slice(0,0) — the empty
// string — so it would have logged an empty original on every request while
// LOOKING present. A log that is wrong is worse than one that is missing.
leg('L6 the_log_carries_the_original_and_cannot_be_broken', () => {
  const nasty = 'line one\nline "two"\ttab';
  const line = p.logLine(p.expand(nasty));
  assert.ok(line.includes('original='), 'no original field');
  assert.ok(!/\n/.test(line), 'a newline in the vibe broke the log line');
  assert.ok(line.includes('\\n'), 'the newline must be escaped, not dropped');
  assert.ok(p.logLine(p.expand('Viral engaging video')).includes('key=viral_engaging'));
});

// L7 THE EXPANDED VARIANT STILL CANNOT REWRITE A TYPED VIBE. When a winner is
// picked and `expanded` is filled in, the exact-match rule must still hold —
// this is the leg that will matter on the day the wordings land.
leg('L7 even_the_expanded_variant_only_touches_exact_matches', () => {
  const q = p.PRESETS[0];
  const saved = q.expanded;
  q.expanded = 'SOME LONGER WORDING';
  try {
    assert.strictEqual(p.expand(q.original, { variant: 'expanded' }).sent, 'SOME LONGER WORDING');
    assert.strictEqual(p.expand(q.original, { variant: 'expanded' }).changed, true);
    const typed = q.original + ' about my dog';
    assert.strictEqual(p.expand(typed, { variant: 'expanded' }).sent, typed,
      'the expanded variant rewrote a TYPED vibe');
    // and identity still never rewrites, even with a wording available
    assert.strictEqual(p.expand(q.original, { variant: 'identity' }).sent, q.original);
  } finally { q.expanded = saved; }
});

if (failed.length) {
  console.log(`preset-expansion: FAIL (${failed.join(', ')})`);
  process.exit(1);
}
console.log(`preset-expansion: PASS (${n} legs — identity by default, exact matches only, `
  + `a typed vibe reaches ChatCut byte for byte)`);

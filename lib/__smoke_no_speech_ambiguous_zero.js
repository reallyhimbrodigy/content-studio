'use strict';
// ── THE ZERO MEANT TWO THINGS ──────────────────────────────────────────────
//
// preDispatchNoSpeechGate rejects a clip on `word_count === 0`. The prewarm
// hint emits that value BOTH for a genuinely speechless clip and for one whose
// transcript is not cached yet — production hint lines pair
// `transcript_cached: false` with `word_count: 0` routinely, and `null` appears
// too. One value, two meanings, and the guard could not tell them apart.
//
// The gate's own contract already promised the right behaviour: "a missing or
// UNKNOWN word_count returns { gated:false }". The code simply had no way to
// recognise unknown, because unknown and zero were the same number.
//
// The failure this prevents is the most expensive kind of false reject: the
// user is told their clip has no speech, and it does. Masked today only because
// a routing flag skips the gate entirely — which is a trap, not a fix.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stripComments } = require('./__gate_strip');

const code = stripComments(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));
const i = code.indexOf('async function preDispatchNoSpeechGate');
assert.ok(i > 0, 'preDispatchNoSpeechGate is gone');
const fn = code.slice(i, code.indexOf('\n}', i) + 2);

// ── 1. THE GUARD CONSULTS A SECOND FIELD ──────────────────────────────────
assert.ok(/transcript_cached/.test(fn),
  'the gate decides on word_count alone. That value is 0 both for "no speech" and '
  + 'for "no transcript yet"; transcript_cached is the field that separates them.');

// ── 2. A BARE `word_count === 0` NO LONGER GATES ON ITS OWN ───────────────
{
  const gateLine = /if\s*\(([^)]*word_count\s*===\s*0[^)]*)\)/.exec(fn);
  assert.ok(gateLine, 'no word_count === 0 gate found — the scan is empty, not clean');
  assert.ok(!/^\s*hint\s*&&\s*hint\.word_count\s*===\s*0\s*$/.test(gateLine[1]),
    'the guard is back to `hint && hint.word_count === 0`, which rejects an '
    + 'uncached transcript as a speechless clip');
  assert.ok(/known/i.test(gateLine[1]),
    'the gate must test a KNOWN word count, not a raw one');
}

// ── 3. null / undefined ARE NOT ZERO ──────────────────────────────────────
// word_count: null appears in production hints. Without an integer test,
// `null === 0` is false so it happens to pass — but `Number(null) === 0` is
// true, and any future coercion reintroduces the bug silently.
assert.ok(/Number\.isInteger\s*\(\s*hint\.word_count\s*\)/.test(fn),
  'word_count must be proven an integer before it is compared to 0 — null and '
  + 'undefined both appear on real hints');

// ── 4. THE FAIL-OPEN CONTRACT SURVIVES ────────────────────────────────────
// Every path that is not a confirmed zero must still dispatch. A gate that
// starts failing closed on an unknown is worse than the bug it replaced.
assert.ok(/return \{ gated: false/.test(fn),
  'the unknown path must still return gated:false and dispatch');
{
  const gatedTrue = (fn.match(/gated:\s*true/g) || []).length;
  assert.strictEqual(gatedTrue, 1,
    `exactly one path may gate; found ${gatedTrue}`);
}

// ── 5. BEHAVIOURAL: run the real predicate against the shapes production emits
{
  const m = /const wordCountKnown = ([\s\S]*?);\n/.exec(fn);
  assert.ok(m, 'the known-ness test is not in one place where it can be read');
  const decide = new Function('hint',
    `const wordCountKnown = ${m[1]}; return Boolean(wordCountKnown && hint.word_count === 0);`);

  // The trap: uncached transcript reporting zero. Must NOT gate.
  assert.strictEqual(decide({ transcript_cached: false, word_count: 0 }), false,
    'an UNCACHED transcript reporting 0 words must not reject the clip — this is '
    + 'the exact shape production emits, and the exact false reject');
  assert.strictEqual(decide({ transcript_cached: false, word_count: null }), false);
  assert.strictEqual(decide({ transcript_cached: undefined, word_count: 0 }), false);
  assert.strictEqual(decide({ word_count: 0 }), false);
  // Genuine speechless clip, transcript present. MUST still gate — the whole
  // point is saving 20-40s of GPU on these.
  assert.strictEqual(decide({ transcript_cached: true, word_count: 0 }), true,
    'a CACHED transcript with 0 words is a real speechless clip and must still '
    + 'be rejected pre-dispatch, or the gate has been disabled rather than fixed');
  // Anything with speech dispatches.
  assert.strictEqual(decide({ transcript_cached: true, word_count: 1 }), false);
  assert.strictEqual(decide({ transcript_cached: true, word_count: 149 }), false);
  assert.strictEqual(decide({ transcript_cached: true, word_count: null }), false);
}

console.log('[smoke] no-speech ambiguous zero: PASS (transcript_cached separates "no speech" '
  + 'from "not looked yet"; an uncached 0 and a null no longer reject; a cached 0 still does; '
  + 'the fail-open contract holds and exactly one path gates)');

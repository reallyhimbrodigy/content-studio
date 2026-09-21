'use strict';
// ── "TIMEOUT/NOT-FIRED" WAS ONE STRING FOR TWO OPPOSITE FIXES ───────────────
//
// awaitPrewarmHint returned bare null whether prewarm had NEVER FIRED (no
// registry entry — the client never called /api/prewarm, nothing was waited
// for) or had fired and NOT SETTLED inside the cap (dispatch blocked 3-4s for
// nothing). The downstream log said `prewarm timeout/not-fired`, 84 times a
// day, and no one could tell which half they were looking at.
//
// They need opposite fixes. "Never fired" is upstream of dispatch and costs no
// latency. "Too slow" is the cap or the prewarm and is pure added latency on
// every occurrence. Tuning the wait on a mixed signal moves the wrong number.
//
// This asserts the two are separable AND that the separation reaches the log.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stripComments } = require('./__gate_strip');

const SRC = path.join(__dirname, 'video-processor', 'dispatch-to-modal.js');
const code = stripComments(fs.readFileSync(SRC, 'utf8'));

// ── 1. THE OUT-PARAM EXISTS AND EVERY EXIT SETS A REASON ──────────────────
{
  const i = code.indexOf('async function awaitPrewarmHint');
  assert.ok(i > 0, 'awaitPrewarmHint is gone');
  const fn = code.slice(i, code.indexOf('\n}', i) + 2);
  assert.ok(/async function awaitPrewarmHint\(videoUrl,\s*outcome\)/.test(fn),
    'the outcome out-param is gone — the two states collapse back into one null');

  for (const reason of ['not_fired', 'timeout', 'hit', 'threw']) {
    assert.ok(new RegExp(`reason\\s*=\\s*['"\`]${reason}['"\`]`).test(fn)
              || new RegExp(`['"\`]${reason}['"\`]`).test(fn),
      `no exit sets reason='${reason}'; that state is unreportable`);
  }
  // The timeout branch must carry the two numbers that separate "prewarm is
  // slow" from "the wait was never going to pay".
  assert.ok(/firedAgoMs/.test(fn) && /waitedMs/.test(fn) && /capMs/.test(fn),
    'the timeout outcome must record how long prewarm had been running, how long '
    + 'dispatch actually blocked, and the cap — a bare "timeout" cannot be tuned');
  // The return contract is unchanged, so the other caller keeps working.
  assert.ok(/return null;/.test(fn) && /return result;/.test(fn),
    'awaitPrewarmHint must still return the hint or null — preDispatchNoSpeechGate '
    + 'calls it without an outcome and must not break');
}

// ── 2. THE LOG SITE EMITS A DISTINCT LINE PER STATE ───────────────────────
{
  const i = code.indexOf('hintResult === null');
  assert.ok(i > 0, 'the null-hint log branch is gone');
  const branch = code.slice(i, i + 1600);
  assert.ok(!/timeout\/not-fired/.test(code),
    'the conflated string is back. One label for two states is what made 84 daily '
    + 'occurrences untunable.');
  for (const tag of ['NOT_FIRED', 'HINT_TIMEOUT']) {
    assert.ok(branch.includes(tag), `the ${tag} line is missing`);
  }
  assert.ok(/hintOutcome\.reason\s*===\s*['"]not_fired['"]/.test(branch),
    'the log must branch on the recorded reason, not re-derive it');
  // The numbers have to reach the reader, not just the object.
  assert.ok(/firedAgoMs\}/.test(branch) && /waitedMs\}/.test(branch),
    'HINT_TIMEOUT must print the elapsed and waited values — an outcome object '
    + 'nobody prints is the same blind spot one layer in');
}

// ── 3. THE CALL SITE ACTUALLY PASSES THE OUT-PARAM ────────────────────────
// Producer and consumer in the same assertion: an outcome that is populated but
// never passed, or passed but never read, is the inert-half shape.
{
  assert.ok(/awaitPrewarmHint\(videoUrl,\s*hintOutcome\)/.test(code),
    'dispatch calls awaitPrewarmHint WITHOUT the outcome object, so every state '
    + 'reports as the fallback branch and the split is decorative');
  const decl = /const hintOutcome = \{\};/.test(code);
  assert.ok(decl, 'hintOutcome is never declared');
}

console.log('[smoke] prewarm hint outcome: PASS (not_fired / timeout / hit / threw are '
  + 'separable; the log emits a distinct line per state carrying firedAgo, waited and cap; '
  + 'the out-param is passed at the call site and the return contract is unchanged)');

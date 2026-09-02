'use strict';

// THE DELIVERY LAW MUST LIVE IN THE REPO
//
// "Every artifact goes through deliver_render.sh — no exceptions" was enforced
// by a script that existed ONLY at
// ~/content-studio/.worktrees/lane-judge/scripts/, on an unmerged branch, with
// LANE hardcoded to that absolute path. Both shells and all three Python
// instruments lived there. Clean the worktree and the only sanctioned way to put
// an mp4 in front of the owner vanishes — a law enforced by an unmerged worktree
// is not a law.
//
// This pins the whole closure onto main and, more importantly, pins that the
// scripts do not REACH BACK into a worktree. Copying them while leaving LANE
// pointing at .worktrees would look fixed and behave exactly as before.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const S = path.join(__dirname, '..', 'scripts');
const failures = [];
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures.push(`${name} — ${e.message}`); console.log(`  FAIL ${name} — ${e.message}`); }
}
const read = (f) => fs.readFileSync(path.join(S, f), 'utf8');
// Strip comments before absence-testing: this file's own explanatory prose names
// the worktree path, and prose is not behaviour. Third time that has bitten.
const code = (f) => read(f).split('\n').map((l) => l.replace(/(^|[^:])#.*$/, '$1')).join('\n');

// ── 1. THE WHOLE CLOSURE IS PRESENT ────────────────────────────────────────
// Not just the two entry points: prereport invokes score_component and
// visual_critic, and score_component imports lumen_video_dimensions. A partial
// copy exits 2 ("could not run"), which the pre-report law says is NOT a pass —
// so a missing dependency would silently block every delivery.
for (const f of ['deliver_render.sh', 'prereport_render.sh', 'score_component.py',
                 'visual_critic.py', 'lumen_video_dimensions.py']) {
  check(`scripts/${f} is in the repo`, () => {
    assert.ok(fs.existsSync(path.join(S, f)), 'missing');
    assert.ok(fs.statSync(path.join(S, f)).size > 200, 'suspiciously small — a stub?');
  });
}

// ── 2. NOTHING REACHES BACK INTO A WORKTREE ────────────────────────────────
for (const f of ['deliver_render.sh', 'prereport_render.sh', 'score_component.py',
                 'visual_critic.py', 'lumen_video_dimensions.py']) {
  check(`${f} contains no .worktrees path`, () => {
    assert.ok(!/\.worktrees/.test(code(f)),
      'reaches into a worktree — copying the file without repointing LANE leaves '
      + 'the law depending on an unmerged branch exactly as before');
  });
}

check('both shells resolve LANE from their own directory', () => {
  for (const f of ['deliver_render.sh', 'prereport_render.sh']) {
    assert.ok(/LANE="\$\{0:A:h\}"/.test(read(f)),
      `${f} does not self-locate — a checkout anywhere else breaks`);
  }
});

// ── 3. THE GATE ORDER IS THE POINT ─────────────────────────────────────────
// "Gates first, copies second." A deliver that copies before gating is not a
// gate, it is a log line.
check('deliver_render.sh runs the gate BEFORE copying', () => {
  const s = code('deliver_render.sh');
  const gate = s.indexOf('prereport_render.sh');
  const copy = s.indexOf('cp "$SRC"');
  assert.ok(gate > 0, 'the gate is never invoked');
  assert.ok(copy > gate, 'it copies before gating — that is not a gate');
});

check('a failing gate blocks delivery unless explicitly overridden', () => {
  const s = code('deliver_render.sh');
  assert.ok(/PROMPTLY_DELIVER_ANYWAY/.test(s), 'no deliberate override path');
  assert.ok(/gate -ne 0[\s\S]{0,80}PROMPTLY_DELIVER_ANYWAY/.test(s),
    'the override is not gated on the gate having failed');
});

// ── 4. EXIT 2 IS NOT A PASS ────────────────────────────────────────────────
// The pre-report law. "Could not run" must be distinguishable from "ran and
// passed", or an unrunnable gate reads as a green one — the false-green class
// that produced four separate incidents on 2026-08-23.
check('"could not run" exits 2, distinctly from pass(0) and fail(1)', () => {
  const p = code('prereport_render.sh');
  assert.ok(/exit 2/.test(p), 'prereport never exits 2');
  assert.ok(/ffmpeg[\s\S]{0,120}exit 2/.test(p),
    'a missing ffmpeg does not exit 2 — the gate would pass by absence');
  const d = code('deliver_render.sh');
  assert.ok(/exit 2/.test(d), 'deliver never exits 2 on an unreadable input');
});

if (failures.length) {
  console.error(`\n[smoke] FAILED: ${failures.length} delivery-path assertion(s)`);
  process.exit(1);
}
console.log('[smoke] delivery path lives in the repo: OK');

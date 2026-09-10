'use strict';
// The server half of the agentic wire, asserted against server.js itself.
// The three traps from the worker contract (f6d48eb), plus the one property
// that makes shipping this safe: IT IS DARK BY DEFAULT.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
// Comments stripped before matching. A gate that greps raw source flags the
// paragraph explaining the defect it guards against — that has bitten this repo
// three times now, including this same author.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── TRAP 1: presence where shape was needed ─────────────────────────────────
assert.ok(!/typeof\s+orig\.edit_recipe\s*===\s*'object'/.test(CODE),
  "TRAP 1: `typeof orig.edit_recipe === 'object'` is back. It is TRUE for the "
  + 'agentic plan (a list) as well as handler\'s recipe (a dict), so a plan '
  + 'resolves to mode tweak and dispatches to handler.py, which cannot read it. '
  + 'Legal values, no throw, a confidently wrong edit.');
assert.ok(/isHandlerRecipe\(orig\.edit_recipe\)/.test(CODE),
  'mode resolution must go through isHandlerRecipe, which excludes arrays');

// ── TRAP 2: the route is a stored fact, not an inference ────────────────────
assert.ok(/function routeForNewJob\s*\(/.test(CODE), 'routeForNewJob must exist');
assert.ok(/pipeline:\s*routeForNewJob\(\)/.test(CODE),
  'the fresh-render site must STORE the route it chose');
assert.ok(!/pipeline\s*=\s*.*(agentic_plan|edit_recipe)/.test(CODE),
  'TRAP 2: the pipeline must never be derived from which plan column is '
  + 'populated — that is presence-for-shape one level up, and a job whose plan '
  + 'write failed would read as the other pipeline');
// A derivative inherits; it must not re-resolve from config, or a flag flip
// mid-life hands an agentic plan to handler.
assert.ok(/pipeline:\s*\(orig\.pipeline === 'handler' \|\| orig\.pipeline === 'agentic'\)/.test(CODE),
  'a re-edit must INHERIT the parent pipeline, not call routeForNewJob() again');
assert.ok(/\.select\('id, user_id, status, video_url, vibe_input, edit_recipe[^']*pipeline[^']*'\)/.test(CODE),
  'the re-edit read must SELECT pipeline, or the inherit above reads undefined '
  + 'and every derivative silently becomes NULL');

// ── TRAP 3: there is no reinterpret on the agentic path ─────────────────────
// reinterpret means "no recipe, redo from the vibe". Mapping it onto an agentic
// re-edit sends an instruction with no prior_plan — a fresh edit wearing a
// re-edit's name, counted as one everywhere, and free (shouldDebit is false for
// every re-edit variant). Asserted as: the reinterpret literal may only appear
// on the handler branch, which is the one that owns that vocabulary.
const reinterpretLines = CODE.split('\n').filter((l) => /'reinterpret'/.test(l));
assert.ok(reinterpretLines.length > 0, 'positive control: the handler branch still has it');
for (const l of reinterpretLines) {
  assert.ok(!/agentic/i.test(l),
    `TRAP 3: reinterpret appears on an agentic line — ${l.trim()}`);
}

// ── DARK BY DEFAULT: the property that makes this shippable ─────────────────
assert.ok(/const AGENTIC_ENABLED\s*=\s*\n?\s*String\(process\.env\.AGENTIC_ENABLED \|\| ''\)\.trim\(\) === '1'/.test(CODE),
  'AGENTIC_ENABLED must be an explicit ===\'1\' opt-in, not a truthiness test');
assert.ok(/\(AGENTIC_ENABLED && AGENTIC_BASE_URL\) \? 'agentic' : 'handler'/.test(CODE),
  'routeForNewJob must FAIL CLOSED: an armed flag with no base URL would 500 '
  + 'every render, so the URL is conjoined rather than assumed');

// The knob and the money switch must stay separate. Coupling them would mean
// arming the pipeline required repricing every tier — see the credits work.
assert.ok(!/AGENTIC_ENABLED[^\n]*CREDITS_DEBIT_ENABLED|CREDITS_DEBIT_ENABLED[^\n]*AGENTIC_ENABLED/.test(CODE),
  'the routing flag and the debit flag must not be conjoined');

// ── the module the whole thing rests on is actually wired ───────────────────
assert.ok(/require\('\.\/lib\/agentic-plan'\)/.test(CODE), 'agentic-plan must be required');
const ap = require('./agentic-plan');
assert.strictEqual(ap.isHandlerRecipe({ cuts: [] }), true);
assert.strictEqual(ap.isHandlerRecipe([{ src_t0: 0, src_t1: 1, id: 'aaaaaaaaaaaa' }]), false,
  'end-to-end: the module server.js calls must itself refuse a list as a recipe');

console.log('[smoke] agentic wire: ALL PASS (shape not presence at the mode gate; route '
  + 'stored at creation and inherited by derivatives; no reinterpret on the agentic '
  + 'path; dark by default and fail-closed on a missing URL)');

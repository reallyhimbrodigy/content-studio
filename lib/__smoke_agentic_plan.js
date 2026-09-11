'use strict';
// The two shapes must not be able to pass for one another. That is the whole
// file. Everything else here exists to stop a future simplification collapsing
// the check back into `typeof === 'object'`.
const assert = require('assert');
const {
  validateAgenticPlan, isHandlerRecipe, MAX_ENTRIES,
} = require('./agentic-plan');

// isAgenticPlan(v) was deleted as an orphan — no production caller, because
// every real site wants the REASON, not a boolean. The smoke keeps a local
// shorthand so these cases still read as predicates.
const isAgenticPlan = (v) => validateAgenticPlan(v).ok;

const entry = (o = {}) => ({
  src_t0: 1.5, src_t1: 3.25, id: 'a1b2c3d4e5f6',
  purpose: 'hook', treatment: ['zoom'], cut: 'keep',
  text_content: null, card_hero: null, card_label: null,
  sfx_name: null, sfx: null, why: null, zoom_arc: 'hook', ...o,
});

// ── 1. a real plan passes ───────────────────────────────────────────────────
const plan = [entry(), entry({ src_t0: 4, src_t1: 6, id: '0123456789ab', purpose: 'payoff' })];
assert.strictEqual(validateAgenticPlan(plan).ok, true);
assert.strictEqual(validateAgenticPlan(plan).entries, 2);

// ── 2. THE TRAP. handler's recipe is a DICT and must never read as a plan ────
const recipe = { cuts: [{ start: 0, end: 3 }], music: 'x', captions: true };
assert.strictEqual(typeof recipe, 'object',
  'the premise: typeof says object, which is why typeof was never enough');
assert.strictEqual(isAgenticPlan(recipe), false,
  'THE TRAP: a handler recipe passing as a plan dispatches to handler.py with a '
  + 'structure it cannot read — legal values, no error, confidently wrong edit');
assert.strictEqual(isHandlerRecipe(recipe), true);
// and the converse, which is the same defect facing the other way
assert.strictEqual(isHandlerRecipe(plan), false,
  'a plan must not read as a recipe either — Array is an object too');
assert.strictEqual(isAgenticPlan(plan), true);

// ── 3. Array.isArray ALONE is presence, one level down ──────────────────────
const listOfWrongDicts = [{ start: 0, end: 3 }, { start: 3, end: 7 }];
assert.ok(Array.isArray(listOfWrongDicts), 'the premise for this case');
assert.strictEqual(isAgenticPlan(listOfWrongDicts), false,
  'a LIST OF THE WRONG DICTS must fail — Array.isArray says "a list", not "a '
  + 'list of the right thing", and stopping there repeats the original mistake');

// ── 4. the three load-bearing fields, one at a time ──────────────────────────
for (const [what, bad] of [
  ['src_t0 missing', entry({ src_t0: undefined })],
  ['src_t0 a numeric STRING', entry({ src_t0: '1.5' })],
  ['src_t1 NaN', entry({ src_t1: NaN })],
  ['src_t1 before src_t0', entry({ src_t0: 9, src_t1: 2 })],
  ['id not hex', entry({ id: 'ZZZZZZZZZZZZ' })],
  ['id wrong length', entry({ id: 'abc123' })],
  ['id uppercase', entry({ id: 'A1B2C3D4E5F6' })],
  ['entry is null', null],
  ['entry is an array', []],
]) {
  const r = validateAgenticPlan([bad]);
  assert.strictEqual(r.ok, false, `must reject: ${what}`);
  assert.ok(r.reason && /entry 0/.test(r.reason), `must say WHICH entry: ${what}`);
}

// ── 5. the optional fields are genuinely optional ────────────────────────────
assert.strictEqual(validateAgenticPlan([{ src_t0: 0, src_t1: 1, id: 'ffffffffffff' }]).ok, true,
  'only the three load-bearing fields are required — rejecting a plan for a null '
  + 'purpose would refuse plans the worker considers good');

// ── 6. EMPTY IS NOT A PLAN ──────────────────────────────────────────────────
assert.strictEqual(validateAgenticPlan([]).ok, false);
assert.strictEqual(validateAgenticPlan([]).reason, 'empty',
  'an empty plan sent as prior_plan reads to the worker as "modify nothing" — a '
  + 'fresh edit wearing a re-edit name, which is trap 3 by another road');

// ── 7. the shapes that are neither ──────────────────────────────────────────
for (const v of [null, undefined, 'a string', 42, true, new Date()]) {
  assert.strictEqual(isAgenticPlan(v), false, `not a plan: ${String(v)}`);
}
assert.strictEqual(isHandlerRecipe(null), false, 'null is typeof object — the classic');
assert.strictEqual(isHandlerRecipe(new Date()), true,
  'a Date IS a non-array object; isHandlerRecipe is deliberately loose because '
  + 'handler owns its own shape — the strictness that matters is on the plan side');

// ── 8. the size ceiling ─────────────────────────────────────────────────────
const huge = Array.from({ length: MAX_ENTRIES + 1 }, () => entry());
assert.strictEqual(validateAgenticPlan(huge).ok, false, 'a plan past the ceiling is a bug');
assert.strictEqual(validateAgenticPlan(Array.from({ length: 3 }, () => entry())).ok, true);

console.log('[smoke] agentic plan: ALL PASS (a handler recipe cannot pass as a plan, a '
  + 'list of wrong dicts cannot either, empty is not a plan, the three load-bearing '
  + 'fields are checked per entry)');

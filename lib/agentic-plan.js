'use strict';

// ── WHAT MAKES A PLAN A PLAN ────────────────────────────────────────────────
//
// THE TRAP THIS EXISTS TO CLOSE. server.js resolved re-edit mode with:
//
//     const hasSavedPlan = orig.edit_recipe && typeof orig.edit_recipe === 'object';
//     const mode = hasSavedPlan ? 'tweak' : 'reinterpret';
//
// handler.py's recipe is a DICT. The agentic plan is a LIST. `typeof` answers
// 'object' for both, and for null-guarded arrays, and for Date, and for
// anything else. So a plan stored in edit_recipe passes hasSavedPlan, mode
// becomes 'tweak', and the job dispatches to handler.py carrying a structure it
// cannot read. Every value legal, nothing throws, and the user gets a
// confidently wrong edit.
//
// That is the `_delivered` class this project has already paid for three times:
// A CHECK THAT TESTED PRESENCE WHERE IT NEEDED TO TEST SHAPE. `typeof x ===
// 'object'` is presence. So is Array.isArray on its own — it says "a list", not
// "a list of the right thing", and a list of the wrong dicts would sail through
// it exactly as the dict sailed through typeof. The validation below therefore
// goes per-element, and the gate proves a handler recipe cannot pass it.
//
// THREE FIELDS ARE LOAD-BEARING, per the worker contract (f6d48eb): src_t0,
// src_t1 and id. They are what give a ruling a durable address on the source,
// which is the whole mechanism a re-edit rests on. Everything else in an entry
// may legitimately be null and is NOT validated here — validating optional
// fields would reject a plan the worker considers good, and this module's job
// is to refuse the wrong SHAPE, not to have opinions about content.

/** The worker derives ids as 12 hex chars from (src_t0, src_t1, family, content). */
const PLAN_ID_RE = /^[0-9a-f]{12}$/;

const MAX_ENTRIES = 2000;   // a plan larger than this is a bug, not a long video

function _entryProblem(e, i) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return `entry ${i} is not an object`;
  if (typeof e.src_t0 !== 'number' || !Number.isFinite(e.src_t0)) return `entry ${i}: src_t0 is not a finite number`;
  if (typeof e.src_t1 !== 'number' || !Number.isFinite(e.src_t1)) return `entry ${i}: src_t1 is not a finite number`;
  if (e.src_t1 < e.src_t0) return `entry ${i}: src_t1 (${e.src_t1}) precedes src_t0 (${e.src_t0})`;
  if (typeof e.id !== 'string' || !PLAN_ID_RE.test(e.id)) return `entry ${i}: id is not 12 hex chars`;
  return null;
}

/**
 * Is this value an agentic plan? Returns { ok, reason, entries }.
 *
 * An EMPTY ARRAY IS NOT A PLAN — `ok:false`, reason 'empty'. It is a real value
 * the worker can return, and `plan_entries` exists precisely so an empty one is
 * visible without parsing. Treating [] as a plan would send a re-edit with
 * `prior_plan: []`, which the worker reads as "modify nothing" — a fresh edit
 * wearing a re-edit's name, which is the third trap by another road.
 */
function validateAgenticPlan(value) {
  if (!Array.isArray(value)) {
    return { ok: false, reason: `not an array (${value === null ? 'null' : typeof value})`, entries: 0 };
  }
  if (value.length === 0) return { ok: false, reason: 'empty', entries: 0 };
  if (value.length > MAX_ENTRIES) {
    return { ok: false, reason: `too many entries (${value.length} > ${MAX_ENTRIES})`, entries: value.length };
  }
  for (let i = 0; i < value.length; i += 1) {
    const problem = _entryProblem(value[i], i);
    if (problem) return { ok: false, reason: problem, entries: value.length };
  }
  return { ok: true, reason: null, entries: value.length };
}

// A bare `isAgenticPlan(v)` predicate used to live here and was DELETED: the
// reachability check found it had no production caller, because every real site
// wants the REASON — which entry failed and why — not a boolean. A convenience
// wrapper that discards the diagnosis is the wrong convenience for this module,
// whose entire purpose is that a shape failure says what it was.

/**
 * Is this handler.py's edit_recipe? A plain object, and explicitly NOT an
 * array. This exists so the two shapes are decided by one module rather than by
 * whichever `typeof` the caller happened to write.
 */
function isHandlerRecipe(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  PLAN_ID_RE, MAX_ENTRIES, validateAgenticPlan, isHandlerRecipe,
};

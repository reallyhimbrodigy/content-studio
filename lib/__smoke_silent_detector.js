// Rule-1 smoke for the SILENT-FAILURE DETECTOR (_countEvents in bleed-meter.js).
// A completed job that delivers 0 events is invisible to every error metric; this
// is the only thing that sees it, so a miscount here silently un-sees the class.
// Run: node lib/__smoke_silent_detector.js  (no network, pure function).
const assert = require('assert');
const { _countEvents } = require('./bleed-meter');

let pass = 0;
const eq = (got, want, msg) => { assert.strictEqual(got, want, `${msg}: got ${got}, want ${want}`); pass++; };

// 1. standard editorial recipe with real events → counted across every channel
eq(_countEvents({
  cuts: [1, 2, 3],
  emphasis_moments: [
    { zoom_effect: { type: 'punch' } },          // +1
    { motion_graphic: { component: 'StatCard' } }, // +1
    { zoom_effect: { type: 'glide' }, motion_graphic: {} }, // +2
    { foo: 'bar' },                               // +0
  ],
  motion_graphics: [{}, {}],
  caption_keywords: [{}],
  transitions: [{}],
  broll_clips: [{}],
}), 3 + 4 + 2 + 1 + 1 + 1, 'standard shape counts all channels');

// 2. caption-less HypePlan shape ({route, reason, plan})
eq(_countEvents({ route: 'hype', reason: 'no_speech',
  plan: { clips: [1, 2, 3, 4], transitions: [1, 2] } }), 6, 'caption-less HypePlan shape');

// 3. THE SILENT CASE — completed but delivered nothing → 0 (the signal)
eq(_countEvents({ route: 'caption_less_pipeline', reason: 'no_speech', plan: { clips: [] } }),
   0, 'silent job (0 events) scores 0');
eq(_countEvents({ cuts: [], emphasis_moments: [] }), 0, 'empty standard recipe scores 0');

// 4. empty cuts falls through to clips (Python `cuts or clips` semantics)
eq(_countEvents({ cuts: [], clips: [1, 2, 3] }), 3, 'empty cuts falls through to clips');
eq(_countEvents({ cuts: [1, 2] }), 2, 'non-empty cuts wins over absent clips');

// 5. unreadable recipe → null (excluded, not counted as silent)
eq(_countEvents(null), null, 'null recipe unreadable');
eq(_countEvents('nope'), null, 'non-object recipe unreadable');
eq(_countEvents(undefined), null, 'undefined recipe unreadable');

console.log(`[smoke] silent-failure detector: ALL PASS (${pass} assertions — both shapes, silent=0, cuts→clips, unreadable→null)`);

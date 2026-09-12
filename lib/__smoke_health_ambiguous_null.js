'use strict';
// ── "NOT YET" AND "BROKEN" MUST NOT RENDER IDENTICALLY ───────────────────────
//
// Three fields in one day were CORRECT and silently ambiguous about which of
// two very different states they reported:
//
//   credits: 'off'          — operator disabled it? probe not fired yet? probe
//                             failed? RC unconfigured? floor unset? Read on a
//                             freshly booted process it looks like a fault, and
//                             it was a probe that had not run yet.
//   entitlementTiers: null  — "nobody has synced since boot" (normal for
//                             minutes after every deploy) or "asked RC and got
//                             nothing we recognise" (a renamed lookup_key makes
//                             paying users look free). Cost a full
//                             investigation into whether Max was unsellable.
//   route ledger            — an unlisted route's 404s booked against its
//                             PARENT, so /api/chat read as broken for 1,620
//                             users when nothing was wrong with it.
//
// The shape is one thing: A FIELD WHOSE ABSENCE MEANS TWO DIFFERENT THINGS.
// Each now carries a STATE beside the value. This asserts the pairing holds,
// because the next such field will be added by someone who has not read any of
// the above.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stripComments } = require('./__gate_strip');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const CODE = stripComments(SRC);

// Value field -> the companion that says WHICH state produced it.
const PAIRS = [
  ['credits:', 'creditsState:'],
  ['credits_metering:', 'creditsMeteringState:'],
  ['entitlementTiers:', 'entitlementTiersState:'],
];
for (const [value, state] of PAIRS) {
  assert.ok(CODE.includes(value), `positive control: ${value} not found in the health payload`);
  assert.ok(CODE.includes(state),
    `${value} has no companion ${state}. A field whose "off"/null means several `
    + 'different things sends an operator looking for a fault that may not '
    + 'exist — or, worse, reads as fine when it is not.');
}

// The resolver must NAME each cause separately. A single 'off' reason is the
// same defect with more ceremony.
const fn = (CODE.match(/function _resolveCreditsSwitch[\s\S]*?\n\}/) || [''])[0];
assert.ok(fn.length > 0, 'positive control: _resolveCreditsSwitch not found');
for (const reason of ['debit_disabled', 'disabled_by_operator', 'revenuecat_unconfigured',
                      'min_build_unset', 'probe_pending', 'probe_failed', 'armed']) {
  assert.ok(fn.includes(reason), `the resolver must distinguish '${reason}'`);
}

// PROBE PENDING IS NOT PROBE FAILED — the distinction that actually misled a
// reader. If these ever collapse, the normal state right after every deploy
// reads as an outage again.
assert.ok(/probe === null \|\| probe === undefined/.test(fn),
  'a probe that has not fired yet must be told apart from one that failed; '
  + 'pending is the NORMAL state for the first seconds after every deploy');
assert.ok(/probe_failed:\$\{probe\}/.test(fn),
  'a failed probe must carry WHICH failure, not just that it failed');

// And the value itself must not change shape — every existing reader of
// `credits` sees exactly what it saw before.
assert.ok(/credits: _creditsDisplay\.value/.test(CODE));
assert.ok(/credits_metering: _creditsMeter\.value/.test(CODE));

console.log('[smoke] health ambiguous-null: ALL PASS (credits, credits_metering and '
  + 'entitlementTiers each carry a state; pending is distinguished from failed; the '
  + 'values are unchanged for existing readers)');

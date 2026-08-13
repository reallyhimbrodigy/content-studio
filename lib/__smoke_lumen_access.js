'use strict';
// Gate for the Lumen access model [§2.1].
//
// §2.1 rejects full-default free Lumen on unit cost (~$1/render all-in) and
// makes any free generosity a METERED DIAL (default 0). So the failure that
// matters here is not "Lumen didn't run" — it is "Lumen ran when it shouldn't
// have", which spends real money per occurrence.
//
// Laws:
//   1. DEFAULTS ARE SAFE. Master flag off, free dial 0. Nothing turns premium
//      on by omission.
//   2. ENTITLEMENT, NOT THE PICKER. Absence of the client field is NOT a
//      decline — that dependency is one of the three gates that produced
//      0/2,074. Only an explicit `false` declines.
//   3. UNKNOWN IS NOT UNDER QUOTA. An unreadable count must never hand out a
//      ~$1 render. The confident-zero class costs money here, not credibility.
//   4. THE MONTH RIDES THE KEY, so the quota resets with no cron to forget.
//   5. THE NOTE IS THE USER'S, NOT OURS. Internal states (flag off, quota
//      unreadable) never surface as if they were the user's limit [§4.5/§4.6].

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('./lumen-access');

const ON = { PREMIUM_PIPELINE_ENABLED: '1' };

// ── LAW 1: safe by default
let c = A.config({});
assert.strictEqual(c.masterFlag, false, 'LAW 1: master flag must default OFF');
assert.strictEqual(c.freeRendersPerMonth, 0, 'LAW 1: §2.1 free dial defaults to 0');
assert.ok(c.paidRendersPerMonth > 0, 'paid quota must exist');
assert.strictEqual(A.decide({ isPro: true }).premium, false,
  'LAW 1: a Pro user must NOT get Lumen while the master flag is off');
assert.strictEqual(A.decide({ isPro: true }).reason, 'master_flag_off');

// ── LAW 2: entitlement, never the picker
const proOn = { isPro: true, usedThisMonth: 0, env: ON };
assert.strictEqual(A.decide(proOn).premium, true,
  'LAW 2: an entitled user with the flag on gets Lumen WITHOUT asking — the '
  + 'client-picker dependency is exactly what produced 0/2,074');
assert.strictEqual(A.decide(proOn).reason, 'entitled');
// absence of the field is not a decline
assert.strictEqual(A.decide({ ...proOn, clientDeclined: undefined }).premium, true);
// an explicit false IS honored
assert.strictEqual(A.decide({ ...proOn, clientDeclined: true }).premium, false);
assert.strictEqual(A.decide({ ...proOn, clientDeclined: true }).reason, 'client_declined');
// a free user never gets it while the dial is 0
assert.strictEqual(A.decide({ isPro: false, usedThisMonth: 0, env: ON }).premium, false);
assert.strictEqual(A.decide({ isPro: false, usedThisMonth: 0, env: ON }).reason, 'free_dial_zero');
// ...and DOES once the dial is turned up — generosity is a number someone set
assert.strictEqual(A.decide({
  isPro: false, usedThisMonth: 0, env: { ...ON, LUMEN_FREE_RENDERS_PER_MONTH: '2' },
}).premium, true, 'the metered dial must actually open when set');

// ── LAW 3: unknown is not under quota
for (const unknown of [null, undefined]) {
  const v = A.decide({ isPro: true, usedThisMonth: unknown, env: ON });
  assert.strictEqual(v.premium, false,
    'LAW 3: an unreadable quota must NOT hand out a ~$1 render');
  assert.strictEqual(v.reason, 'quota_unknown');
}
assert.strictEqual(A.decide({ isPro: true, usedThisMonth: 30, env: ON }).reason,
  'quota_exhausted', 'at quota must stop');
assert.strictEqual(A.decide({ isPro: true, usedThisMonth: 29, env: ON }).premium, true,
  'under quota must pass');

// global cap: 0 disables, positive enforces, unknown blocks
const capped = { ...ON, LUMEN_GLOBAL_DAILY_BUDGET_USD: '50' };
assert.strictEqual(A.decide({ isPro: true, usedThisMonth: 0, spentTodayUsd: 10, env: capped }).premium, true);
assert.strictEqual(A.decide({ isPro: true, usedThisMonth: 0, spentTodayUsd: 50, env: capped }).reason,
  'global_budget_exhausted');
assert.strictEqual(A.decide({ isPro: true, usedThisMonth: 0, spentTodayUsd: null, env: capped }).reason,
  'global_spend_unknown', 'an unreadable global spend must block, not fail open');
// with no cap configured, an unknown spend must NOT block the campaign
assert.strictEqual(A.decide({ isPro: true, usedThisMonth: 0, spentTodayUsd: null, env: ON }).premium, true);

// ── LAW 4: the month rides the key
const k1 = A.monthKey(new Date('2026-08-12T00:00:00Z'));
const k2 = A.monthKey(new Date('2026-09-01T00:00:00Z'));
assert.strictEqual(k1, 'lumen_render_2026_08');
assert.notStrictEqual(k1, k2, 'LAW 4: a new month must be a new key (free reset, no cron)');
assert.strictEqual(A.monthKey(new Date('2026-01-05T00:00:00Z')), 'lumen_render_2026_01',
  'single-digit months must zero-pad or September sorts before October');

// readMonthlyUsage keeps the three states apart
(async () => {
  assert.strictEqual(await A.readMonthlyUsage(null, 'u'), null, 'no client = UNKNOWN, not 0');
  const db = (res) => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => res }) }) }) }) });
  assert.strictEqual(await A.readMonthlyUsage(db({ data: null, error: null }), 'u'), 0,
    'no row = a genuine 0');
  assert.strictEqual(await A.readMonthlyUsage(db({ data: { count: 7 }, error: null }), 'u'), 7);
  assert.strictEqual(await A.readMonthlyUsage(db({ data: null, error: { message: 'missing table' } }), 'u'),
    null, 'a table error must read UNKNOWN — getFeatureUsageCount returns 0 here, which '
    + 'is exactly the conflation that would hand out unlimited $1 renders');

  // ── LAW 5: the note is the user's, never ours
  assert.strictEqual(A.withheldNote('quota_exhausted', { asked: false }), null,
    'no note when the user never wanted premium');
  const n = A.withheldNote('quota_exhausted', { asked: true });
  assert.ok(n && /premium edits this month/i.test(n));
  assert.ok(!/flag|quota_|null|undefined/i.test(n), 'never leak an internal reason code');
  for (const ours of ['master_flag_off', 'quota_unknown', 'global_spend_unknown']) {
    assert.strictEqual(A.withheldNote(ours, { asked: true }), null,
      `LAW 5: '${ours}' is OUR state — it must never surface as the user's limit`);
  }
  assert.ok(A.withheldNote('free_dial_zero', { asked: true }));
  assert.strictEqual(A.withheldNote('client_declined', { asked: true }), null,
    'they chose standard; narrating it back is chatter');

  // ── WIRING: server.js must route on the verdict, not the client field
  const sv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/lumen-access/.test(sv), 'server.js must use the access model');
  assert.ok(/premiumPipeline = lumenVerdict\.premium/.test(sv),
    'premium routing must come from the verdict');
  assert.ok(!/premiumPipeline =[^;]*body\?\.premium_pipeline_enabled === true/s.test(sv),
    'the CLIENT-PICKER dependency must be gone — it is one of the three gates that '
    + 'produced 0/2,074');
  assert.ok(/readMonthlyUsage/.test(sv),
    'server.js must use the unknown-safe reader, not getFeatureUsageCount');

  console.log('[smoke] lumen access: ALL PASS (safe defaults, entitlement not picker, '
    + 'unknown never under quota, monthly key resets free, internal states never shown '
    + 'to the user, server wired to the verdict)');
  process.exit(0);
})().catch((e) => { console.error('lumen-access smoke FAILED:', e && e.message); process.exit(1); });

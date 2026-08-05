'use strict';
// POSITIVE AND NEGATIVE CONTROLS ON EVERY MEASUREMENT (standing rule).
//
// Without the positive control, a monitor that reads nothing reports "0 missing"
// and looks green forever — which is precisely how a paywall bypass would hide.
// Without the negative, one that reports every row as missing also passes.
//
// The v512 revert is replayed verbatim below: four delivered completions, four
// distinct users, not one carrying a clean_export_key.

const assert = require('assert');
const { sweepExportIntegrity, MIN_SAMPLE } = require('./export-integrity-monitor');

const CUTOVER = '2026-08-04T22:30:00.000Z';
const NOW = Date.parse('2026-08-04T23:00:00.000Z');

function db(rows) {
  const q = {
    select: () => q, eq: () => q, gte: () => q, order: () => q,
    limit: async () => ({ data: rows, error: null }),
  };
  return { from: () => q };
}
const at = (iso, key, user, url = 'https://cdn/x-edited.mp4', playback = 'https://cdn/play.mp4') => ({
  id: `j-${iso}-${user}`, user_id: user, updated_at: iso,
  rendered_video_url: playback,
  result: { video_url: url, ...(key === undefined ? {} : { clean_export_key: key }) },
});

// ── NEGATIVE CONTROL: the real v512 rows. Must FAIL and must ALERT ──────────
const V512 = [
  at('2026-08-04T22:37:08Z', undefined, 'u1'),
  at('2026-08-04T22:38:08Z', undefined, 'u2'),
  at('2026-08-04T22:41:08Z', undefined, 'u3'),
  at('2026-08-04T22:42:08Z', undefined, 'u4'),
  at('2026-08-04T22:43:08Z', undefined, 'u5'),
];
(async () => {
  const alerts = [];
  const bad = await sweepExportIntegrity(db(V512), {
    sendAlert: async (a) => alerts.push(a), nowMs: NOW, cutoverIso: CUTOVER,
  });
  assert.strictEqual(bad.newRenders, 5, 'all five are post-cutover');
  assert.strictEqual(bad.missing, 5, 'NEGATIVE CONTROL FAILED — did not flag the v512 rows');
  assert.strictEqual(bad.missingUsers, 5, 'Rule 7: five distinct users');
  assert.strictEqual(bad.rate, 1);
  assert.strictEqual(bad.armable, false, 'must NOT be armable while keys are missing');
  assert.strictEqual(alerts.length, 1, 'a total bypass must ALERT, not just log');
  assert.ok(/free/i.test(alerts[0].body), 'the alert must say what it costs');

  // ── POSITIVE CONTROL: healthy traffic. Must PASS, must NOT alert ──────────
  const good = [];
  for (let i = 0; i < 6; i += 1) {
    good.push(at(`2026-08-04T22:4${i}:00Z`, `exports/j${i}/clean.mp4`, `u${i}`));
  }
  const okAlerts = [];
  const ok = await sweepExportIntegrity(db(good), {
    sendAlert: async (a) => okAlerts.push(a), nowMs: NOW, cutoverIso: CUTOVER,
  });
  assert.strictEqual(ok.missing, 0, 'POSITIVE CONTROL FAILED — flagged healthy rows');
  assert.strictEqual(ok.armable, true, 'clean traffic above the sample floor is armable');
  assert.strictEqual(okAlerts.length, 0, 'must not cry wolf on healthy traffic');

  // ── OLD JOBS are legitimately NULL and must not be counted (Rule 5) ───────
  const mixed = good.concat([
    at('2026-08-04T21:00:00Z', undefined, 'old1'),
    at('2026-08-04T20:00:00Z', undefined, 'old2'),
  ]);
  const m = await sweepExportIntegrity(db(mixed), { nowMs: NOW, cutoverIso: CUTOVER, windowMin: 240 });
  assert.strictEqual(m.missing, 0, 'pre-cutover NULLs are old jobs, not defects');
  assert.strictEqual(m.delivered, 8);
  assert.strictEqual(m.newRenders, 6, 'the cohort cut must exclude the two old jobs');

  // ── an UNCUT cohort must say so rather than report a fake rate ────────────
  const uncut = await sweepExportIntegrity(db(mixed), { nowMs: NOW, cutoverIso: null });
  assert.strictEqual(uncut.armable, false, 'nothing is armable without a stated cutover');
  assert.ok(/UNCUT/.test(uncut.reason), 'must say the cohort is uncut');

  // ── SMALL SAMPLE must refuse to claim a rate (Rule 5) ─────────────────────
  const tiny = await sweepExportIntegrity(db([at('2026-08-04T22:50:00Z', undefined, 'u1')]), {
    sendAlert: async () => assert.fail('must not alert on n=1'),
    nowMs: NOW, cutoverIso: CUTOVER,
  });
  assert.strictEqual(tiny.sampleTooSmall, true);
  assert.strictEqual(tiny.armable, false, 'n below the floor is NOT proof of zero');
  assert.ok(tiny.reason.includes(`< ${MIN_SAMPLE}`));

  // ── a completion that delivered nothing cannot bypass an export ───────────
  const nodeliver = await sweepExportIntegrity(
    db(good.concat([{ id: 'z', user_id: 'uz', updated_at: '2026-08-04T22:55:00Z', result: {} }])),
    { nowMs: NOW, cutoverIso: CUTOVER },
  );
  assert.strictEqual(nodeliver.missing, 0, 'no video_url delivered => no export to bypass');

  // ── NEVER-NULL PLAYBACK: outranks the leak, pages unconditionally ────────
  // A NULL rendered_video_url means a user cannot watch their own video. It must
  // page with NO cutover and NO sample floor — there is no rate at which one
  // user locked out of their own render becomes acceptable.
  const dark = [at('2026-08-04T22:50:00Z', 'exports/j/clean.mp4', 'u9', undefined, null)];
  const darkAlerts = [];
  const d = await sweepExportIntegrity(db(dark), {
    sendAlert: async (a) => darkAlerts.push(a), nowMs: NOW, cutoverIso: CUTOVER,
  });
  assert.strictEqual(d.nullPlayback, 1, 'NEGATIVE CONTROL FAILED — missed a NULL playback URL');
  assert.strictEqual(d.nullPlaybackUsers, 1);
  assert.strictEqual(darkAlerts.length, 1, 'a NULL playback URL must page even at n=1');
  assert.ok(/cannot|watch|play/i.test(darkAlerts[0].title + darkAlerts[0].body),
    'the page must say the user cannot watch their video');
  // and with NO cutover set at all — the sample floor must not suppress it
  const d2 = await sweepExportIntegrity(db(dark), {
    sendAlert: async () => {}, nowMs: NOW, cutoverIso: null,
  });
  assert.strictEqual(d2.nullPlayback, 1, 'the NULL check must not depend on a cutover');

  // POSITIVE CONTROL: populated playback URLs must stay silent
  const okPlayback = await sweepExportIntegrity(db(good), {
    sendAlert: async () => assert.fail('must not page when playback URLs are populated'),
    nowMs: NOW, cutoverIso: CUTOVER,
  });
  assert.strictEqual(okPlayback.nullPlayback, 0, 'POSITIVE CONTROL FAILED');

  console.log('[smoke] export integrity: ALL PASS (flags the real v512 rows + alerts; '
    + 'clean traffic silent; old jobs excluded; uncut cohort refused; n<5 claims nothing; '
    + 'NULL playback pages unconditionally)');
})().catch((e) => { console.error(e); process.exit(1); });

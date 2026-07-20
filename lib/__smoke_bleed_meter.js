'use strict';
// Real-path smoke for the bleed meter: drives computeBleedDigest + formatDigest
// through a mock supabaseAdmin with synthetic jobs, asserting the exclusion
// hygiene (internal + test-prefix dropped), the designed-vs-real split, the
// compute-second/cost math, and the 5-line format. Exercises the ACTIVE path,
// not a default no-op.

const assert = require('assert');
const bm = require('./bleed-meter');

// --- mock supabaseAdmin: a chainable builder that resolves per table ---------
function mockDb({ internalIds, jobs, commerce }) {
  function builder(table) {
    const state = { table };
    const b = {
      select() { return b; },
      or() { return b; },
      eq() { return b; },
      in() { return b; },
      gte() { return b; },
      lt() { return b; },
      order() { return b; },
      limit() { return b; },
      range(from) { state.from = from; return b; },
      insert() { return Promise.resolve({ data: null, error: null }); },
      then(resolve) {
        if (table === 'profiles') {
          return resolve({ data: internalIds.map((id) => ({ id })), error: null });
        }
        if (table === 'video_jobs') {
          // single page (from=0) returns all; subsequent pages empty
          return resolve({ data: state.from === 0 ? jobs : [], error: null });
        }
        if (table === 'analytics_events') {
          return resolve({ data: commerce || [], error: null });
        }
        return resolve({ data: [], error: null });
      },
    };
    return b;
  }
  return { from: (t) => builder(t) };
}

(async () => {
  const sinceISO = '2026-07-17T00:00:00.000Z';
  const untilISO = '2026-07-18T00:00:00.000Z';
  const t0 = '2026-07-17T10:00:00.000Z';
  const t120 = '2026-07-17T10:02:00.000Z'; // +120s
  const t60 = '2026-07-17T10:01:00.000Z';  // +60s

  const jobs = [
    // 2 real completions (120s each)
    { id: 'aaa', status: 'completed', user_id: 'u1', created_at: t0, started_at: t0, completed_at: t120, updated_at: t120, result: { rendered_video_url: 'x' } },
    { id: 'bbb', status: 'completed', user_id: 'u2', created_at: t0, started_at: t0, completed_at: t120, updated_at: t120, result: {} },
    // designed rejection (no speech) — 60s
    { id: 'ccc', status: 'failed', user_id: 'u3', created_at: t0, started_at: t0, completed_at: t60, updated_at: t60, result: { error_code: 'NO_SPEECH' } },
    // designed rejection (too short) via error_message code — 60s
    { id: 'ddd', status: 'failed', user_id: 'u4', created_at: t0, started_at: t0, completed_at: t60, updated_at: t60, error_message: 'rejected CLIP_TOO_SHORT: under 5s' },
    // REAL error with a code — 120s
    { id: 'eee', status: 'failed', user_id: 'u5', created_at: t0, started_at: t0, completed_at: t120, updated_at: t120, result: { error_code: 'RENDER_FATAL' } },
    // REAL error, no extractable code (uncoded) — 60s
    { id: 'fff', status: 'failed', user_id: 'u6', created_at: t0, started_at: t0, completed_at: t60, updated_at: t60, error_message: 'boom' },
    // in-flight at snapshot
    { id: 'ggg', status: 'processing', user_id: 'u7', created_at: t0, started_at: t0, updated_at: t60 },
    // EXCLUDED: internal account
    { id: 'hhh', status: 'completed', user_id: 'internal-1', created_at: t0, started_at: t0, completed_at: t120, updated_at: t120, result: {} },
    // EXCLUDED: test-prefixed job id
    { id: 'e2e-flag-check-1', status: 'failed', user_id: 'u8', created_at: t0, started_at: t0, completed_at: t60, updated_at: t60, result: { error_code: 'NO_SPEECH' } },
  ];

  const db = mockDb({ internalIds: ['internal-1'], jobs, commerce: [] });
  const d = await bm.computeBleedDigest(db, { sinceISO, untilISO });

  // --- assertions: exclusion hygiene ---
  assert.strictEqual(d.excludedInternal, 1, 'internal excluded');
  assert.strictEqual(d.excludedTest, 1, 'test-prefix excluded');
  assert.strictEqual(d.total, 7, 'only real user jobs counted');

  // --- bucket split ---
  assert.strictEqual(d.completions, 2, 'completions');
  assert.strictEqual(d.designedRejections, 2, 'designed (NO_SPEECH + CLIP_TOO_SHORT)');
  assert.strictEqual(d.realErrors, 2, 'real errors (RENDER_FATAL + UNCODED)');
  assert.strictEqual(d.inFlight, 1, 'in-flight');
  assert.strictEqual(d.designedBreakdown.NO_SPEECH, 1);
  assert.strictEqual(d.designedBreakdown.CLIP_TOO_SHORT, 1);
  assert.strictEqual(d.errorBreakdown.RENDER_FATAL, 1);
  assert.strictEqual(d.errorBreakdown.UNCODED, 1);

  // --- cost math: completions 2*120 + failures (60+60+120+60) + in-flight 60
  //     = 240 + 300 + 60 = 600 compute-seconds (in-flight IS burning compute) ---
  assert.strictEqual(Math.round(d.computeSeconds), 600, 'compute seconds');
  const expectUsd = 600 * bm.RATE_PER_SEC;
  assert.ok(Math.abs(d.estUsd - expectUsd) < 1e-9, 'usd matches rate*seconds');
  assert.ok(d.estUsd > 0, 'nonzero cost');

  // --- format: 5 content lines + title ---
  const { title, body } = bm.formatDigest(d, null);
  const lines = body.split('\n');
  assert.ok(title.startsWith('[REPORT] Bleed meter · 2026-07-18'), 'title/date');
  assert.ok(lines[0].includes('Completions: 2'), 'line1');
  assert.ok(lines[1].includes('Rejections: 2'), 'line2');
  assert.ok(lines[2].includes('Errors: 2') && lines[2].includes('1 in-flight'), 'line3');
  assert.ok(lines[3].includes('Degen:') && lines[3].includes('0 ballooned'), 'line4 degen placeholder');
  assert.ok(lines[4].includes('Languages:') && lines[4].includes('English only'), 'line5 languages placeholder');
  assert.ok(lines[5].includes('Est. Modal: $') && lines[5].includes('/h)'), 'line6 cost');
  assert.ok(lines[6].includes('awaiting iOS event ship'), 'line7 commerce placeholder');
  assert.ok(body.includes('excl 1 internal · 1 test'), 'exclusion footnote');

  // --- commerce line populated when events present ---
  const dbC = mockDb({ internalIds: [], jobs: [], commerce: [
    { event: 'paywall_view' }, { event: 'paywall_view' }, { event: 'trial_start' },
  ] });
  const d2 = await bm.computeBleedDigest(dbC, { sinceISO, untilISO });
  const { body: body2 } = bm.formatDigest(d2, 'paywalls 2 · attempts 0 · trials 1 · errors 0');
  assert.ok(body2.includes('paywalls 2') && body2.includes('trials 1'), 'commerce line');

  // --- languages line populated when non-English renders present ---
  const { body: body3 } = bm.formatDigest(d2, null, null, 'Arabic:3(T1) · Thai:1(T2)  [1 Tier-2 watch]');
  assert.ok(body3.includes('Arabic:3(T1)') && body3.includes('Tier-2 watch'), 'languages line');

  console.log('SMOKE OK — digest:\n' + title + '\n' + body);
})().catch((e) => { console.error('SMOKE FAIL:', e.message); process.exit(1); });

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
    // THE FILTERS ARE APPLIED, as Postgres applies them (2026-09-10).
    // eq/in/gte/lt each discarded their arguments, so this fake returned its
    // whole fixture for any query. Verified by mutation against bleed-meter.js:
    // moving the window's lower bound to 2020, pointing the commerce read at an
    // event that does not exist, and counting renders from FAILED rows instead
    // of completed ALL stayed GREEN. This is a SPEND reader — that is the
    // empty-read failure wearing a plausible number instead of a zero, which is
    // strictly harder to notice than a suspicious 0.
    const preds = [];
    const b = {
      select() { return b; },
      // `or` carries a raw PostgREST expression; it scopes the INTERNAL-ids read
      // and is recorded but not evaluated here. Left deliberately unapplied and
      // said out loud rather than quietly no-op'd.
      or(expr) { state.or = expr; return b; },
      eq(col, val) { preds.push((r) => r[col] === val); return b; },
      in(col, vals) { preds.push((r) => Array.isArray(vals) && vals.includes(r[col])); return b; },
      gte(col, val) { preds.push((r) => r[col] !== undefined && r[col] >= val); return b; },
      lt(col, val) { preds.push((r) => r[col] !== undefined && r[col] < val); return b; },
      order() { return b; },
      limit() { return b; },
      range(from) { state.from = from; return b; },
      insert() { return Promise.resolve({ data: null, error: null }); },
      then(resolve) {
        if (table === 'profiles') {
          return resolve({ data: internalIds.map((id) => ({ id })), error: null });
        }
        const scoped = (rows) => (rows || []).filter((r) => preds.every((p) => p(r)));
        if (table === 'video_jobs') {
          // single page (from=0) returns all; subsequent pages empty
          return resolve({ data: state.from === 0 ? scoped(jobs) : [], error: null });
        }
        if (table === 'analytics_events') {
          return resolve({ data: scoped(commerce), error: null });
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
    // A CANCEL IS TERMINAL, NOT IN-FLIGHT and NOT AN ERROR. It fell to the
    // else-branch and was reported as still running (2026-08-04).
    { id: 'ggg', status: 'canceled', user_id: 'u9', created_at: t0, started_at: t0, updated_at: t60 },
    // in-flight at snapshot
    { id: 'ggg', status: 'processing', user_id: 'u7', created_at: t0, started_at: t0, updated_at: t60 },
    // EXCLUDED: internal account
    { id: 'hhh', status: 'completed', user_id: 'internal-1', created_at: t0, started_at: t0, completed_at: t120, updated_at: t120, result: {} },
    // EXCLUDED: test-prefixed job id
    { id: 'e2e-flag-check-1', status: 'failed', user_id: 'u8', created_at: t0, started_at: t0, completed_at: t60, updated_at: t60, result: { error_code: 'NO_SPEECH' } },

    // ── DECOYS: rows the WINDOW must exclude ─────────────────────────────────
    // Every fixture above sits inside [sinceISO, untilISO), so widening the
    // window could not change the answer and the window filters were untestable
    // no matter how faithfully the mock applied them. These two sit outside it.
    // A meter that reports the wrong PERIOD is the empty-read failure with a
    // plausible number instead of a zero — strictly harder to notice.
    { id: 'old-1', status: 'completed', user_id: 'u20', created_at: '2025-01-01T00:00:00.000Z',
      started_at: '2025-01-01T00:00:00.000Z', completed_at: '2025-01-01T00:02:00.000Z',
      updated_at: '2025-01-01T00:02:00.000Z', result: { rendered_video_url: 'x' } },
    { id: 'future-1', status: 'completed', user_id: 'u21', created_at: '2027-01-01T00:00:00.000Z',
      started_at: '2027-01-01T00:00:00.000Z', completed_at: '2027-01-01T00:02:00.000Z',
      updated_at: '2027-01-01T00:02:00.000Z', result: { rendered_video_url: 'x' } },
  ];

  // A non-commerce event in the store: if the `.in('event', COMMERCE_EVENTS)`
  // filter stops naming the real events, this row is what makes the difference
  // visible instead of both readings being an empty list.
  const db = mockDb({
    internalIds: ['internal-1'],
    jobs,
    commerce: [{ event: 'render_started', created_at: t0, props: {} }],
  });
  const d = await bm.computeBleedDigest(db, { sinceISO, untilISO });

  // --- assertions: exclusion hygiene ---
  assert.strictEqual(d.excludedInternal, 1, 'internal excluded');
  assert.strictEqual(d.excludedTest, 1, 'test-prefix excluded');
  assert.strictEqual(d.total, 8, 'only real user jobs counted');

  // --- bucket split ---
  assert.strictEqual(d.completions, 2, 'completions');
  assert.strictEqual(d.designedRejections, 2, 'designed (NO_SPEECH + CLIP_TOO_SHORT)');
  assert.strictEqual(d.realErrors, 2, 'real errors (RENDER_FATAL + UNCODED)');
  assert.strictEqual(d.inFlight, 1,
    'in-flight must NOT absorb the cancel — a cancelled job is terminal, and '
    + 'counting it as still running reported work the user had abandoned');
  assert.strictEqual(d.canceled, 1,
    'a cancel gets its OWN bucket: not an error (the user chose it, it is '
    + 'refunded, it carries no result by design) and not in-flight');
  assert.strictEqual(d.realErrors, 2,
    'the cancel must not have leaked into the error count either');
  assert.strictEqual(d.designedBreakdown.NO_SPEECH, 1);
  assert.strictEqual(d.designedBreakdown.CLIP_TOO_SHORT, 1);
  assert.strictEqual(d.errorBreakdown.RENDER_FATAL, 1);
  assert.strictEqual(d.errorBreakdown.UNCODED, 1);

  // --- cost math: completions 2*120 + failures (60+60+120+60) + in-flight 60
  //     = 240 + 300 + 60 = 600, plus the 60s cancel = 660 compute-seconds.
  //     A CANCEL STILL BURNED COMPUTE — it is excluded from errors and from
  //     in-flight, but NOT from the bill. That is the whole point of the meter.
  assert.strictEqual(Math.round(d.computeSeconds), 660, 'compute seconds');
  const expectUsd = 660 * bm.RATE_PER_SEC;
  assert.ok(Math.abs(d.estUsd - expectUsd) < 1e-9, 'usd matches rate*seconds');
  assert.ok(d.estUsd > 0, 'nonzero cost');

  // --- format: 5 content lines + title ---
  const { title, body } = bm.formatDigest(d, null);
  const lines = body.split('\n');
  // Owner-alert title law (2026-07-24): operator pushes carry "[Promptly]" —
  // the [REPORT] grep tag lives on the log line, not the push title.
  assert.ok(title.startsWith('[Promptly] Bleed meter · 2026-07-18'), 'title/date');
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
    // created_at added 2026-09-10: the mock now applies the window, and a row
    // with no timestamp would be silently dropped by it rather than by intent.
    { event: 'paywall_view', created_at: t0 }, { event: 'paywall_view', created_at: t0 },
    { event: 'trial_start', created_at: t0 },
  ] });
  const d2 = await bm.computeBleedDigest(dbC, { sinceISO, untilISO });
  const { body: body2 } = bm.formatDigest(d2, 'paywalls 2 · attempts 0 · trials 1 · errors 0');
  assert.ok(body2.includes('paywalls 2') && body2.includes('trials 1'), 'commerce line');
  // NOT COVERED, and said out loud rather than left to look covered: the string
  // above is PASSED IN to formatDigest, not derived from dbC. So nothing here
  // depends on `.in('event', COMMERCE_EVENTS)` naming the right events —
  // mutating it to a nonexistent event stays green. Same for the three
  // `.eq('status','completed')` reads behind the Lumen, Tier and push lines:
  // no fixture drives them with data, so all three render '—' either way and
  // flipping the status filter to 'failed' changes nothing observable. Both are
  // fixture gaps, not mock gaps — the mock applies every filter it is given now.
  // The window filters ARE covered: see the out-of-window decoys above.

  // --- languages line populated when non-English renders present ---
  const { body: body3 } = bm.formatDigest(d2, null, null, 'Arabic:3(T1) · Thai:1(T2)  [1 Tier-2 watch]');
  assert.ok(body3.includes('Arabic:3(T1)') && body3.includes('Tier-2 watch'), 'languages line');

  console.log('SMOKE OK — digest:\n' + title + '\n' + body);
})().catch((e) => { console.error('SMOKE FAIL:', e.message); process.exit(1); });

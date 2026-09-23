#!/usr/bin/env node
'use strict';
// The generation and batch contract, sections 1-6. One definition, one shape.
const assert = require('assert');
const g = require('./generation-quotes');

let n = 0;
const failed = [];
// A FAILURE MUST CARRY ITS NAME. The previous helper let the assertion throw,
// so a red run printed a stack trace and the leg that failed appeared nowhere
// in the output — which makes the next run the debugger, and makes it
// impossible for a red proof to assert WHICH leg it turned red. Every leg now
// runs, and the names of the ones that failed are the last thing printed.
const leg = (name, fn) => {
  try { fn(); n += 1; console.log(`   ok  ${name}`); }
  catch (e) { failed.push(name); console.log(`   FAIL  ${name}: ${e.message}`); }
};

// L1 THE PRICE COMES FROM THE TABLE, NOT A FLAT NUMBER. The defect this
// replaces: a flat 20 credits for any generated video, which is UNDER cost on
// 7 of 11 model x resolution rows and 5.8x under at Seedance 2.5 1080p.
leg('L1 price_varies_by_model_and_resolution', () => {
  const lo = g.priceFor({ kind: 'ai_video', model: 'Seedance 2.0 Fast', resolution: '480p', duration_s: 5 });
  const hi = g.priceFor({ kind: 'ai_video', model: 'Seedance 2.5', resolution: '1080p', duration_s: 5 });
  assert.ok(lo.credits > 0 && hi.credits > 0);
  assert.ok(hi.credits / lo.credits >= 5, `expected a wide spread, got ${lo.credits}..${hi.credits}`);
});

// L2 THE LABEL AND THE CREDITS COME FROM THE SAME ROW. The client never
// builds the label, so a label that disagreed with the charge would be a
// price the user read and a different price we took.
leg('L2 label_and_credits_from_one_row', () => {
  const q = g.quoteCard({ quote_id: 'q', kind: 'ai_video', model: 'Seedance 2.0',
    resolution: '720p', duration_s: 5, balance: 100, now: 0 });
  const p = g.priceFor({ kind: 'ai_video', model: 'Seedance 2.0', resolution: '720p', duration_s: 5 });
  assert.strictEqual(q.credits, p.credits);
  assert.strictEqual(q.label, p.label);
  assert.ok(/\d+s$/.test(q.label), `label should carry the duration: ${q.label}`);
});

// L3 AN UNPRICED FEATURE REFUSES — it never returns a guessed number.
leg('L3 unpriced_refuses_rather_than_guesses', () => {
  const r = g.priceFor({ kind: 'ai_video', model: 'AI Avatar', resolution: '1080p', duration_s: 5 });
  assert.strictEqual(r.credits, undefined);
  assert.ok(r.error, 'an unpriced row must carry an error, not a price');
});

// L4 ONE 402 SHAPE, AND `reason` ALONE DECIDES THE CARD. Nothing parsed from
// prose, and every field the client reads is present on every reason.
leg('L4 one_402_shape_for_every_reason', () => {
  for (const reason of ['insufficient_credits', 'pro_required', 'daily_cap']) {
    const e = g.paymentRequired(reason, { needed: 45, balance: 20 });
    assert.strictEqual(e.error, 'payment_required');
    assert.strictEqual(e.reason, reason);
    for (const k of ['needed', 'balance', 'shortfall', 'actions']) {
      assert.ok(k in e, `${reason} is missing ${k}`);
    }
    assert.ok(Array.isArray(e.actions) && e.actions.length > 0);
  }
  assert.deepStrictEqual(
    g.paymentRequired('pro_required', { needed: 1, balance: 0 }).actions, ['upgrade']);
});

// L5 SHORTFALL IS NEVER NEGATIVE. A negative shortfall renders as "you are
// -25 short", which is the arithmetic saying the model is wrong.
leg('L5 shortfall_never_negative', () => {
  const e = g.paymentRequired('insufficient_credits', { needed: 10, balance: 100 });
  assert.strictEqual(e.shortfall, 0);
});

// L6 AN EXPIRED QUOTE IS REFUSED. Ten minutes, and the boundary is refused
// rather than admitted — a quote expiring exactly now is a quote whose price
// may already have moved.
leg('L6 expired_quote_is_refused', () => {
  const q = g.quoteCard({ quote_id: 'q', kind: 'ai_video', model: 'Seedance 2.0',
    resolution: '720p', duration_s: 5, balance: 100, now: 0 });
  assert.strictEqual(g.isExpired(q.expires_at, 0), false);
  assert.strictEqual(g.isExpired(q.expires_at, g.QUOTE_TTL_MS - 1), false);
  assert.strictEqual(g.isExpired(q.expires_at, g.QUOTE_TTL_MS), true, 'the boundary must expire');
  assert.strictEqual(g.isExpired(q.expires_at, g.QUOTE_TTL_MS + 1), true);
});

// L7 THE BATCH IS ALL OR NOTHING, and the shortfall is stated in the same
// breath as what IS affordable. No partial sends, ever.
leg('L7 batch_is_all_or_nothing_with_a_stated_shortfall', () => {
  const b = g.batchQuote({ batch_quote_id: 'b', clip_ids: Array(10).fill('c'),
    kind: 'ai_video', model: 'Seedance 2.0', resolution: '720p', duration_s: 5,
    balance: 45, now: 0 });
  assert.strictEqual(b.count, 10);
  assert.strictEqual(b.credits_total, b.credits_each * 10);
  assert.strictEqual(b.affordable_count, Math.floor(45 / b.credits_each));
  assert.strictEqual(b.shortfall, b.credits_total - 45);
  assert.ok(b.affordable_count < b.count, 'this fixture must be a shortfall case');
});

// L7b NO PARTIAL SENDS, EVER — and nothing tested this until a mutation
// walked straight past L7. L7 checks the QUOTE shape; the all-or-nothing rule
// lives in CONFIRM, and "dispatch what we can afford" is exactly the helpful-
// looking change someone makes on a Friday. It must refuse and dispatch zero.
leg('L7b confirm_dispatches_all_or_nothing', () => {
  const short = g.batchConfirm({ count: 10, credits_each: 10, balance: 45,
    tier: 'paid', used_today: 0 });
  assert.strictEqual(short.error, 'payment_required');
  assert.strictEqual(short.reason, 'insufficient_credits');
  assert.strictEqual(short.dispatch, undefined, 'a refused batch dispatches NOTHING');
  assert.strictEqual(short.ok, undefined);
  assert.strictEqual(short.shortfall, 100 - 45);
  const fine = g.batchConfirm({ count: 4, credits_each: 10, balance: 45,
    tier: 'paid', used_today: 0 });
  assert.strictEqual(fine.ok, true);
  assert.strictEqual(fine.dispatch, 4, 'the user asking for 4 gets exactly 4');
  assert.strictEqual(fine.reserve, 40);
});

// L8 THE BATCH CAP IS TEN, enforced on the BATCH. Ten single requests and one
// batch of ten are the same day's generation; only a whole-batch check sees
// the second.
leg('L8 batch_cap_and_daily_cap_on_the_whole_batch', () => {
  const tooMany = g.batchQuote({ batch_quote_id: 'b', clip_ids: Array(11).fill('c'),
    kind: 'ai_video', model: 'Seedance 2.0', resolution: '720p', duration_s: 5, balance: 1e9, now: 0 });
  assert.strictEqual(tooMany.error, 'too_many');
  const capped = g.batchConfirm({ count: 10, credits_each: 10, balance: 1e9,
    tier: 'paid', used_today: 5 });
  assert.strictEqual(capped.reason, 'daily_cap', 'used 5 + 10 exceeds the Pro cap of 10');
  const ok = g.batchConfirm({ count: 5, credits_each: 10, balance: 1e9, tier: 'paid', used_today: 5 });
  assert.strictEqual(ok.ok, true);
});

// L9 A FREE TIER GETS pro_required FROM THE BATCH PATH TOO. A loophole that
// only closes on one endpoint is not closed.
leg('L9 free_tier_batch_is_pro_required', () => {
  for (const tier of ['free', 'trial', '', null, undefined]) {
    const r = g.batchConfirm({ count: 1, credits_each: 10, balance: 1e9, tier, used_today: 0 });
    assert.strictEqual(r.reason, 'pro_required', `tier ${JSON.stringify(tier)} must be refused`);
  }
});

// L10 ETA IS NULL BELOW 20 SAMPLES. A median of three is a number that looks
// like knowledge and is not; the client shows the position only.
leg('L10 eta_is_null_below_twenty_samples', () => {
  const few = g.queueFields({ queue_position: 3, recent_durations_s: [30, 40, 50] });
  assert.strictEqual(few.eta_seconds, null);
  assert.strictEqual(few.queue_position, 3);
  const many = g.queueFields({ queue_position: 2,
    recent_durations_s: Array.from({ length: 20 }, () => 60) });
  assert.strictEqual(typeof many.eta_seconds, 'number');
  assert.ok(many.eta_seconds > 0);
  const none = g.queueFields({ queue_position: 1, recent_durations_s: [] });
  assert.strictEqual(none.eta_seconds, null, 'no samples is null, never 0');
});

// ── RULED 2026-09-23 ──────────────────────────────────────────────────────

// L11 EVERY JOB COMES BACK PAIRED WITH ITS CLIP. Revised from `job_ids` in
// clip order on 2026-09-23: order is an invisible contract, and a client that
// INFERS the pairing produces a healthy-looking batch when the inference is
// wrong. The fixture hands the jobs back in a DIFFERENT order from the clips
// on purpose — if both agreed, this leg would pass whether or not anything
// paired, which is a check passing for a reason other than the one it claims.
leg('L11 batch_returns_job_clip_pairs', () => {
  const clip_ids = ['c1', 'c2', 'c3', 'c4'];
  const jobs = [                       // row order, deliberately shuffled
    { clip_id: 'c3', job_id: 'j-three' },
    { clip_id: 'c1', job_id: 'j-one' },
    { clip_id: 'c4', job_id: 'j-four' },
    { clip_id: 'c2', job_id: 'j-two' },
  ];
  const r = g.batchResponse({ clip_ids, jobs, balance: 77 });
  assert.strictEqual(r.job_ids, undefined, 'the bare array shape is retired');
  assert.deepStrictEqual(r.jobs, [
    { job_id: 'j-one', clip_id: 'c1' },
    { job_id: 'j-two', clip_id: 'c2' },
    { job_id: 'j-three', clip_id: 'c3' },
    { job_id: 'j-four', clip_id: 'c4' },
  ], 'every job must name its own clip');
  assert.strictEqual(r.balance, 77);
  // the guard that makes the leg mean something: the input really was in a
  // different order, so a pass-through implementation would fail it.
  assert.notDeepStrictEqual(jobs.map((j) => j.job_id), r.jobs.map((j) => j.job_id));
  // and every pair is genuinely the caller's clip, not an index that happened
  // to line up — the whole reason the shape changed.
  for (const pair of r.jobs) {
    assert.ok(clip_ids.includes(pair.clip_id));
    assert.ok(jobs.find((j) => j.clip_id === pair.clip_id).job_id === pair.job_id);
  }
});

// L12 A CLIP WITH NO JOB IS A MISSING PAIR, NOT A SHORTER ARRAY. Under the
// retired shape a short array re-aligned every index after the gap; under this
// one it would quietly omit a clip the user was charged for. Both are refused.
leg('L12 batch_missing_pair_refuses_rather_than_shortens', () => {
  const r = g.batchResponse({
    clip_ids: ['c1', 'c2', 'c3'],
    jobs: [{ clip_id: 'c1', job_id: 'j1' }, { clip_id: 'c3', job_id: 'j3' }],
    balance: 10,
  });
  assert.strictEqual(r.error, 'dispatch_incomplete');
  assert.deepStrictEqual(r.missing, ['c2']);
  assert.strictEqual(r.jobs, undefined, 'a partial batch must carry NO jobs');
  const dup = g.batchResponse({
    clip_ids: ['c1'], jobs: [{ clip_id: 'c1', job_id: 'a' }, { clip_id: 'c1', job_id: 'b' }],
    balance: 1 });
  assert.strictEqual(dup.error, 'duplicate_job');
});

// L13 THE HEADER *IS* THE upload_key. Absent is refused; disagreeing is
// refused rather than resolved — picking a winner is how two names for one
// value drift, and both spellings are well-formed keys.
leg('L13 idempotency_key_is_the_upload_key', () => {
  assert.strictEqual(g.pickedKey({ header: '', upload_key: 'u1' }).error,
    'idempotency_key_required');
  assert.strictEqual(g.pickedKey({ header: undefined, upload_key: 'u1' }).error,
    'idempotency_key_required');
  assert.strictEqual(g.pickedKey({ header: 'u1', upload_key: 'u2' }).error,
    'idempotency_key_mismatch');
  assert.strictEqual(g.pickedKey({ header: ' u1 ', upload_key: 'u1' }).key, 'u1');
  assert.strictEqual(g.pickedKey({ header: 'u1' }).key, 'u1');
});

// L14 THE SAME KEY WITHIN 30 MINUTES: SAME clip_id, 200, NO SECOND IMPORT.
// The clip_id is the caller's because the UNIQUE constraint returned the
// existing row; what this decides is whether an import fires a second time.
leg('L14 same_key_within_the_window_starts_no_second_import', () => {
  const t0 = 1000000;
  const first = g.pickedClipDecision({ inserted: true, created_at: new Date(t0).toISOString(), now: t0 });
  assert.strictEqual(first.status, 'created');
  assert.strictEqual(first.start_import, true);

  for (const dt of [0, 1000, 29 * 60 * 1000, g.PICK_TTL_MS]) {
    const again = g.pickedClipDecision({
      inserted: false, created_at: new Date(t0).toISOString(), now: t0 + dt });
    assert.strictEqual(again.start_import, false, `+${dt}ms must not re-import`);
    assert.strictEqual(again.status, 'reused');
  }
  // A used clip is a real clip in a project: never imported again, at any age.
  const used = g.pickedClipDecision({ inserted: false, used_at: new Date(t0).toISOString(),
    created_at: new Date(t0).toISOString(), now: t0 + 86400000 });
  assert.strictEqual(used.start_import, false);
});

// L15 200 IN EVERY CASE. A 201-for-new / 200-for-existing split makes a retry
// after a dropped response look different from the original, which is the one
// thing an idempotent endpoint exists to prevent.
leg('L15 every_outcome_is_200', () => {
  const t0 = 1000000;
  const cases = [
    g.pickedClipDecision({ inserted: true, created_at: new Date(t0).toISOString(), now: t0 }),
    g.pickedClipDecision({ inserted: false, created_at: new Date(t0).toISOString(), now: t0 + 60000 }),
    g.pickedClipDecision({ inserted: false, created_at: new Date(t0).toISOString(),
      now: t0 + g.PICK_TTL_MS + 1 }),
  ];
  for (const c of cases) assert.strictEqual(c.http, 200, JSON.stringify(c));
  assert.deepStrictEqual(cases.map((c) => c.status), ['created', 'reused', 'refreshed']);
});

// L16 AN UNREADABLE created_at REFUSES. Absent is not zero and not infinity:
// silently fresh never re-imports a dead upload, silently stale imports twice,
// and a missing timestamp is indistinguishable from either once it is a number.
leg('L16 unreadable_created_at_fails_loudly', () => {
  for (const bad of [undefined, null, '', 'not-a-date']) {
    const r = g.pickedClipDecision({ inserted: false, created_at: bad, now: 1000000 });
    assert.strictEqual(r.error, 'unreadable_created_at', `${JSON.stringify(bad)} must refuse`);
    assert.strictEqual(r.start_import, undefined);
  }
});

// ── THE CRASH MATRIX (2026-09-23) ────────────────────────────────────────

// L17 (a) DIED AFTER THE CLAIM, BEFORE THE DEDUCT. The retry must not hang
// waiting for a "first result" that was never produced — the claim is already
// ours, which is what a claim is for, so the retry resumes at the charge.
leg('L17 crash_a_claimed_uncharged_resumes_at_the_charge', () => {
  const r = g.recoverQuote({ state: 'claimed', charged_at: null, job_id: null });
  assert.strictEqual(r.action, 'charge');
  // AND IT IGNORES EXPIRY ON PURPOSE. The price was fixed when the claim won;
  // re-pricing a quote the user already confirmed moves the number under them.
  const expired = g.recoverQuote({ state: 'claimed', charged_at: null, job_id: null,
    expires_at: new Date(0).toISOString(), now: 1e12 });
  assert.strictEqual(expired.action, 'charge', 'an expired CLAIM is still a claim');
  // and an unclaimed quote past its expiry is a requote, never an error
  assert.strictEqual(g.recoverQuote({ state: 'open', charged_at: null, job_id: null,
    expires_at: new Date(0).toISOString(), now: 1e12 }).action, 'requote');
});

// L18 (b) DIED AFTER THE DEDUCT, BEFORE THE JOB INSERT — charged with nothing
// to show. Detected as exactly that row shape, and REPAIRED BY RESUMING: the
// user wanted the thing and paid for it, and refunding first turns a delay
// into a cancellation they did not choose.
leg('L18 crash_b_charged_without_a_job_is_detected_and_resumed', () => {
  const r = g.recoverQuote({ state: 'claimed', charged_at: '2026-09-23T00:00:00Z', job_id: null });
  assert.strictEqual(r.action, 'resume_job');
  assert.ok(/refund/.test(r.why), 'the fallback must be stated, not assumed');
  // and once the job exists the only thing missing is the settle write
  assert.strictEqual(g.recoverQuote({ state: 'claimed',
    charged_at: '2026-09-23T00:00:00Z', job_id: 'j1' }).action, 'settle');
});

// L19 (c) RC 422 AFTER THE CLAIM RELEASES IT. A quote that is not charged (so
// nothing to refund) and not open (so no confirm can succeed) is stuck
// forever, and nothing about it looks broken.
leg('L19 crash_c_rc_422_releases_the_claim', () => {
  const o = g.chargeOutcome({ ok: false, status: 422 });
  assert.strictEqual(o.charge, 'NOT_CHARGED');
  assert.strictEqual(o.next, 'release');
  assert.strictEqual(o.release_to, 'open');
  // released back to open, the post-top-up confirm is the normal path again
  assert.strictEqual(g.recoverQuote({ state: 'open', charged_at: null, job_id: null }).action,
    'confirm');
});

// L19b AND THE THIRD STATE IS WHERE THE MONEY IS. 422 is the only "not
// charged" RC promises. A timeout or a 5xx is UNKNOWN: releasing would let a
// second confirm charge twice, settling would settle a quote that may never
// have been paid. Folding UNKNOWN into either neighbour is the three-state
// rule failing inside the code that handles money.
leg('L19b an_unknown_charge_holds_rather_than_guessing', () => {
  for (const st of [0, 500, 502, 503, 504, undefined, null]) {
    const o = g.chargeOutcome({ ok: false, status: st });
    assert.strictEqual(o.charge, 'UNKNOWN', `status ${st} must be UNKNOWN`);
    assert.strictEqual(o.next, 'hold', `status ${st} must HOLD`);
    assert.notStrictEqual(o.next, 'release');
  }
  assert.strictEqual(g.chargeOutcome({ ok: true }).charge, 'CHARGED');
});

// L20 (d) THE JOB FAILED AFTER THE CHARGE AND THE REFUND FIRED. The state is
// terminal: say so, never re-charge.
leg('L20 crash_d_refunded_replays_and_never_recharges', () => {
  const r = g.recoverQuote({ state: 'refunded', charged_at: '2026-09-23T00:00:00Z', job_id: 'j1' });
  assert.strictEqual(r.action, 'replay_refund');
  for (const s of ['refunded']) {
    assert.notStrictEqual(g.recoverQuote({ state: s, charged_at: null, job_id: null }).action,
      'charge', 'a refunded quote must never route back to a charge');
  }
});

// L21 THE FIRST RESPONSE IS RECONSTRUCTED, AND THE ONE FIELD THAT CANNOT BE
// IS LABELLED. balance is RevenueCat's number at the moment of the charge and
// RC has no "balance as of" read; storing our own copy would be the second
// source of truth for money this design exists to avoid.
leg('L21 replay_reconstructs_from_state_job_and_charged_at', () => {
  assert.strictEqual(g.recoverQuote({ state: 'settled',
    charged_at: '2026-09-23T00:00:00Z', job_id: 'j1' }).action, 'replay');
  const r = g.replayConfirm({ quote_id: 'q1', kind: 'ai_video', credits: 30,
    job_id: 'j1', balance: 70 });
  assert.strictEqual(r.job_id, 'j1');
  assert.strictEqual(r.credits, 30);
  assert.strictEqual(r.kind_label, 'AI video');
  assert.strictEqual(r.replayed, true);
  assert.strictEqual(r.balance_is_current, true,
    'a balance that could be stale must never be returned as if it were the original');
});

// L22 AN IMPOSSIBLE ROW IS NAMED, NOT REPAIRED. "settled with no charge" and
// "open but charged" are contradictions; picking a half to believe is how a
// repair becomes the second bug.
leg('L22 an_impossible_row_is_inconsistent_not_repaired', () => {
  const bad = [
    { state: 'settled', charged_at: null, job_id: 'j1' },
    { state: 'settled', charged_at: '2026-09-23T00:00:00Z', job_id: null },
    { state: 'open', charged_at: '2026-09-23T00:00:00Z', job_id: null },
    { state: 'open', charged_at: null, job_id: 'j1' },
    { state: 'nonsense', charged_at: null, job_id: null },
  ];
  for (const row of bad) {
    const r = g.recoverQuote(row);
    assert.strictEqual(r.action, 'inconsistent', JSON.stringify(row));
    assert.ok(r.why && r.why.length > 0, 'a contradiction must say what it saw');
  }
});

// L23 kind_label COMES FROM THE KIND. The client was splitting `label` on
// " · " — a parser over prose that already failed on the three kinds whose
// label has no separator at all.
leg('L23 kind_label_comes_from_the_kind_not_the_label', () => {
  for (const [kind, want] of [['ai_video', 'AI video'], ['image', 'Image'],
    ['voiceover', 'Voiceover'], ['music', 'Music'], ['sfx', 'Sound effect']]) {
    assert.strictEqual(g.kindLabel(kind), want);
  }
  assert.strictEqual(g.kindLabel('nope'), null, 'an unknown kind has no label to guess');
  const q = g.quoteCard({ quote_id: 'q', kind: 'music', balance: 10, now: 0 });
  assert.strictEqual(q.kind_label, 'Music');
  // the three that have no separator are exactly the ones the split failed on
  assert.ok(!q.label.includes(' · '));
  assert.strictEqual(Object.keys(g.KIND_LABELS).length, 5);
});

// L24 THE BATCH REPLAY REFUSES AND NAMES WHAT IS MISSING. Nothing applied
// stores the dispatched {job_id, clip_id} pairs, so a crash between dispatch
// and response leaves a batch that can only be re-derived by guessing.
leg('L24 batch_replay_refuses_and_names_what_is_missing', () => {
  const r = g.replayBatchConfirm();
  assert.strictEqual(r.error, 'unreplayable_batch');
  assert.ok(/generation_batch_quotes/.test(r.missing));
  assert.ok(/video_jobs/.test(r.missing));
  assert.ok(/ALTER TABLE/.test(r.fix), 'name the fix, not just the gap');
});

if (failed.length) {
  console.log(`generation-quotes: FAIL (${failed.length} of ${failed.length + n} legs: ${failed.join(', ')})`);
  process.exit(1);
}
console.log(`generation-quotes: PASS (${n} legs — one price table, one 402 shape, no partial sends, paired dispatch, one import)`);

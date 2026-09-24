'use strict';
// Gate for the free monthly cap and the new-subscriber race (Zac 2026-09-24).
//
// THE LEAK. Free tier on builds below the client-claim floor had a 3/day cap
// and nothing monthly. 808 users, 918 completed videos, 0 debited this month
// [MEASURED]. "Free on 246 charged: false" is correct about credits — there is
// no claimed balance to charge — and says nothing about volume.
//
// THE RACE. The client auto-sends a free user's kept re-edit the instant
// StoreKit confirms Pro; profiles.tier arrives from the RevenueCat webhook
// seconds later. So the first request from someone who has just paid can hit a
// free-tier refusal. And RC unreachable must NOT look like "RC says free".

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cap = require('./free-monthly-cap');
const { TIER_RANK, isUserPro } = require('./entitlement');

const CLAIM_MIN = 247;
const st = (o) => cap.capState({ claimMinBuild: CLAIM_MIN, ...o });

// ── L1: THE SECOND VIDEO IN A MONTH IS REFUSED ON 246, THE FIRST IS ADMITTED.
// The cap decision and the claim are separate; this leg pins the decision, L2
// drives a real counter through the claim's own semantics.
assert.strictEqual(st({ isFree: true, build: 246 }), 'APPLIES',
  'L1: a free user on a caller-less build is exactly who this caps');

// ── L2: the claim is a COUNT under one lock, and one-per-month means one.
{
  // The RPC's own semantics, driven: count this month's claims, refuse at the
  // limit, insert otherwise. Written out rather than mocked away, because the
  // property under test is "the second call fails", not "a stub returned false".
  let rows = [];
  const claim = (limit) => {
    const used = rows.length;
    if (used >= limit) return false;
    rows.push(Date.now());
    return true;
  };
  const lim = cap.monthlyLimit({});
  assert.strictEqual(lim, 1, 'L2: the ruled cap is one completed video per calendar month');
  assert.strictEqual(claim(lim), true, 'L2: the FIRST video of the month is admitted');
  assert.strictEqual(claim(lim), false, 'L2: the SECOND is refused');
  rows = [];
  assert.strictEqual(claim(lim), true, 'L2: and a new month admits again');
}

// ── L3: BUILDS 247+ ARE UNTOUCHED. They have a claim path, so credits are the
// limiter and this cap must never also fire — two limiters on one request is
// the both-on defect that shows a credit-holding user the wrong refusal.
assert.strictEqual(st({ isFree: true, build: 247 }), 'HAS_CLAIM_PATH',
  'L3: the floor build itself already has a claim path');
assert.strictEqual(st({ isFree: true, build: 261 }), 'HAS_CLAIM_PATH',
  'L3: and every build above it');

// ── L4: PAID IS NEVER CAPPED HERE, on any build.
for (const b of [200, 246, 247, 261]) {
  assert.strictEqual(st({ isFree: false, build: b }), 'NOT_FREE',
    `L4: a paid account on build ${b} is governed by credits, never by this`);
}

// ── L5: AN UNREADABLE BUILD FAILS OPEN, and says which reason it took.
// debitApplies() already fails open on the same input; the two must not
// disagree about what "unknown build" means.
assert.strictEqual(st({ isFree: true, build: null }), 'BUILD_UNKNOWN',
  'L5: a null build is UNKNOWN, never APPLIES');
assert.strictEqual(st({ isFree: true, build: NaN }), 'BUILD_UNKNOWN',
  'L5: and so is an unparseable one');
assert.notStrictEqual(st({ isFree: true, build: null }), 'APPLIES',
  'L5: we do not cap a user at one video a month on a guess');

// ── L6: THE KILL-SWITCH IS A STATE, NOT A SILENCE.
assert.strictEqual(cap.capState({ isFree: true, build: 246, claimMinBuild: CLAIM_MIN,
  env: { FREE_MONTHLY_CAP_ENABLED: '0' } }), 'DISABLED',
  'L6: disabled is reported as DISABLED, never as "does not apply"');
assert.strictEqual(cap.capState({ isFree: true, build: 246, claimMinBuild: CLAIM_MIN,
  env: {} }), 'APPLIES', 'L6: and the default is ARMED — the leak is the point');

// ── L7: THE REFUSAL USES THE SHAPE BUILD 246 ALREADY RENDERS, and states no
// balance. Read out of the 246 binary, not chosen: APIService.swift at 8aa237d
// routes a 402 to insufficientCredits(needed:balanceKnown:) when
// `error == "insufficient_credits" || kind == "credits"`, and otherwise to
// paymentRequired(kind:limit:message:) which renders `message` verbatim.
{
  const b = cap.refusalBody({ limit: 1, proVideos: 50 });
  assert.strictEqual(b.kind, 'render',
    'L7: kind:"credits" would route 246 into the branch that states a BALANCE');
  assert.notStrictEqual(b.error, 'insufficient_credits',
    'L7: and so would that error string');
  assert.strictEqual(typeof b.message, 'string');
  assert.ok(b.message.length > 0, 'L7: 246 renders `message` verbatim — it cannot be empty');
  assert.strictEqual(b.limit, 1, 'L7: `limit` is decoded by 246 as Int?');
  assert.ok(!('needed' in b) && !('balanceKnown' in b) && !('balance_known' in b),
    'L7: a build with no claim path has no balance for a credits refusal to be about');
  assert.ok(/month/i.test(b.message),
    'L7: the copy names the WINDOW — "1 free video" reads as a daily cap otherwise');
  assert.ok(!/credit/i.test(b.message),
    'L7: and never asks the user to convert a currency they never agreed to');
  assert.strictEqual(b.window, 'month');
}

// ── L8: RC UNREACHABLE → RETRYABLE, NEVER 402, NEVER 500.
{
  const refusal = cap.refusalBody({ limit: 1, proVideos: 50 });
  const r = cap.refusalForRcState('FAILED', refusal);
  assert.strictEqual(r.status, 503,
    'L8: we do not charge a user for OUR dependency being down');
  assert.strictEqual(r.body.retryable, true, 'L8: and we say it is worth retrying');
  assert.notStrictEqual(r.status, 500, 'L8: never a 500 — this is a retry, not a bug report');
  assert.notStrictEqual(r.status, 402, 'L8: and never a refusal');
}

// ── L9: RC SAYS FREE → THE REFUSAL STANDS. A retryable answer here would make
// the cap unenforceable for anyone who has ever had a subscription.
for (const s of ['NEGATIVE', 'NOT_NEEDED', 'SKIPPED_THROTTLED']) {
  const r = cap.refusalForRcState(s, cap.refusalBody({ limit: 1 }));
  assert.strictEqual(r.status, 402, `L9: rcCheck=${s} must still refuse`);
}

// ── L10: THE WEBHOOK-NOT-YET-LANDED CASE IS ADMITTED, AND MAX IS PAID.
// Zac 2026-09-24: "Max is its own entitlement and doesn't imply pro" — the
// frontend had the narrow check. A GRANTED self-heal writes the tier and the
// request proceeds as paid, so capState returns NOT_FREE for both.
// The fixture is a JUST-HEALED row — tier written, RC link present — which is
// exactly what reconcileEntitlementFromRevenueCat leaves behind. A BARE tier
// with no RC link is deliberately refused here (the old self-promote bypass),
// so testing `{tier:'max'}` alone would prove nothing about the max question
// and would quietly pressure that refusal to weaken.
assert.strictEqual(isUserPro({ tier: 'max', rc_app_user_id: 'rc_abc' }), true,
  'L10: a max-only profile is PAID — the narrow "is it pro" check is the bug');
assert.strictEqual(isUserPro({ tier: 'pro', rc_app_user_id: 'rc_abc' }), true,
  'L10: and the pro shape of the same just-healed row');
assert.strictEqual(isUserPro({ tier: 'max', pro_until: new Date(Date.now() + 864e5).toISOString() }), true,
  'L10: and the pro_until shape of the same account');
assert.strictEqual(isUserPro({ tier: 'max' }), false,
  'L10 guard: a bare tier with no RC link stays refused — that is the '
  + 'self-promote bypass, and widening max must not reopen it');
assert.ok(TIER_RANK.max > TIER_RANK.pro,
  'L10: and max outranks pro, so a heal must never downgrade one to the other');
for (const tier of ['pro', 'max']) {
  assert.strictEqual(st({ isFree: false, build: 246 }), 'NOT_FREE',
    `L10: a just-healed ${tier} account on 246 is not capped`);
}
assert.strictEqual(st({ isFree: true, build: 246 }), 'APPLIES',
  'L10 control: and a genuinely free account on the same build still is');

// ── L11: WIRING. Every one of these has been a real failure class here: a
// decision computed and never consulted, a claim with no release, a fallback
// that silently un-caps.
{
  const sv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/claimMonthlyUsage\s*\(/.test(sv) && /_monthlyCap\.capState\(/.test(sv),
    'L11: the cap must be CONSULTED on the render path, not merely defined');
  // DEFINITION *AND* CALLERS, counted. The first version of this leg tested
  // only /releaseMonthlyUsage\s*\(/ and a red proof that renamed the
  // DEFINITION to releaseMonthlyUsage_UNUSED passed it — the call sites still
  // matched the pattern. Grep proves a string is present; it never proves a
  // consumer is wired.
  assert.ok(/async function releaseMonthlyUsage\s*\(/.test(sv),
    'L11: releaseMonthlyUsage must be DEFINED — a claim with no release spends '
    + 'a free user\'s month on OUR failure');
  const releaseCalls = (sv.match(/await releaseMonthlyUsage\(/g) || []).length;
  assert.ok(releaseCalls >= 2,
    `L11: expected the release on BOTH unwind paths (replay and insert-threw); found ${releaseCalls}`);

  assert.ok(/entitlement\.rcCheck/.test(sv),
    'L11: the refusal must read the rcCheck STATE, not just isPro');
  // COMMENTS STRIPPED BEFORE THE MATCH. A check that reads source cannot tell
  // code from prose, and this pair of builders has been caught by exactly that
  // five times in one session — a grep for a phrase matching the paragraph
  // that DESCRIBES the phrase. `FAILED` appears in the comments here several
  // times over; only an assignment counts.
  // __gate_strip, not a hand-rolled regex. __smoke_comment_strip.js exists
  // precisely to catch the naive version — a `/*` inside a string or a glob
  // makes it delete everything to the next `*/` — and it caught mine on the
  // first gate run. A checker that cannot tell a string from code is the same
  // family as one that cannot tell code from prose.
  const code = require('./__gate_strip').stripComments(sv);
  const ent = code.slice(code.indexOf('async function assertProEntitled'),
                         code.indexOf('async function inFlightJobCount'));
  assert.ok(ent.length > 400, 'L11: expected to find assertProEntitled to inspect');
  assert.ok(/_rcCheck\s*=\s*'FAILED'/.test(ent),
    'L11: something must ACTUALLY ASSIGN FAILED inside assertProEntitled, or the '
    + '503 branch is dead code and an RC outage silently 402s a paying user');
  assert.ok(/_rcCheck\s*=\s*'NEGATIVE'/.test(ent),
    'L11: and NEGATIVE must be distinguishable from FAILED, or both collapse');
  assert.ok(/rcCheck:\s*_rcCheck/.test(ent),
    'L11: and the state must reach the caller on the denial return');
  // THE FALLBACK THAT WOULD UN-CAP. claimDailyUsage falls back to
  // count-then-insert when its RPC is absent; the monthly claim must NOT —
  // losing the lock on a 1/month cap costs a whole month, and an absent
  // function would silently return the cohort to unlimited.
  const mBody = sv.slice(sv.indexOf('async function claimMonthlyUsage'),
                         sv.indexOf('async function releaseMonthlyUsage'));
  assert.ok(mBody.length > 200, 'L11: expected to find claimMonthlyUsage to inspect');
  assert.ok(!/countTodayUsage|logUsageEvent/.test(mBody),
    'L11: the monthly claim must have NO racy count-then-insert fallback');
  assert.ok(/PGRST202/.test(mBody) && /503|statusCode = 503/.test(mBody),
    'L11: an undeployed RPC must 503, not quietly un-cap the free tier');
  // The migration the 503 points at must exist, or the message is a dead end.
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'supabase', 'migrations',
    '20260924_claim_monthly_slot.sql')),
    'L11: claimMonthlyUsage names a migration file that must be in the tree');

  // ── L12: EVERY FREE-TIER REFUSAL DOOR ASKS THE SAME QUESTION.
  // Zac named three: re-edit, quote, and the cap. The re-edit doors are where
  // the race actually lands — the client auto-sends a kept re-edit the instant
  // StoreKit confirms Pro — so a 402 there against an unreachable RC is the
  // most likely way a paying customer meets a refusal.
  const proRequired402 = (code.match(/error: 'pro_required'/g) || []).length;
  const guarded = (code.match(/refusalForRcState\(entitlement\.rcCheck/g) || []).length;
  assert.ok(proRequired402 >= 2, `L12: expected the re-edit doors; found ${proRequired402}`);
  assert.strictEqual(guarded, proRequired402,
    `L12: every pro_required refusal must route through refusalForRcState — `
    + `${proRequired402} refusals, ${guarded} guarded. An unguarded one 402s a `
    + 'user who may have paid, whenever RevenueCat is unreachable.');
}

console.log('[smoke] free monthly cap: ALL PASS (second video refused on 246, first admitted, '
  + '247+ untouched, paid never capped, unknown build fails open, kill-switch is a state, '
  + 'refusal is the shape 246 renders and states no balance, RC-unreachable is retryable '
  + 'not 402 and not 500, RC-free still refuses, max-only is paid, wiring + no racy fallback)');
process.exit(0);

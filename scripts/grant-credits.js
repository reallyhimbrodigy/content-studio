#!/usr/bin/env node
'use strict';

// MANUAL CRD GRANT — bring every paying subscriber to their tier allowance
// BEFORE the debit arms.
//
// WHY THIS IS NEEDED AT ALL. RevenueCat grants virtual currency on purchase or
// renewal. The grants were configured AFTER these customers converted, so
// nothing has deposited into their balance and nothing will until they renew.
// Arming CREDITS_DEBIT_ENABLED=1 without this 402s a paying subscriber on every
// render — the worst possible failure of a credits rollout, aimed at exactly
// the people who pay.
//
// EVERY PAID USER, NOT THE DISTANT-RENEWAL ONES. An earlier version of this
// script took a hand-typed list of the five with distant or absent renewals.
// That was the wrong cut: a weekly subscriber renewing in six days still sits
// at zero for those six days. The window differs; the refusal does not. So this
// enumerates the cohort itself and grants the whole of it.
//
// ── THE PREDICATE IS IMPORTED, NEVER REIMPLEMENTED ──────────────────────────
// Paid means `isUserPro(row)` — the same function every gate in server.js uses.
// It is NOT "pro_until is in the future", and the difference is not academic:
//
//   isUserPro returns TRUE for `comp_pro === true` BEFORE it looks at tier or
//   pro_until at all. Five rows today are comp_pro=true with tier='free' and a
//   NULL pro_until. They have 37 renders between them, the most recent 10 days
//   ago. A pro_until query misses every one.
//
// And they are the WORST cohort to miss, not the mildest:
//   - the free monthly roll skips them (isPaid -> skip('paid_tier')), so the
//     server will never grant them either;
//   - they have no subscription, so no renewal will ever grant them;
//   - so their window at zero is not "shorter" or "longer". It is unbounded.
// The SQL below is therefore a deliberately WIDE superset — it can only
// over-select — and `isUserPro` does the actual deciding, in JS, from the
// shipped module. tests/credits-tier.test.js proves the superset cannot miss a
// row isUserPro would accept.
//
// ── READ BEFORE WRITE, ALWAYS ───────────────────────────────────────────────
// Any non-zero balance is a visible SKIP: a subscriber whose renewal already
// landed a grant must not be topped up a second time. `found:false` (RC has
// never seen this customer) is reported distinctly from `balance:0` (it has,
// and the balance is empty) — a bare 0 hides which one you are looking at.
//
// THIS INFERENCE HAS A LIFETIME. "balance > 0 means already granted" holds only
// while nothing can spend. Once CREDITS_DEBIT_ENABLED=1, a user who has spent
// down to 0 is indistinguishable from one who was never granted, and re-running
// this would hand them a second allowance. So --apply REFUSES once the debit is
// armed. That is a guard, not a warning.
//
// ── USAGE — DRY RUN BY DEFAULT. Nothing is written without --apply ──────────
//   node scripts/grant-credits.js                     # all paid users, dry run
//   node scripts/grant-credits.js --apply
//   node scripts/grant-credits.js --users a,b         # restrict to these ids
//   node scripts/grant-credits.js --amount 50 --apply # flat override
//
// Requires REVENUECAT_SECRET_KEY + REVENUECAT_PROJECT_ID (the pair /api/health
// reports as revenuecat.probe:'ok') and SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY for the enumeration.

const credits = require('../lib/credits');
const { isUserPro } = require('../lib/entitlement');
const { supabaseAdmin } = require('../services/supabase-admin');

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force-armed');
const amountOverride = arg('amount', null) === null ? null : parseInt(arg('amount'), 10);
const only = new Set(String(arg('users', '')).split(',').map((s) => s.trim()).filter(Boolean));

if (amountOverride !== null && (!Number.isInteger(amountOverride) || amountOverride <= 0)) {
  console.error('--amount, when given, must be a positive integer');
  process.exit(2);
}
if (!credits.isConfigured()) {
  console.error('RevenueCat is not configured — REVENUECAT_SECRET_KEY / '
    + 'REVENUECAT_PROJECT_ID must both be set. Note isConfigured() is a PRESENCE '
    + 'test: a mismatched pair passes it and every call then 404s. Check '
    + '/api/health .revenuecat.probe === "ok" first.');
  process.exit(2);
}
if (!supabaseAdmin) {
  console.error('Supabase admin client is not configured — SUPABASE_URL and '
    + 'SUPABASE_SERVICE_ROLE_KEY are required to enumerate the paid cohort. '
    + 'Refusing to fall back to a hand-typed list: the whole point of this '
    + 'script is that the cohort is not typed by a human.');
  process.exit(2);
}

// THE ARMED GUARD. See the header — the "non-zero means already granted"
// inference is only sound while nothing can spend.
const DEBIT_ARMED = /^(1|on|true|yes)$/i.test(
  String(process.env.CREDITS_DEBIT_ENABLED ?? '').trim());
if (APPLY && DEBIT_ARMED && !FORCE) {
  console.error('REFUSING: CREDITS_DEBIT_ENABLED is on.\n'
    + '  Once users can spend, a balance of 0 no longer means "never granted" — '
    + 'it also means\n  "granted and spent". Re-running now would hand a '
    + 'spent-down user a second allowance.\n'
    + '  This script is meant to run BEFORE the debit arms. If you have a '
    + 'specific reason to\n  grant anyway, pass --force-armed.');
  process.exit(2);
}

(async () => {
  // ── enumerate ─────────────────────────────────────────────────────────────
  // Deliberately WIDE: the disjuncts are the only ways isUserPro can reach
  // `true` (the comp_pro short-circuit, or a tier in its accepted set), so this
  // can over-select but never under-select. isUserPro below does the deciding.
  //
  // SUBSTRING-ILIKE, NOT `tier.in.(...)`. A SQL `IN` is case-sensitive and does
  // not trim, while isUserPro compares `lower(trim(tier))` — so a row written
  // as 'Pro' or ' pro ' would pass isUserPro and be silently dropped by the
  // query, which is a PAYING USER omitted from the grant with nothing logged.
  // Only 'free' and 'pro' exist today, so that is latent rather than live, but
  // it is one webhook change away and would fail silently. `ilike.*pro*`
  // absorbs case, padding and any decoration; it over-selects (it would match
  // 'nonpro'), and over-selection is exactly what isUserPro is here to reject.
  const TIER_PATTERNS = ['pro', 'teams', 'premium', 'max'];
  // PostgREST caps a response at 1000 rows by DEFAULT AND SAYS NOTHING — a
  // truncated page would look like a complete cohort and quietly omit every
  // paying user past the cut. The explicit limit is set far above the real size
  // (25 paid rows today) purely so hitting it is detectable below.
  const PAGE = 5000;
  const { data: rows, error } = await supabaseAdmin
    .from('profiles')
    .select('id, tier, comp_pro, pro_until, rc_app_user_id, rc_period_type')
    .or(['comp_pro.is.true', ...TIER_PATTERNS.map((t) => `tier.ilike.*${t}*`)].join(','))
    .limit(PAGE);

  if (error) {
    console.error(`enumeration FAILED: ${error.message}`);
    console.error('  Nothing was written. A partial cohort is worse than none: '
      + 'it looks like a completed run.');
    process.exit(1);
  }

  if ((rows || []).length >= PAGE) {
    console.error(`enumeration returned ${rows.length} rows — the page limit was `
      + 'reached, so the\n  cohort is TRUNCATED and an unknown number of paying '
      + 'users are missing from it.\n  Refusing: a partial grant run reads as a '
      + 'complete one. Paginate before re-running.');
    process.exit(1);
  }

  let cohort = (rows || [])
    .filter((r) => isUserPro(r))
    .map((r) => ({
      id: r.id,
      tier: credits.creditTierFor(r),
      period: r.rc_period_type || null,
      linked: Boolean(r.rc_app_user_id),
      proUntil: r.pro_until,
    }));
  if (only.size) {
    // A requested id that is not in the paid cohort must be SAID, not dropped.
    // Silently filtering it away means asking for a grant, seeing a successful
    // run, and never learning the user was never considered.
    const found = new Set(cohort.map((u) => u.id));
    const missing = [...only].filter((id) => !found.has(id));
    if (missing.length) {
      console.error(`\n  ⚠️  ${missing.length} requested id(s) are NOT in the paid `
        + 'cohort and will be ignored:');
      for (const id of missing) console.error(`     ${id}`);
      console.error('     Either the id is wrong, or isUserPro() does not consider '
        + 'them paid — check\n     before assuming this run covered them.\n');
    }
    cohort = cohort.filter((u) => only.has(u.id));
  }

  // A CLEAN ZERO IS GUILTY UNTIL PROVEN INNOCENT. An empty cohort here reads as
  // "everyone is already covered" when it is far more likely to be a broken
  // query, a wrong database, or a service key without visibility.
  if (cohort.length === 0) {
    console.error('enumerated ZERO paid users. That is almost certainly a '
      + 'reader bug, not a\n  fact about the business — there is no state of '
      + 'this product with no paying users.\n  Check SUPABASE_URL points at '
      + 'the production project and the key is service_role.');
    process.exit(1);
  }

  cohort.sort((a, b) => (a.linked === b.linked ? 0 : a.linked ? -1 : 1));

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN (no writes — pass --apply)'}`
    + ` — ${cohort.length} paid user(s), currency ${credits.currencyCode()}`);
  if (amountOverride !== null) {
    console.log(`  flat override: ${amountOverride} to everyone (--amount)`);
  } else {
    const byTier = cohort.reduce((m, u) => ({ ...m, [u.tier]: (m[u.tier] || 0) + 1 }), {});
    console.log('  tier allowance: '
      + Object.entries(byTier)
        .map(([t, n]) => `${n}x ${t}=${credits.TIER_ALLOWANCE[t]}`).join('  '));
  }
  console.log();

  const results = [];
  for (const u of cohort) {
    const amount = amountOverride === null
      ? credits.TIER_ALLOWANCE[u.tier] : amountOverride;
    const tag = `${u.id.slice(0, 8)}  ${u.tier.padEnd(4)}`;

    if (!Number.isInteger(amount) || amount <= 0) {
      console.log(`  ✗ ${tag}  no allowance defined for tier '${u.tier}' — SKIPPED`);
      results.push({ ...u, state: 'failed', why: 'no_allowance' });
      continue;
    }

    let before;
    try {
      // READ FIRST, ALWAYS. Surfaces `found:false` before anything is written,
      // and makes an already-granted user a visible skip rather than a silent
      // double-credit.
      before = await credits.getBalance(u.id);
    } catch (e) {
      console.log(`  ✗ ${tag}  balance read FAILED (${e.code || e.message}) — SKIPPED`);
      results.push({ ...u, state: 'failed', why: `read_${e.code || 'error'}` });
      continue;
    }

    const note = before.found ? '' : '  [no CRD row — RC may not know this customer]';
    if (before.balance > 0) {
      console.log(`  – ${tag}  balance ${before.balance} — SKIPPED (already granted)`);
      results.push({ ...u, state: 'skipped', balance: before.balance });
      continue;
    }
    if (!APPLY) {
      console.log(`  · ${tag}  0 -> ${amount}  (would grant ${amount})${note}`);
      results.push({ ...u, state: 'would_grant', amount });
      continue;
    }
    try {
      await credits.credit(u.id, amount);
      const after = await credits.getBalance(u.id);
      console.log(`  ✓ ${tag}  0 -> ${after.balance}${note}`);
      results.push({ ...u, state: 'granted', amount, after: after.balance });
    } catch (e) {
      console.log(`  ✗ ${tag}  grant FAILED: ${e.code || e.message}${note}`);
      results.push({ ...u, state: 'failed', why: `grant_${e.code || 'error'}` });
    }
  }

  // ── THE UNLINKED COHORT, REPORTED SEPARATELY ──────────────────────────────
  // Users with no rc_app_user_id have never been seen by RevenueCat. Whether
  // the transactions endpoint CREATES a customer on first adjustment or rejects
  // an unknown one is NOT documented, so their failures are a different class
  // from a network blip and must not be averaged into one "failed N" line —
  // they need a dashboard grant, and a run that buries them reads as success.
  const unlinked = results.filter((r) => !r.linked);
  const unlinkedBad = unlinked.filter((r) => r.state === 'failed');

  const n = (s) => results.filter((r) => r.state === s).length;
  console.log(`\n  granted ${n('granted')}  would-grant ${n('would_grant')}`
    + `  skipped ${n('skipped')}  failed ${n('failed')}`);
  console.log(`  linked to RevenueCat: ${results.filter((r) => r.linked).length}`
    + `   NOT linked: ${unlinked.length}`);

  if (unlinked.length) {
    console.log('\n  ── no rc_app_user_id (RevenueCat has never seen these) ──');
    for (const r of unlinked) {
      console.log(`     ${r.id}  ${r.tier}  ${r.state}${r.why ? ` (${r.why})` : ''}`);
    }
    if (unlinkedBad.length) {
      console.log(`\n  ⚠️  ${unlinkedBad.length} unlinked user(s) FAILED — RevenueCat `
        + 'refused an unknown customer.\n     These need a DASHBOARD grant. They are '
        + 'listed above by full id; do not\n     re-run and assume the next attempt '
        + 'behaves differently.');
    } else if (APPLY) {
      console.log('\n     All unlinked users were written successfully — the '
        + 'transactions endpoint\n     creates the customer. No dashboard grant needed.');
    }
  }

  if (!APPLY) console.log('\n  DRY RUN — nothing was written. Re-run with --apply.\n');
  // Non-zero on any failure so this cannot be run from a script and ignored.
  process.exit(n('failed') > 0 ? 1 : 0);
})().catch((e) => {
  console.error(`\nunhandled: ${e && e.stack || e}`);
  process.exit(1);
});

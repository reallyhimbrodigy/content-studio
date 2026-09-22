#!/usr/bin/env node
'use strict';

// BACKFILL TO THE NEW ALLOWANCE — for subscribers who already hold a balance
// under the OLD one. Zac's ruling 2026-09-22 moved pro 200 -> 500, max 1000 ->
// 2000, and a product-level RevenueCat grant only applies at the NEXT RENEWAL.
// Existing subscribers get nothing until then unless something tops them up.
//
// ── WHY THIS IS NOT scripts/grant-credits.js ────────────────────────────────
// That script SKIPS any non-zero balance:
//
//     if (before.balance > 0) -> SKIPPED (already granted)
//
// which is exactly right for its job — bring a NEVER-GRANTED user up to
// allowance — and exactly wrong for this one. The people who need the top-up
// are precisely the ones holding the old 200. Running it here would skip every
// subscriber who needs the money and grant a full new allowance only to those
// at zero, while printing a successful run. Two scripts, two rules, rather than
// a flag that makes one script mean both things.
//
// ── WHY "TOP TO ALLOWANCE" AND NOT A FLAT +300 ──────────────────────────────
// The instruction was "+300 Pro / +1,000 Max". That is the correct DELTA for a
// user sitting at exactly the old allowance, and it is wrong for everyone else:
//
//     balance 200 (old allowance granted)   +300 -> 500   correct
//     balance   0 (RC never granted them)   +300 -> 300   SHORT BY 200
//     balance 340 (partial / promo)         +300 -> 640   OVER
//
// So the flat delta silently depends on an assumption about the starting
// balance that nobody has checked — and 9 of the 32 are not even linked to
// RevenueCat, so a zero is entirely plausible for them. Topping UP TO the
// allowance is idempotent, correct from any starting balance, and degenerates
// to exactly +300 for anyone at 200. It cannot over-grant and cannot under-grant.
//
// A user already AT or ABOVE the new allowance is a visible SKIP, never a
// negative transaction.
//
// ── THE ONE ASSUMPTION THIS STILL MAKES, STATED ─────────────────────────────
// "Balance below allowance means never topped up" holds only while nothing can
// SPEND. Once CREDITS_DEBIT_ENABLED=1, a user who legitimately spent down to
// 100 is indistinguishable from one granted 100, and topping them to 500 hands
// back credits they used. So --apply REFUSES while the debit is armed, the same
// guard grant-credits.js carries and for the same reason.
//
// ── USAGE — DRY RUN BY DEFAULT. Nothing is written without --apply ──────────
//   node scripts/backfill-allowance.js
//   node scripts/backfill-allowance.js --apply
//
// Requires REVENUECAT_SECRET_KEY + REVENUECAT_PROJECT_ID and SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY.

const credits = require('../lib/credits');
const { isUserPro } = require('../lib/entitlement');
const { supabaseAdmin } = require('../services/supabase-admin');

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force-armed');

if (!credits.isConfigured()) {
  console.error('RevenueCat is not configured — REVENUECAT_SECRET_KEY and '
    + 'REVENUECAT_PROJECT_ID must both be set.\n  isConfigured() is a PRESENCE '
    + 'test: a mismatched pair passes it and every call then 404s.');
  process.exit(2);
}
if (!supabaseAdmin) {
  console.error('Supabase admin client is not configured — refusing to fall '
    + 'back to a hand-typed cohort.');
  process.exit(2);
}
const DEBIT_ARMED = /^(1|on|true|yes)$/i.test(
  String(process.env.CREDITS_DEBIT_ENABLED ?? '').trim());
if (APPLY && DEBIT_ARMED && !FORCE) {
  console.error('REFUSING: CREDITS_DEBIT_ENABLED is on.\n'
    + '  A balance below allowance no longer means "never topped up" — it also '
    + 'means\n  "granted and spent", and topping up would hand back credits the '
    + 'user spent.\n  Pass --force-armed only with a specific reason.');
  process.exit(2);
}

(async () => {
  const PAGE = 1000;
  const { data: rows, error } = await supabaseAdmin
    .from('profiles')
    .select('id, tier, comp_pro, pro_until, rc_app_user_id, rc_period_type')
    .or('comp_pro.eq.true,tier.ilike.*pro*,tier.ilike.*max*,tier.ilike.*team*,tier.ilike.*premium*')
    .limit(PAGE);
  if (error) { console.error('enumeration failed:', error.message); process.exit(1); }
  if ((rows || []).length >= PAGE) {
    console.error('enumeration hit the page limit — the cohort is TRUNCATED and '
      + 'a partial run reads as a complete one. Paginate first.');
    process.exit(1);
  }
  const cohort = (rows || []).filter(isUserPro).map((r) => ({
    id: r.id, tier: credits.creditTierFor(r), linked: Boolean(r.rc_app_user_id) }));
  if (!cohort.length) {
    console.error('enumerated ZERO paid users — a reader bug, not a fact.');
    process.exit(1);
  }

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN (no writes — pass --apply)'}`
    + ` — ${cohort.length} paid user(s), currency ${credits.currencyCode()}`);
  console.log(`  target allowance: ${JSON.stringify(credits.TIER_ALLOWANCE)}\n`);
  console.log('   id(8)     tier  before   target   grant   state');

  const results = [];
  for (const u of cohort) {
    const target = credits.TIER_ALLOWANCE[u.tier];
    const tag = `   ${u.id.slice(0, 8)}  ${u.tier.padEnd(4)}`;
    if (!Number.isInteger(target) || target <= 0) {
      console.log(`${tag}  —        —        —       NO ALLOWANCE FOR TIER`);
      results.push({ ...u, state: 'failed', why: 'no_allowance' }); continue;
    }
    let before;
    try { before = await credits.getBalance(u.id); }
    catch (e) {
      console.log(`${tag}  READ FAILED (${e.code || e.message})`);
      results.push({ ...u, state: 'failed', why: `read_${e.code || 'error'}` }); continue;
    }
    // found:false (RC has never seen this customer) is reported distinctly from
    // balance:0 (it has, and the balance is empty). A bare 0 hides which.
    const note = before.found ? '' : '   [no CRD row — RC has never seen them]';
    const grant = target - before.balance;
    if (grant <= 0) {
      console.log(`${tag}  ${String(before.balance).padEnd(7)}  ${String(target).padEnd(7)}`
        + `  0       SKIP (at or above target)${note}`);
      results.push({ ...u, state: 'skipped', before: before.balance }); continue;
    }
    if (!APPLY) {
      console.log(`${tag}  ${String(before.balance).padEnd(7)}  ${String(target).padEnd(7)}`
        + `  +${String(grant).padEnd(6)} would grant${note}`);
      results.push({ ...u, state: 'would_grant', before: before.balance, grant }); continue;
    }
    try {
      await credits.credit(u.id, grant);
      const after = await credits.getBalance(u.id);
      const ok = after.balance === target;
      console.log(`${tag}  ${String(before.balance).padEnd(7)}  ${String(target).padEnd(7)}`
        + `  +${String(grant).padEnd(6)} -> ${after.balance}${ok ? '' : '  ⚠️ NOT AT TARGET'}${note}`);
      results.push({ ...u, state: ok ? 'granted' : 'granted_mismatch',
        before: before.balance, grant, after: after.balance });
    } catch (e) {
      console.log(`${tag}  ${String(before.balance).padEnd(7)}  ${String(target).padEnd(7)}`
        + `  +${String(grant).padEnd(6)} GRANT FAILED: ${e.code || e.message}${note}`);
      results.push({ ...u, state: 'failed', why: `grant_${e.code || 'error'}` });
    }
  }

  const n = (s) => results.filter((r) => r.state === s).length;
  console.log(`\n  granted ${n('granted')}  would-grant ${n('would_grant')}`
    + `  skipped ${n('skipped')}  failed ${n('failed')}`
    + `  mismatch ${n('granted_mismatch')}`);
  const unlinked = results.filter((r) => !r.linked);
  if (unlinked.length) {
    console.log(`\n  ── ${unlinked.length} with no rc_app_user_id (RC has never seen them) ──`);
    for (const r of unlinked) console.log(`     ${r.id}  ${r.tier}  ${r.state}${r.why ? ` (${r.why})` : ''}`);
    console.log('     Whether the transactions endpoint CREATES an unknown customer '
      + 'is undocumented.\n     If these fail they need a dashboard grant — they are '
      + 'listed by full id above.');
  }
  if (!APPLY) console.log('\n  DRY RUN — nothing was written.\n');
  process.exit(n('failed') + n('granted_mismatch') > 0 ? 1 : 0);
})().catch((e) => { console.error('unhandled:', (e && e.stack) || e); process.exit(1); });

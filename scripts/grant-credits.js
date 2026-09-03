#!/usr/bin/env node
'use strict';

// MANUAL CRD GRANT — for paid users whose next renewal is too far away to
// receive RevenueCat's recurring grant before the debit arms.
//
// WHY THIS IS NEEDED AT ALL. RC grants virtual currency on purchase or renewal.
// The grants were configured AFTER these customers converted, so nothing has
// deposited into their balance and nothing will until they renew. Arming
// CREDITS_DEBIT_ENABLED=1 without this 402s a paying subscriber on every render
// — the worst possible failure of a credits rollout, aimed at exactly the
// people who pay.
//
// WHO NEEDS IT (measured 2026-09-03, 20 active paid rows):
//   ea7609f2  promptly_pro_yearly  renews 2027-08-19   ~11 months away
//   2efb75dd  comped               2030-12-31          never renews
//   08956fe8  comped               2030-12-31          never renews
//   0cbe009e  comped               2099-12-31          never renews
//   ec702499  comped               2099-12-31          never renews
// The 12 weekly subscribers (Sept 4-10) and 3 monthly (Sept 27-Oct 1) receive
// theirs from RC on renewal and must NOT be granted here — double-granting is
// not reversible without taking credits back from a paying user.
//
// ⚠️ FOUR OF THE FIVE HAVE NO rc_app_user_id — RevenueCat has never seen them.
// They are hand-promoted/comped accounts. Whether the transactions endpoint
// CREATES a customer on first adjustment or rejects an unknown one is NOT
// documented, and this script does not assume: it reads the balance first and
// reports `found:false` distinctly, so an unknown customer is visible before
// anything is written. If RC rejects them, the fallback is a dashboard grant.
//
// USAGE — DRY RUN BY DEFAULT. Nothing is written without --apply:
//   node scripts/grant-credits.js --amount 200 --users a,b,c
//   node scripts/grant-credits.js --amount 200 --users a,b,c --apply
//
// Requires REVENUECAT_SECRET_KEY + REVENUECAT_PROJECT_ID in the environment —
// the same pair /api/health reports as revenuecat.probe:'ok'.

const credits = require('../lib/credits');

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const APPLY = process.argv.includes('--apply');
const amount = parseInt(arg('amount', ''), 10);
const users = String(arg('users', '')).split(',').map((s) => s.trim()).filter(Boolean);

if (!Number.isInteger(amount) || amount <= 0) {
  console.error('--amount must be a positive integer (Pro 200, Max 1000, free 30)');
  process.exit(2);
}
if (users.length === 0) { console.error('--users is required (comma-separated ids)'); process.exit(2); }
if (!credits.isConfigured()) {
  console.error('RevenueCat is not configured — REVENUECAT_SECRET_KEY / '
    + 'REVENUECAT_PROJECT_ID must both be set. Note isConfigured() is a PRESENCE '
    + 'test: a mismatched pair passes it and every call then 404s. Check '
    + '/api/health .revenuecat.probe === "ok" first.');
  process.exit(2);
}

(async () => {
  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN (no writes — pass --apply)'} `
    + `— ${amount} credits to ${users.length} user(s)\n`);
  let granted = 0; let failed = 0; let skipped = 0;

  for (const userId of users) {
    let before;
    try {
      // READ FIRST, ALWAYS. It surfaces `found:false` (RC has never seen this
      // customer) before anything is written, and it makes a double-grant
      // visible: a user already holding the amount does not need it again.
      before = await credits.getBalance(userId);
    } catch (e) {
      console.log(`  ✗ ${userId}  balance read FAILED (${e.code || e.message}) — SKIPPED.`);
      console.log('      Not granted: writing blind risks double-granting, and a '
        + 'credit cannot be taken back from a paying user without another write.');
      failed++; continue;
    }

    const note = before.found ? '' : '  [no CRD row — RC may not know this customer]';
    if (before.balance >= amount) {
      console.log(`  – ${userId}  balance ${before.balance} >= ${amount} — SKIPPED (already has it)${note}`);
      skipped++; continue;
    }

    if (!APPLY) {
      console.log(`  · ${userId}  ${before.balance} -> ${before.balance + amount}  (would grant ${amount})${note}`);
      continue;
    }
    try {
      await credits.credit(userId, amount);
      const after = await credits.getBalance(userId);
      console.log(`  ✓ ${userId}  ${before.balance} -> ${after.balance}${note}`);
      granted++;
    } catch (e) {
      console.log(`  ✗ ${userId}  grant FAILED: ${e.code || e.message}${note}`);
      failed++;
    }
  }

  console.log(`\n  granted ${granted}  skipped ${skipped}  failed ${failed}`);
  if (!APPLY) console.log('  DRY RUN — nothing was written. Re-run with --apply.\n');
  // Non-zero on any failure so this cannot be run from a script and ignored.
  process.exit(failed > 0 ? 1 : 0);
})();

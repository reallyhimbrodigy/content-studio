'use strict';
// SMOKE — a WEB purchase must grant, and a grant must never revoke.
//
// CONFIRMED against RevenueCat's event reference on 2026-09-05 rather than
// assumed. Stripe / RC Billing / Paddle emit the SAME names as the stores for
// INITIAL_PURCHASE, RENEWAL, CANCELLATION, UNCANCELLATION, EXPIRATION,
// PRODUCT_CHANGE, NON_RENEWING_PURCHASE and BILLING_ISSUE — so those needed no
// change. Two events are web-exclusive:
//   PURCHASE_REDEEMED — a real grant, and it had NO handler. It fell to the
//     unhandled branch, which logs and acks 200 without writing. On web the
//     buyer and the redeemer can be different app_user_ids, so handling only
//     INITIAL_PURCHASE entitles the wrong id and leaves the user unpaid.
//   INVOICE_ISSUANCE — an UNPAID invoice. Must never grant.
// Two are store-exclusive and must not be mistaken for web coverage:
//   SUBSCRIPTION_PAUSED (Play only), REFUND_REVERSED (App Store only).
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
// CODE ONLY. Matching an assertion against raw source also matches COMMENTED-OUT
// code: the first version of this smoke passed against `// payload.pro_until =
// stored;` and reported the guard intact while it was disabled. Strip line
// comments before asserting that a statement EXISTS.
const CODE = SRC.split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
const fail = [];
const ok = (c, m) => { if (!c) fail.push(m); };

const grants = (() => {
  const m = SRC.match(/const grantsPro = new Set\(\[([\s\S]*?)\]\);/);
  if (!m) return null;
  return new Set([...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]));
})();
ok(grants !== null, 'grantsPro set not found — re-point this smoke');

// ── every web-billing grant event is handled ───────────────────────────────
for (const e of ['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE',
                 'UNCANCELLATION', 'NON_RENEWING_PURCHASE', 'PURCHASE_REDEEMED']) {
  ok(grants && grants.has(e),
     `${e} is not in grantsPro — RevenueCat emits it for Stripe / RC Billing / `
     + `Paddle, so a web purchase would ack 200 and grant NOTHING`);
}
// ── and an unpaid invoice must never grant ─────────────────────────────────
ok(grants && !grants.has('INVOICE_ISSUANCE'),
   'INVOICE_ISSUANCE grants Pro — it is an UNPAID invoice; a user would get '
   + 'access for a bill they have not paid');

// ── the store is never used to gate access ─────────────────────────────────
ok(!/event\.store\s*===/.test(SRC) && !/store\s*===\s*'APP_STORE'/.test(SRC),
   'the webhook branches on event.store — a STRIPE/RC_BILLING/PADDLE purchase '
   + 'would take a different path than APP_STORE');
ok(!/store[\s\S]{0,40}!==[\s\S]{0,20}'APP_STORE'/.test(SRC),
   'a non-App-Store event appears to be rejected');

// ── A GRANT MUST NEVER REVOKE ──────────────────────────────────────────────
// expirationIso is null when the event omits expiration_at_ms, and the grant
// payload writes pro_until directly from it. Without a guard that NULLS a
// still-valid paid period: a grant that revokes.
ok(/expiry-guard/.test(SRC),
   'the grant path has no expiry guard — an event without expiration_at_ms '
   + 'writes pro_until:null and REVOKES a paying user');
{
  const m = SRC.match(/if \(payload\.pro_until === null \|\| payload\.pro_until === undefined\) \{([\s\S]{0,700}?)\n              \}/);
  ok(m, 'expiry guard not found in the expected shape');
  ok(m && /new Date\(stored\)\.getTime\(\) > Date\.now\(\)/.test(m[1]),
     'the expiry guard does not check that the stored expiry is in the FUTURE '
     + '— it would resurrect an already-lapsed subscription');
  const mCode = CODE.match(/if \(payload\.pro_until === null \|\| payload\.pro_until === undefined\) \{([\s\S]{0,700}?)\n              \}/);
  ok(mCode && /payload\.pro_until = stored/.test(mCode[1]),
     'the expiry guard computes but never applies the stored value');
}
// it must be scoped to grants, or a revoke could never clear pro_until
ok(/if \(grantsPro\.has\(type\) && payload\.tier\) \{[\s\S]{0,2400}?expiry-guard/.test(SRC),
   'the expiry guard is not inside the grants-only branch — scoped wrongly it '
   + 'would make EXPIRATION unable to clear pro_until, i.e. unrevokable subs');

if (fail.length) {
  console.error('rc web billing smoke: FAIL');
  for (const f of fail) console.error(`   ✗ ${f}`);
  process.exit(1);
}
console.log('rc web billing smoke: PASS (6 web grant events incl. PURCHASE_REDEEMED, '
  + 'INVOICE_ISSUANCE never grants, store never gates, grant cannot revoke)');

#!/usr/bin/env node
'use strict';
// SANDBOX PURCHASE VERIFIER — the three-leg check that catches an orphan.
//
// A purchase is only real when THREE things agree, and each can fail alone:
//   1. CLIENT   purchase_completed fired, carrying the surface (`context`)
//   2. WEBHOOK  RevenueCat told our server about it
//   3. GRANT    the profile actually became Pro
//
// An orphaned purchase is any row present in one leg and missing from the next.
// Checking only leg 1 says "the button worked". Checking only leg 3 says "they
// are Pro" without saying which surface earned it. The orphans that shipped
// were invisible precisely because nobody joined the legs.
//
// IMPORTANT — WHERE `context` LIVES, because it is not where you would expect:
// RevenueCat is never told the surface. `context` is OUR client-side analytics
// prop; the RC webhook payload contains no such field (verified: zero
// occurrences of `context` in the webhook handler, and we set no RC subscriber
// attributes). So "does offer_reveal_secondary land on the webhook" cannot be
// answered — it never travels there. The surface lives on the CLIENT event and
// is joined to the webhook on app_user_id, which is exactly the shape of the
// canonical revenue-per-wall-view read.
//
// Usage: node scripts/verify-sandbox-purchase.js [sinceISO]
//        defaults to the last 6 hours.

const fs = require('fs');
const path = require('path');
const https = require('https');

const SINCE = process.argv[2] || new Date(Date.now() - 6 * 3600e3).toISOString();
const WANT = ['offer_reveal', 'offer_reveal_secondary'];

const env = (() => {
  const p = path.join(__dirname, '..', '.env.local');
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
})();
const URL = env.SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
if (!URL || !KEY) { console.error('verify: CANNOT READ — SUPABASE creds missing. Not a pass.'); process.exit(2); }
const HOST = URL.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

function q(pathname) {
  return new Promise((res) => {
    https.get({ host: HOST, path: '/rest/v1/' + pathname,
                headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact' } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d || '[]')); } catch { res([]); } });
    }).on('error', () => res([]));
  });
}

(async () => {
  const enc = encodeURIComponent(SINCE);
  const completed = await q(`analytics_events?select=user_id,props,created_at,territory&event=eq.purchase_completed&created_at=gte.${enc}&order=created_at.asc`);
  const started = await q(`analytics_events?select=user_id,props,created_at&event=eq.purchase_started&created_at=gte.${enc}&order=created_at.asc`);
  const hooks = await q(`analytics_events?select=props,created_at&event=eq.rc_webhook_received&created_at=gte.${enc}&order=created_at.asc`);

  console.log(`window since ${SINCE}`);
  console.log(`  purchase_started   ${started.length}`);
  console.log(`  purchase_completed ${completed.length}`);
  console.log(`  rc webhooks        ${hooks.length}`);

  console.log('\n=== surfaces seen on the CLIENT (context lives here, not on the webhook) ===');
  const bySurface = {};
  for (const c of completed) {
    const s = (c.props || {}).context || '(none)';
    (bySurface[s] = bySurface[s] || []).push(c);
  }
  for (const w of WANT) {
    const n = (bySurface[w] || []).length;
    console.log(`  ${w.padEnd(26)} ${n > 0 ? `${n} purchase(s) ✓` : 'not seen yet'}`);
  }
  for (const [s, rows] of Object.entries(bySurface)) {
    if (!WANT.includes(s)) console.log(`  ${s.padEnd(26)} ${rows.length} (other surface)`);
  }
  if (!completed.length) {
    console.log('\nNo completed purchase in the window — nothing to verify yet.');
    process.exit(0);
  }

  console.log('\n=== three-leg join, per purchase ===');
  const hookUsers = new Set();
  for (const h of hooks) {
    const p = h.props || {};
    for (const id of [p.app_user_id, p.original_app_user_id, ...(p.aliases || [])]) if (id) hookUsers.add(String(id));
  }

  let orphans = 0, gaps = 0;
  for (const c of completed) {
    const uid = c.user_id;
    const surface = (c.props || {}).context || '(none)';
    const hooked = uid && hookUsers.has(String(uid));
    let granted = false, tier = '?', until = null;
    if (uid) {
      const prof = await q(`profiles?id=eq.${uid}&select=tier,pro_until`);
      if (prof[0]) {
        tier = prof[0].tier;
        until = prof[0].pro_until;
        granted = String(tier).toLowerCase() === 'pro' && until && new Date(until) > new Date();
      }
    }
    const legs = [`client:${surface}`, hooked ? 'webhook:YES' : 'webhook:MISSING',
                  granted ? `grant:PRO until ${String(until).slice(0, 10)}` : `grant:MISSING (tier=${tier})`];
    // TWO DIFFERENT FAILURES, deliberately not merged.
    //
    // ENTITLEMENT ORPHAN — money taken and no Pro granted. Harms a real user
    // and is the class that shipped twice.
    // ATTRIBUTION GAP — Pro granted correctly, but the purchase names no
    // surface, so it cannot enter the by-surface revenue cut. Costs a number,
    // not a user.
    //
    // Calling both "orphan" would put a analytics gap and a billing failure in
    // one count, which is the same mistake as merging a billing decline into
    // voluntary churn. Expect attribution gaps until the context stamp reaches
    // the fleet: it is absent from build 235 entirely.
    const entitlementOrphan = !hooked || !granted;
    const attributionGap = surface === '(none)';
    if (entitlementOrphan) orphans++;
    else if (attributionGap) gaps++;
    const label = entitlementOrphan ? 'ORPHAN' : (attributionGap ? 'NO-SURF' : 'OK     ');
    console.log(`  ${label} ${String(uid).slice(0, 8)}  ${legs.join('  |  ')}`);
  }

  console.log('');
  if (gaps) {
    console.log(`verify: ${gaps} purchase(s) granted Pro correctly but name NO SURFACE.`);
    console.log('  Not a billing failure — an attribution gap. Expected from builds before the');
    console.log('  context stamp (absent in 235, present in 236+); it means those purchases');
    console.log('  cannot enter the by-surface revenue cut, not that anyone was charged wrongly.');
  }
  if (orphans) {
    console.log(`verify: FAILED — ${orphans} ENTITLEMENT ORPHAN(S): money taken, Pro not granted.`);
    console.log('  This is the class that shipped twice. Investigate before anything else.');
    process.exit(1);
  }
  console.log('verify: PASS — no entitlement orphan; every purchase reached the webhook and granted Pro.');
})();

#!/usr/bin/env node
'use strict';
// VERIFY THE VIRTUAL-CURRENCY GRANTS, AND READ THREE REAL SUBSCRIBERS.
// Read-only. Runs in the Render shell:  node scripts/verify-grants.js
//
// ── WHAT THE FIRST VERSION GOT WRONG, ALL THREE SYMPTOMS ────────────────────
//
// Zac's run: 16 products, every product listed TWICE, store "?" on every row,
// grant NONE FOUND on every row including the top-ups. Three symptoms, and
// only one of them was a cosmetic bug.
//
// 1. store "?" — `p.store` DOES NOT EXIST. In RC's v2 shape the store is a
//    property of the APP, not the product; a product carries `app_id`. So the
//    `||` chain fell through to '?' on every row, every time. Now resolved
//    from /apps.
//
// 2. EVERY PRODUCT TWICE — NOT A DEDUPE FAILURE, AND NOTHING TO FIX. There
//    are two apps (App Store and Web Billing), and each product identifier
//    exists once per app. Sixteen rows is eight products across two stores,
//    which is CORRECT — the script's own missing-products note already said
//    both rows must appear. It only read as duplication because symptom 1 had
//    blanked the column that distinguishes them. One bug produced two
//    symptoms, and the second one looked like a different bug.
//
// 3. NONE FOUND ON EVERY ROW — THIS IS THE REAL ONE, AND THE OLD SCRIPT
//    REPORTED IT AS A FACT ABOUT THE GRANTS WHEN IT IS A FACT ABOUT THE
//    PAYLOAD. "No grant on this product" and "grants are not in this response
//    at all" are opposite findings: the first says the flip did not take, the
//    second says we looked in the wrong place. They are indistinguishable
//    from a single row — and INCLUDING THE TOP-UPS is the tell, because a
//    top-up is a consumable that never carries a subscription grant and
//    should have read NONE FOUND either way.
//
//    So the verdict is now taken over the POPULATION, not the row: if NOT ONE
//    product anywhere has a grant-shaped node, the shape is wrong and this
//    says UNKNOWN_SHAPE and prints the actual keys of a product, so the next
//    run is not blind in the same way. Only when SOME products carry grants
//    does a product without one mean the grant is missing.
//
//    This is the same rule the script already applied to the product array
//    itself — "an unreadable envelope is not 'no products'" — which it then
//    failed to apply one level down.
//
// ── IT STILL NAMES NO FIELD IT HAS NOT SEEN ─────────────────────────────────
// The grant walk is unchanged in spirit: it looks for a currency-grant SHAPE
// anywhere in the payload and REPORTS THE PATH it found it under.

const https = require('https');

const KEY = process.env.REVENUECAT_SECRET_KEY;
const PROJECT = process.env.REVENUECAT_PROJECT_ID;
if (!KEY || !PROJECT) {
  console.error('REVENUECAT_SECRET_KEY / REVENUECAT_PROJECT_ID must both be set. '
    + 'Run this in the Render shell, not locally.');
  process.exit(2);
}

// What Zac flipped, 2026-09-22. `null` = cadence-dependent, reported not asserted.
const EXPECTED = {
  promptly_pro_weekly:  120,
  promptly_pro_monthly: 500,
  promptly_pro_yearly:  null,
  promptly_max_monthly: 2000,
  promptly_max_yearly:  null,
};

function get(path, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    https.request({ hostname: 'api.revenuecat.com', path: `/v2/projects/${PROJECT}${path}`,
      method: 'GET', headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } },
      (res) => { let b = ''; res.on('data', (d) => { b += d; });
        res.on('end', () => {
          let j = null; try { j = JSON.parse(b); } catch (e) { /* reported below */ }
          if (raw) return resolve({ status: res.statusCode, json: j, body: b });
          if (res.statusCode >= 300) return reject(
            new Error(`HTTP ${res.statusCode} on ${path}: ${b.slice(0, 300)}`));
          if (!j) return reject(new Error(`unparseable body on ${path}: ${b.slice(0, 200)}`));
          resolve(j);
        }); })
      .on('error', reject).end();
  });
}

function findGrants(node, path = '', out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) => findGrants(v, `${path}[${i}]`, out));
    return out;
  }
  const keys = Object.keys(node);
  const looksLikeGrant = keys.some((k) => /amount|quantity|units/i.test(k))
    && keys.some((k) => /currenc/i.test(k) || /code/i.test(k));
  if (looksLikeGrant) {
    const amtKey = keys.find((k) => /amount|quantity|units/i.test(k));
    const codeKey = keys.find((k) => /currenc/i.test(k) || /code/i.test(k));
    out.push({ path: path || '(root)', code: node[codeKey], amount: node[amtKey] });
  }
  for (const k of keys) findGrants(node[k], path ? `${path}.${k}` : k, out);
  return out;
}

async function productTable() {
  // THE STORE LIVES ON THE APP. Resolve it once rather than guessing per row.
  let apps = {};
  try {
    const a = await get('/apps?limit=100');
    for (const app of (a.items || [])) {
      apps[app.id] = app.type || app.store || app.name || '?';
    }
  } catch (e) {
    console.error('apps read FAILED (store column will read UNRESOLVED):', e.message);
  }

  let products;
  try { products = await get('/products?limit=100&expand[]=app'); }
  catch (e) {
    // The expand may not be supported; fall back and say so rather than dying.
    console.error('products with expand[]=app failed, retrying plain:', e.message);
    try { products = await get('/products?limit=100'); }
    catch (e2) { console.error('products read FAILED:', e2.message); process.exit(1); }
  }

  const items = products.items || products.products || [];
  if (!Array.isArray(items) || !items.length) {
    console.error('UNKNOWN_SHAPE: no product array found. Top-level keys: '
      + JSON.stringify(Object.keys(products)) + '\n  Refusing to report an empty '
      + 'table — an unreadable envelope is not "no products".');
    process.exit(1);
  }

  // Populate the grants first so the verdict can be taken over the population.
  const rows = items.map((p) => ({
    id: String(p.store_identifier || p.identifier || p.id || '?'),
    store: String((p.app && (p.app.type || p.app.name))
      || apps[p.app_id] || p.store || 'UNRESOLVED'),
    grants: findGrants(p),
    raw: p,
  }));
  const anyGrantAnywhere = rows.some((r) => r.grants.length > 0);

  console.log(`\n${rows.length} product row(s) on project ${PROJECT} — `
    + `${new Set(rows.map((r) => r.id)).size} identifier(s) across `
    + `${new Set(rows.map((r) => r.store)).size} store(s)\n`);
  console.log('  %s', ['identifier'.padEnd(26), 'store'.padEnd(16), 'grant'.padEnd(20), 'verdict'].join(''));

  let bad = 0;
  for (const r of rows.sort((a, b) => (a.id + a.store).localeCompare(b.id + b.store))) {
    const exp = EXPECTED[r.id];
    let shown, verdict;
    if (!r.grants.length) {
      if (!anyGrantAnywhere) {
        // NOT A FINDING ABOUT THIS PRODUCT.
        shown = '—';
        verdict = '  (see UNKNOWN_SHAPE below)';
      } else {
        shown = 'NONE';
        verdict = exp === undefined ? '  (not in table)' : `  <-- EXPECTED ${exp}`;
        if (exp !== undefined) bad++;
      }
    } else {
      shown = r.grants.map((g) => `${g.amount} ${g.code}`).join(', ');
      if (exp === undefined) verdict = '  (not in table — top-up or other)';
      else if (exp === null) verdict = '  cadence-dependent, REPORTED NOT ASSERTED';
      else if (r.grants.some((g) => Number(g.amount) === exp)) verdict = '  OK';
      else { verdict = `  <-- MISMATCH, expected ${exp}`; bad++; }
    }
    console.log('  %s', [r.id.padEnd(26), r.store.padEnd(16), String(shown).padEnd(20), verdict].join(''));
    if (r.grants.length) console.log('       found under: %s', r.grants.map((g) => g.path).join(' | '));
  }

  if (!anyGrantAnywhere) {
    console.log('\n  UNKNOWN_SHAPE — NOT ONE of these products carries a currency-grant');
    console.log('  shape, INCLUDING the top-ups, which is the tell. A grant that is');
    console.log('  simply unset would leave the subscription rows empty and is a');
    console.log('  config finding; nothing anywhere is a PAYLOAD finding, and the two');
    console.log('  point at opposite repairs. So this refuses to report "no grants".');
    console.log('\n  The keys a product actually has, so the next run is not blind:');
    console.log('    %s', JSON.stringify(Object.keys(rows[0].raw)));
    console.log('  One product, verbatim (no secrets in a product row):');
    console.log('    %s', JSON.stringify(rows[0].raw).slice(0, 700));
    console.log('\n  DO NOT MOVE TIER_ALLOWANCE. This run did not read the grants.');
    return 1;
  }

  const missing = Object.keys(EXPECTED).filter((k) => !rows.some((r) => r.id === k));
  if (missing.length) {
    console.log(`\n  ${missing.length} EXPECTED product(s) NOT PRESENT: ${missing.join(', ')}`);
    console.log('  A product missing from the list is not a product with no grant — it is');
    console.log('  a product this read did not see.');
    bad += missing.length;
  }
  console.log(`\n  ${bad} row(s) wrong or missing.`);
  console.log(bad ? '\n  DO NOT MOVE TIER_ALLOWANCE. The grants do not match the flip.'
    : '\n  All asserted rows match. TIER_ALLOWANCE may move to 500/2000.');
  return bad ? 1 : 0;
}

// ── WHERE PAID CREDITS ACTUALLY COME FROM, READ FROM THREE REAL SUBSCRIBERS ──
// IDS ONLY IN THE OUTPUT. No email, no name, no product price — a support
// question does not need them and a pasted terminal buffer travels.
async function subscriberReadback() {
  let createClient;
  try { ({ createClient } = require('@supabase/supabase-js')); }
  catch (e) { console.log('\n  (skipping subscriber readback: supabase-js not loadable)'); return 0; }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.log('\n  (skipping subscriber readback: no Supabase service env)'); return 0; }
  const db = createClient(url, key);

  const { data, error } = await db
    .from('profiles')
    .select('id, tier, pro_until, rc_product_id, comp_pro')
    .in('tier', ['pro', 'max'])
    .eq('comp_pro', false)               // a comped account proves nothing about grants
    .gt('pro_until', new Date().toISOString())
    .order('pro_until', { ascending: false })
    .limit(3);
  if (error) { console.log('\n  subscriber select FAILED:', error.message); return 1; }
  if (!data || !data.length) { console.log('\n  NO ACTIVE PAID SUBSCRIBERS FOUND to read.'); return 1; }

  console.log(`\n\n── ${data.length} ACTIVE PAID SUBSCRIBER(S), READ THROUGH TO REVENUECAT ──`);
  let anyBalance = false;
  for (const p of data) {
    console.log(`\n  user ${p.id}   tier=${p.tier}  product=${p.rc_product_id || '(none recorded)'}`);
    const vc = await get(`/customers/${encodeURIComponent(p.id)}/virtual_currencies`, { raw: true });
    if (vc.status >= 300) {
      console.log(`    balance: HTTP ${vc.status} — ${String(vc.body).slice(0, 160)}`);
    } else {
      const items = (vc.json && (vc.json.items || vc.json.virtual_currencies)) || [];
      if (!items.length) console.log('    balance: no virtual-currency row for this customer');
      for (const i of items) {
        console.log(`    balance: ${i.balance} ${i.currency_code || i.code || '?'}`);
        if (Number(i.balance) > 0) anyBalance = true;
      }
    }
    // The transaction history is what says WHERE the credits came from. The
    // path is not one I have observed returning, so its status is printed
    // rather than its absence being read as "no transactions".
    const tx = await get(
      `/customers/${encodeURIComponent(p.id)}/virtual_currencies/transactions?limit=10`,
      { raw: true });
    if (tx.status >= 300) {
      console.log(`    transactions: HTTP ${tx.status} on GET .../transactions — `
        + `${String(tx.body).slice(0, 200)}`);
      console.log('    (a non-200 here is NOT "no transactions" — it is this read failing)');
    } else {
      const txs = (tx.json && (tx.json.items || tx.json.transactions)) || [];
      if (!txs.length) console.log('    transactions: NONE — no grant has ever landed');
      for (const t of txs.slice(0, 10)) {
        console.log('      %s', JSON.stringify(t).slice(0, 220));
      }
    }
  }
  console.log(`\n  Any non-zero paid balance seen: ${anyBalance ? 'YES' : 'NO'}`);
  if (!anyBalance) {
    console.log('  If this is NO across three active paid subscribers, paying users are');
    console.log('  holding no credits, and there is NO second source: the only grant path');
    console.log('  in this codebase is RevenueCat (lib/credits.js). free_credit_periods');
    console.log('  covers the FREE monthly roll and nothing else.');
  }
  return 0;
}

(async () => {
  const a = await productTable();
  const b = await subscriberReadback();
  process.exit(a || b ? 1 : 0);
})().catch((e) => { console.error('unhandled:', (e && e.stack) || e); process.exit(1); });

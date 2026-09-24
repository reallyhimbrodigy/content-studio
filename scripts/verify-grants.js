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

// ── WHERE THE GRANTS ACTUALLY LIVE ──────────────────────────────────────────
// Zac's run settled it: RC product objects carry NO grant fields, so walking a
// product for a currency-grant shape can only ever return nothing — which is
// why the old script's "NONE FOUND on every row" was a fact about the payload.
// The configuration lives on the VIRTUAL CURRENCY, so that is what this reads.
async function currencyConfig() {
  console.log('\n── VIRTUAL CURRENCY CONFIG ─────────────────────────────────');
  const r = await get('/virtual_currencies', { raw: true });
  if (r.status >= 300) {
    console.log(`  GET /virtual_currencies -> HTTP ${r.status}: ${String(r.body).slice(0, 200)}`);
    console.log('  (a non-200 is NOT "no currencies" — it is this read failing)');
    return null;
  }
  const items = (r.json && (r.json.items || r.json.virtual_currencies)) || [];
  if (!items.length) {
    console.log('  no virtual currencies on this project. Top-level keys: '
      + JSON.stringify(Object.keys(r.json || {})));
    return null;
  }
  for (const vc of items) {
    console.log(`  ${vc.code || vc.id}  name=${JSON.stringify(vc.name || '')}`);

    // ── VERBATIM FIRST, INTERPRETATION SECOND ────────────────────────────
    // The CRD config's keys literally included `product_grants` and this
    // script printed "no grant-shaped node" anyway: findGrants() looks for an
    // object carrying BOTH an amount-ish key and a currency-ish key, and
    // whatever shape product_grants uses does not match that guess. The data
    // was in the payload the whole time and the PARSER refused it.
    //
    // That is the payload-versus-configuration confusion one level down, and
    // it is the third time this script has made it. So anything grant-shaped
    // by NAME is dumped RAW before any verdict runs. A reader that can only
    // recognise shapes it expected will keep refusing the one it did not.
    for (const k of Object.keys(vc)) {
      if (/grant|allowance|award|credit/i.test(k)) {
        console.log(`      ${k} (VERBATIM):`);
        console.log('        ' + JSON.stringify(vc[k], null, 2).split('\n').join('\n        '));
      }
    }

    const grants = findGrants(vc);
    if (grants.length) {
      for (const g of grants) console.log(`      parsed: ${g.amount} ${g.code}  (at ${g.path})`);
    } else {
      // NOT "no grants" — "this parser recognised nothing", which is a fact
      // about the parser. The verbatim dump above is the actual evidence.
      console.log(`      parser recognised no grant shape. All keys: ${JSON.stringify(Object.keys(vc))}`);
      console.log('      ^ if a grant-named key is printed above, the DUMP is the answer');
      console.log('        and this line is only saying the matcher did not fit it.');
    }
  }
  // AND THE WHOLE OBJECT, ONCE, for the currency the app actually spends.
  // Truncated reads are how a subset gets read as a total; this one is small.
  console.log('\n  FULL virtual-currency payload, verbatim:');
  console.log('  ' + JSON.stringify(items, null, 2).split('\n').join('\n  ').slice(0, 6000));
  return items;
}

// ── TRANSACTION HISTORY IS NOT EXPOSED BY THE API. THAT IS THE ANSWER. ──────
// Three probes returned 405/404. 405 says the verb is wrong; 404 says the path
// is wrong; neither says "no transactions". So rather than guess a fourth, the
// DOCUMENTATION was read, and it settles it:
//
//   RevenueCat API v2 publishes SEVEN virtual-currency endpoints, and all
//   seven manage currency DEFINITIONS — list, create, retrieve, update,
//   delete, archive, unarchive. There is no endpoint for a customer's
//   virtual-currency transaction history or ledger.
//   https://www.revenuecat.com/docs/api-v2/virtual-currency
//
// The customer BALANCE read we already use
// (GET /customers/{id}/virtual_currencies) lives under the Customer resource
// and does work — which is why a balance is readable and a history is not.
//
// So "how did this user come to hold 120" is NOT answerable from the API, and
// no amount of probing will make it so. The balance is the reliable number;
// the grant CONFIG (above) is where the cadence question gets settled; and
// the dashboard is where a per-customer history can be read by a human.
// Recording this so the next person does not spend another session probing.
const TX_HISTORY_SUPPORTED = false;

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

  // THE COMP FILTER WAS NOT ENOUGH AND ZAC'S RUN PROVED IT. Two of the three
  // "active paid subscribers" it picked were his own internal accounts: pro
  // until 2030, comp_pro FALSE, and NO rc_product_id. A comp flag is one way
  // an account can be non-paying; a hand-set tier with no RevenueCat customer
  // behind it is another, and it looks identical in the profiles row.
  //
  // So the test is now POSITIVE — is there a RevenueCat product on this row —
  // rather than a list of the ways it might be fake. An internal-domain
  // exclusion rides along because a staff account can also hold a real
  // product and still not be a customer.
  const INTERNAL = ['@usepromptly.app', '@promptly.video'];
  const { data: all, error } = await db
    .from('profiles')
    .select('id, tier, pro_until, rc_product_id, comp_pro')
    .in('tier', ['pro', 'max'])
    .eq('comp_pro', false)
    .not('rc_product_id', 'is', null)    // NO RC CUSTOMER, NO GRANT TO CHECK
    .gt('pro_until', new Date().toISOString())
    .order('pro_until', { ascending: false })
    .limit(25);
  let data = all || [];
  if (data.length) {
    const { data: users } = await db.auth.admin.listUsers({ perPage: 200 }).catch(() => ({ data: null }));
    const byId = new Map((users?.users || []).map((u) => [u.id, u.email || '']));
    const before = data.length;
    data = data.filter((p) => {
      const em = String(byId.get(p.id) || '').toLowerCase();
      return !INTERNAL.some((d) => em.endsWith(d));
    });
    if (before !== data.length) {
      console.log(`\n  (excluded ${before - data.length} internal-domain account(s) — `
        + 'a staff row is not evidence about a paying customer)');
    }
    data = data.slice(0, 3);
  }
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
    // NOT PROBED. See TX_HISTORY_SUPPORTED above: the API publishes no
    // transaction-history endpoint, so a request here could only ever produce
    // another 404 to misread.
    console.log('    transactions: NOT EXPOSED BY THE REVENUECAT API — all seven '
      + 'documented virtual-currency');
    console.log('      endpoints manage currency definitions, none reads a customer '
      + 'ledger. The balance');
    console.log('      above is the reliable number; read a per-customer history in '
      + 'the dashboard.');
    const tx = { status: 599, json: null, body: '' };
    if (tx.status >= 300) {
      // kept for shape; the probe loop already reported each status
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
  await currencyConfig();
  const b = await subscriberReadback();
  process.exit(a || b ? 1 : 0);
})().catch((e) => { console.error('unhandled:', (e && e.stack) || e); process.exit(1); });

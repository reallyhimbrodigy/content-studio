#!/usr/bin/env node
'use strict';
// VERIFY THE VIRTUAL-CURRENCY GRANTS ON EVERY PRODUCT — read-only.
//
// RUNS IN THE RENDER SHELL, NOT ON A LAPTOP. Same rule as
// verify-promotional-grant.js: REVENUECAT_SECRET_KEY should exist in as few
// places as possible, so this reads it from the environment it is already in.
// Writing it to run anywhere else would put a production secret on a developer
// machine to save one step.
//
//   render shell promptly -> node scripts/verify-grants.js
//
// ── WHY A READBACK AT ALL ───────────────────────────────────────────────────
// A dashboard flip is a claim about the past, like any other identifier. The
// grant either reaches the product row or it does not, and the only thing that
// knows is RevenueCat. TIER_ALLOWANCE moves on THIS output, not on the flip
// being reported done — a server displaying an allowance nobody holds is the
// failure this whole split exists to prevent.
//
// ── IT NAMES NO FIELDS IT HAS NOT SEEN ──────────────────────────────────────
// RevenueCat's v2 shape for virtual-currency grants is not something I have
// observed, and guessing a key is how `browse_library` got read three times
// with three invented names, each miss recorded as "measured, empty". So this
// WALKS the product payload for anything that looks like a currency grant and
// REPORTS THE PATH IT FOUND IT UNDER. An unrecognised shape is UNKNOWN_SHAPE
// and exits non-zero — never an empty table that reads like "no grants".

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
  promptly_pro_yearly:  null,   // 6000 once-a-year OR 500 monthly
  promptly_max_monthly: 2000,
  promptly_max_yearly:  null,
};

function get(path) {
  return new Promise((resolve, reject) => {
    https.request({ hostname: 'api.revenuecat.com', path: `/v2/projects/${PROJECT}${path}`,
      method: 'GET', headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } },
      (res) => { let b = ''; res.on('data', (d) => { b += d; });
        res.on('end', () => {
          let j = null; try { j = JSON.parse(b); } catch (e) { /* reported below */ }
          if (res.statusCode >= 300) return reject(
            new Error(`HTTP ${res.statusCode} on ${path}: ${b.slice(0, 300)}`));
          if (!j) return reject(new Error(`unparseable body on ${path}: ${b.slice(0, 200)}`));
          resolve(j);
        }); })
      .on('error', reject).end();
  });
}

// Walk for a currency grant without naming a field we have not seen. Returns
// [{path, code, amount}] plus every path inspected, so a miss is visible.
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

(async () => {
  let products;
  try { products = await get('/products?limit=100'); }
  catch (e) { console.error('products read FAILED:', e.message); process.exit(1); }

  const items = products.items || products.products || [];
  if (!Array.isArray(items) || !items.length) {
    console.error('UNKNOWN_SHAPE: no product array found. Top-level keys: '
      + JSON.stringify(Object.keys(products)) + '\n  Refusing to report an empty '
      + 'table — an unreadable envelope is not "no products".');
    process.exit(1);
  }

  console.log(`\n${items.length} product(s) on project ${PROJECT}\n`);
  console.log('  %s', ['identifier'.padEnd(26), 'store'.padEnd(14), 'grant', ' expected'].join(''));
  let bad = 0, unknown = 0;
  for (const p of items) {
    const id = String(p.store_identifier || p.identifier || p.id || '?');
    const store = String(p.store || p.app_store || '?');
    const grants = findGrants(p);
    const exp = EXPECTED[id];
    let shown, verdict;
    if (!grants.length) { shown = 'NONE FOUND'; verdict = exp === undefined ? '  (not in table)' : '  <-- EXPECTED ' + exp; if (exp !== undefined) bad++; }
    else {
      shown = grants.map((g) => `${g.amount} ${g.code}`).join(', ');
      if (exp === undefined) verdict = '  (not in table — top-up or other, unchanged)';
      else if (exp === null) verdict = '  cadence-dependent, REPORTED NOT ASSERTED';
      else if (grants.some((g) => Number(g.amount) === exp)) verdict = '  OK';
      else { verdict = `  <-- MISMATCH, expected ${exp}`; bad++; }
    }
    if (shown === 'NONE FOUND' && exp === undefined) unknown++;
    console.log('  %s', [id.padEnd(26), store.padEnd(14), String(shown).padEnd(22), verdict].join(''));
    if (grants.length) console.log('       found under: %s', grants.map((g) => g.path).join(' | '));
  }

  const missing = Object.keys(EXPECTED).filter((k) =>
    !items.some((p) => String(p.store_identifier || p.identifier || p.id) === k));
  if (missing.length) {
    console.log(`\n  ${missing.length} EXPECTED product(s) NOT PRESENT in the response: `
      + missing.join(', '));
    console.log('  A product missing from the list is not a product with no grant — '
      + 'it is a\n  product this read did not see. Both App Store and Web Billing '
      + 'rows must appear.');
    bad += missing.length;
  }
  console.log(`\n  ${bad} row(s) wrong or missing; ${unknown} product(s) with no grant `
    + 'and no expectation (top-ups and anything else — unchanged by design).');
  if (bad) console.log('\n  DO NOT MOVE TIER_ALLOWANCE. The grants do not match the flip.');
  else console.log('\n  All asserted rows match. TIER_ALLOWANCE may move to 500/2000.');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('unhandled:', (e && e.stack) || e); process.exit(1); });

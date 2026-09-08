'use strict';
// The web-checkout knob must be DARK unless a well-formed blob is present, and
// must never throw on a bad one — a malformed env var cannot take /api/health down.
const assert = require('assert');
const fs = require('fs'); const path = require('path');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const i = server.indexOf('web_checkout: (() => {'); assert.ok(i > 0, 'web_checkout must be served from /api/health');
// BRACE-MATCHED, not a fixed window. This was server.slice(i, i + 1200) — a
// distance-bounded slice that silently stopped covering the block the moment it
// grew past 1200 chars, so `catch (_) { return null; }` fell outside the window
// and the "never throws" assertion failed against code that does exactly that.
// A check whose reach is measured in characters stops checking when the code
// changes size, which is the one thing code reliably does.
const block = (() => {
  let d = 0;
  for (let k = i; k < server.length; k++) {
    if (server[k] === '{') d++;
    else if (server[k] === '}') { d--; if (d === 0) return server.slice(i, k + 6); }
  }
  throw new Error('web_checkout block is unbalanced — cannot extract it');
})();
assert.ok(/WEB_CHECKOUT_JSON/.test(block), 'the blob comes from WEB_CHECKOUT_JSON');
assert.ok(/catch \(_\) \{ return null; \}/.test(block), 'a malformed blob yields null, never a throw');
assert.ok(/return null;[\s\S]*products/.test(block), 'no products → dark');
assert.ok(/\['USA'\]/.test(block), 'storefront default is USA only');
for (const ev of ['external_link_tap', 'checkout_method_chosen', 'checkout_sheet_shown']) {
  assert.ok(server.includes(`'${ev}'`), `${ev} must be allowlisted or attribution is silently dropped`);
}
// Behavioural: evaluate the IIFE against three env values.
const fn = new Function('process', 'return ' + block.slice(block.indexOf('(() => {'), block.indexOf('})(),') + 4));
assert.strictEqual(fn({ env: {} }), null, 'absent → null');
assert.strictEqual(fn({ env: { WEB_CHECKOUT_JSON: '{not json' } }), null, 'garbage → null');
// PACKAGE id, not product id — the offering is keyed by package, and an
// allowlist written against promptly_pro_* drops every real entry.
const good = fn({ env: { WEB_CHECKOUT_JSON: JSON.stringify({ products: { '$rc_annual': { web_price: '$246.99', url: 'https://pay.rev.cat/x/{app_user_id}' } } }) } });
assert.deepStrictEqual(good.storefronts, ['USA']);
// saved_pct is DERIVED now: this fixture carries no web_price_micros, so there
// is no price to compare and no claim to make. It asserted 15 when 15 was a
// hardcoded default — the very thing that let a web price equal to Apple's
// advertise a discount.
assert.strictEqual(good.saved_pct, 0);
assert.ok(good.products['$rc_annual']);
console.log('web-checkout-knob smoke: PASS — dark by default, null on garbage, USA-only default, events allowlisted');


// ══════════════════════════════════════════════════════════════════════════
// PACKAGES, INTRO PRICING, AND A CLAIM THAT DERIVES ITSELF.
//
// The Web Billing offering is keyed by PACKAGE id ($rc_weekly, $rc_monthly,
// $rc_annual, max_*), NOT by App Store product id. An allowlist written against
// product ids drops every real entry and returns null — the whole feature dark,
// with nothing in the logs but a blob that "did not parse".
//
// A top-up bought on the web grants NOTHING: VIRTUAL_CURRENCY_TRANSACTION
// reaches the webhook's unhandled branch — logged, acked 200, no write.
//
// And saved_pct was a hardcoded 15 rendered regardless of the real prices, so a
// web price EQUAL to Apple's advertised "save 15%".
// ══════════════════════════════════════════════════════════════════════════
const WEB = {
  '$rc_weekly':  { web_price: '$10.99',  web_price_micros: 10990000 },
  '$rc_monthly': { web_price: '$29.99',  web_price_micros: 29990000,
                   web_intro_price: '$14.99',  web_intro_price_micros: 14990000 },
  '$rc_annual':  { web_price: '$289.99', web_price_micros: 289990000,
                   web_intro_price: '$144.99', web_intro_price_micros: 144990000 },
  'max_monthly': { web_price: '$89.99',  web_price_micros: 89990000 },
  'max_yearly':  { web_price: '$799.99', web_price_micros: 799990000 },
};
const mk = (products, env) => fn(Object.assign(
  { env: Object.assign({ WEB_CHECKOUT_JSON: JSON.stringify({ products }) }, env || {}) }));

// PACKAGE ids survive; product ids are not the key and must not be assumed
{
  const r = mk(WEB);
  assert.ok(r, 'the real Web Billing blob was nulled — the allowlist is keyed on '
    + 'product ids while the offering uses PACKAGE ids');
  assert.deepStrictEqual(Object.keys(r.products).sort(),
    ['$rc_annual', '$rc_monthly', '$rc_weekly', 'max_monthly', 'max_yearly'],
    'a real package was dropped');
}

// TODAY: Apple's US prices equal the web prices -> NO claim, step dark
{
  const r = mk(WEB);
  assert.strictEqual(r.saved_pct, 0,
    'a saving was claimed while Apple and web prices are identical');
  assert.strictEqual(r.intro_saved_pct, 0,
    'the annual intro is $144.99 against Apple $145.99 — a true 0.68% that '
    + 'rounds to "save 1%". Below the floor it must claim nothing: a 1% badge '
    + 'is honest and commercially worse than silence');
}

// AFTER the App Store gross-up, via env — no code deploy
{
  const r = mk(WEB, {
    APP_STORE_US_MICROS: JSON.stringify({ '$rc_weekly': 12990000, '$rc_monthly': 34990000,
      '$rc_annual': 339990000, 'max_monthly': 105990000, 'max_yearly': 939990000 }),
    APP_STORE_US_INTRO_MICROS: JSON.stringify({ '$rc_annual': 171750000, '$rc_monthly': 17990000 }),
  });
  assert.strictEqual(r.saved_pct, 15, `base saving should be 15, got ${r.saved_pct}`);
  assert.strictEqual(r.intro_saved_pct, 17, `intro saving should be 17, got ${r.intro_saved_pct}`);
  assert.strictEqual(r.products['$rc_annual'].intro_saved_pct, 16,
    "the annual's $171.75-vs-$144.99 intro comparison is 16%");
}

// AN APPLE INTRO WITH NO WEB INTRO CLAIMS NOTHING — comparing an intro against
// a full price invents a discount out of a billing-period mismatch.
{
  const r = mk({ '$rc_annual': { web_price: '$289.99', web_price_micros: 289990000 } },
    { APP_STORE_US_INTRO_MICROS: JSON.stringify({ '$rc_annual': 171750000 }) });
  assert.strictEqual(r.products['$rc_annual'].intro_saved_pct, 0,
    'an Apple intro was compared against a FULL web price');
}

// a top-up package is dropped even among valid subscriptions
{
  const r = mk(Object.assign({}, WEB, { promptly_credits_50: { web_price: '$9.99', web_price_micros: 9990000 } }));
  assert.ok(!r.products.promptly_credits_50,
    'a TOP-UP was offered — VIRTUAL_CURRENCY_TRANSACTION is unhandled, so the '
    + 'purchase takes money and grants no credits');
  assert.strictEqual(Object.keys(r.products).length, 5, 'a subscription was dropped too');
}

// only top-ups -> null, never an empty sheet
assert.strictEqual(mk({ promptly_credits_50: { web_price: '$9.99', web_price_micros: 9990000 } }), null,
  'a blob of only top-ups must be null, not an empty products map');

// the blob cannot assert its own discount
{
  const r = fn({ env: { WEB_CHECKOUT_JSON: JSON.stringify({ saved_pct: 40, products: WEB }) } });
  assert.strictEqual(r.saved_pct, 0,
    'saved_pct was taken from the JSON — the claim must be DERIVED');
}

// a higher web price never claims a saving
{
  const r = mk({ '$rc_annual': { web_price: '$449.99', web_price_micros: 449990000 } });
  assert.strictEqual(r.saved_pct, 0, 'a web price ABOVE Apple claimed a saving');
}

console.log('web-checkout-knob: package-keyed, top-ups dropped, base+intro savings '
  + 'derived (0 today, 15/17 after the gross-up), 1% floored, blob cannot assert');

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
const good = fn({ env: { WEB_CHECKOUT_JSON: JSON.stringify({ products: { promptly_pro_yearly: { web_price: '$246.99', url: 'https://pay.rev.cat/x/{app_user_id}' } } }) } });
assert.deepStrictEqual(good.storefronts, ['USA']);
// saved_pct is DERIVED now: this fixture carries no web_price_micros, so there
// is no price to compare and no claim to make. It asserted 15 when 15 was a
// hardcoded default — the very thing that let a web price equal to Apple's
// advertise a discount.
assert.strictEqual(good.saved_pct, 0);
assert.ok(good.products.promptly_pro_yearly);
console.log('web-checkout-knob smoke: PASS — dark by default, null on garbage, USA-only default, events allowlisted');


// ══════════════════════════════════════════════════════════════════════════
// TOP-UPS ARE DROPPED, AND THE SAVINGS CLAIM IS DERIVED.
//
// A top-up bought on the web grants NOTHING: RevenueCat emits
// VIRTUAL_CURRENCY_TRANSACTION and that event reaches the webhook's UNHANDLED
// branch — logged, acked 200, no write, no balance touched. Taking money for
// credits that never arrive is worse than not selling them.
//
// And saved_pct was a hardcoded 15 rendered regardless of the actual prices, so
// a web price EQUAL TO Apple's still advertised "save 15%" — a false claim
// about money that survives exactly as long as nobody compares the numbers.
// ══════════════════════════════════════════════════════════════════════════
const mk = (products, extra) => fn({ env: { WEB_CHECKOUT_JSON:
  JSON.stringify(Object.assign({ products }, extra || {})) } });

// a non-subscription SKU is dropped, not offered
{
  const r = mk({
    promptly_pro_yearly: { web_price: '$299.99', web_price_micros: 299990000,
                           url: 'https://pay.rev.cat/x/{app_user_id}' },
    promptly_credits_50: { web_price: '$9.99', web_price_micros: 9990000,
                           url: 'https://pay.rev.cat/x/{app_user_id}' },
  });
  assert.ok(r, 'blob with a valid subscription must not be nulled');
  assert.ok(!r.products.promptly_credits_50,
    'a TOP-UP product was offered on the web — VIRTUAL_CURRENCY_TRANSACTION is '
    + 'unhandled, so the purchase would take money and grant no credits');
  assert.ok(r.products.promptly_pro_yearly, 'the subscription was dropped too');
}

// a blob of ONLY top-ups collapses to null rather than rendering an empty sheet
{
  const r = mk({ promptly_credits_50: { web_price: '$9.99', web_price_micros: 9990000 } });
  assert.strictEqual(r, null,
    'a blob containing only non-subscription products must be null, not an '
    + 'empty products map the client renders as a broken sheet');
}

// SAVINGS: derived from the Apple price, and only when web is genuinely lower
{
  const r = mk({ promptly_pro_yearly: { web_price: '$299.99', web_price_micros: 299990000,
                                        url: 'u' } });
  assert.strictEqual(r.saved_pct, 25,
    `299.99 against Apple's 399.99 is 25% saved, got ${r.saved_pct}`);
  assert.strictEqual(r.products.promptly_pro_yearly.saved_pct, 25,
    'the per-product saving is not set');
}

// EQUAL prices claim NOTHING — this is today's live blob exactly
{
  const r = mk({ promptly_pro_yearly: { web_price: '$399.99', web_price_micros: 399990000,
                                        url: 'u' } });
  assert.strictEqual(r.saved_pct, 0,
    'a web price EQUAL to Apple advertised a saving — the hardcoded 15 is back');
}

// a HIGHER web price never claims a saving
{
  const r = mk({ promptly_pro_yearly: { web_price: '$449.99', web_price_micros: 449990000,
                                        url: 'u' } });
  assert.strictEqual(r.saved_pct, 0,
    'a web price ABOVE Apple claimed a saving');
  assert.strictEqual(r.products.promptly_pro_yearly.saved_pct, 0,
    'per-product saving is negative or positive on a more expensive product');
}

// the blob CANNOT assert its own saving any more
{
  const r = mk({ promptly_pro_yearly: { web_price: '$399.99', web_price_micros: 399990000,
                                        url: 'u' } }, { saved_pct: 40 });
  assert.strictEqual(r.saved_pct, 0,
    'saved_pct was taken from the JSON — the claim must be DERIVED from the '
    + 'prices, so a blob cannot assert a discount it does not give');
}

// a missing/garbage web price yields no claim rather than NaN
{
  const r = mk({ promptly_pro_yearly: { web_price: 'free!', url: 'u' } });
  assert.strictEqual(r.saved_pct, 0, 'an unparseable price produced a saving');
}

console.log('web-checkout-knob: top-ups dropped, savings derived from Apple prices '
  + '(equal/higher/garbage all claim 0, blob cannot assert its own discount)');

'use strict';
// The web-checkout knob must be DARK unless a well-formed blob is present, and
// must never throw on a bad one — a malformed env var cannot take /api/health down.
const assert = require('assert');
const fs = require('fs'); const path = require('path');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const i = server.indexOf('web_checkout: (() => {'); assert.ok(i > 0, 'web_checkout must be served from /api/health');
const block = server.slice(i, i + 1200);
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
assert.deepStrictEqual(good.storefronts, ['USA']); assert.strictEqual(good.saved_pct, 15); assert.ok(good.products.promptly_pro_yearly);
console.log('web-checkout-knob smoke: PASS — dark by default, null on garbage, USA-only default, events allowlisted');

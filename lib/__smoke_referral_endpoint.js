'use strict';
// The referral payout endpoints, read as text: what must be true of the code
// for the loop to pay honestly under the 2026-09-05 rule (installs → 7 days).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const fnAt = server.indexOf('async function reconcileReferrer(referrerId)');
assert.ok(fnAt > 0, 'reconcileReferrer must exist — both entrances settle through one function');
const fn = server.slice(fnAt, fnAt + 5000);

// Installs, not renders, not a flag.
assert.ok(/from\('referrals'\)\.select\('id, referred_id, counted_at'\)/.test(fn),
  'the referrer is paid from referrals rows alone');
assert.ok(!/video_jobs/.test(fn) && !/qualified_at/.test(fn),
  'no render requirement and no qualified_at flag — an install is a claimed row');
assert.ok(/REWARD_AT, REWARD_DAYS/.test(fn), 'the rule constants come from referral-rewards, not literals here');

// Ledger first, provider_ok false → true only after the entitlement write.
assert.ok(/provider_ok: false/.test(fn) && /provider_ok: true/.test(fn), 'ledger row before and after the grant');
assert.ok(fn.indexOf('provider_ok: false') < fn.indexOf('provider_ok: true'), 'ledger-first ordering');
assert.ok(/counted_at: new Date\(\)\.toISOString\(\)/.test(fn), 'installs are marked counted so none pays twice');
assert.ok(/alreadyRewarded/.test(fn), 'a referrer who has been paid is never paid again');

// Entrance 1: the referrer, from the token only.
const r1 = server.indexOf("parsed.pathname === '/api/referral/reconcile'");
assert.ok(r1 > 0, 'the reconcile endpoint must exist');
const b1 = server.slice(r1, r1 + 900);
assert.ok(/reconcileReferrer\(user\.id\)/.test(b1), 'reconcile settles the AUTHENTICATED user, never a body id');
assert.ok(!/body\.(referrer|referrer_id|referrerId)/.test(b1), 'no referrer id from the body — that is a self-grant');

// Entrance 2: the referred user right after claiming; the referrer comes from the row.
const r2 = server.indexOf("parsed.pathname === '/api/referral/claimed'");
assert.ok(r2 > 0, 'the claimed endpoint must exist — the third install pays without the referrer opening the app');
const b2 = server.slice(r2, r2 + 1400);
assert.ok(/eq\('referred_id', user\.id\)/.test(b2), 'the referral row is looked up by the authenticated referred user');
assert.ok(/reconcileReferrer\(row\.referrer_id\)/.test(b2), 'the referrer is read from the row, never the body');
assert.ok(!/pro_until/.test(b2.slice(b2.indexOf('sendJson(res, 200, { ok: r.ok'))),
  'the referred user is never told the referrer\'s pro_until');

console.log('referral-endpoint smoke: PASS — installs pay, referrer from token or row, ledger first, once only, no body ids');

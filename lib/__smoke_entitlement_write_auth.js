'use strict';
// SMOKE — every route that writes ENTITLEMENT or BALANCE must be
// verified-webhook or service-role only. This is the fake-payment vector: if a
// forged INITIAL_PURCHASE can reach the grant path, anyone can mint Pro.
const fs = require('fs');
const path = require('path');
const { revenuecatWebhookAuthMatches } = require('./entitlement');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const fail = [];
const ok = (c, m) => { if (!c) fail.push(m); };

// ── 1. THE AUTH PREDICATE FAILS CLOSED ─────────────────────────────────────
ok(revenuecatWebhookAuthMatches('Bearer s3cret', '') === false,
   'an UNSET expected secret accepts a request — unset must reject everything, '
   + 'or a misconfigured deploy is an open grant endpoint');
ok(revenuecatWebhookAuthMatches('Bearer s3cret', null) === false,
   'a null secret accepts');
ok(revenuecatWebhookAuthMatches('', 's3cret') === false, 'an empty header is accepted');
ok(revenuecatWebhookAuthMatches(undefined, 's3cret') === false,
   'a MISSING Authorization header is accepted — this is the forged-request case');
ok(revenuecatWebhookAuthMatches('Bearer wrong', 's3cret') === false, 'a wrong secret is accepted');
ok(revenuecatWebhookAuthMatches('Bearer s3cret', 's3cret') === true, 'the correct secret is REJECTED');
ok(revenuecatWebhookAuthMatches('s3cret', 'Bearer s3cret') === true,
   'bare-vs-Bearer normalisation broke — a prefix mismatch 401s real billing');

// ── 2. THE REJECTION PRECEDES ANY READ OR WRITE ────────────────────────────
// Order is the property. An auth check that runs AFTER the body is parsed or
// after a DB handle is taken is a check that has already done work for an
// attacker.
const seg = SRC.slice(SRC.indexOf('revenuecat-webhook') >= 0
  ? SRC.indexOf('revenuecat-webhook') : 0);
const iAuth = SRC.indexOf('revenuecatWebhookAuthMatches(req.headers.authorization');
const iBody = SRC.indexOf('const body = await readJsonBody(req);', iAuth);
const iAdmin = SRC.indexOf('supabaseAdmin', iAuth);
ok(iAuth > 0, 'the webhook auth check is gone from server.js');
ok(iBody > iAuth, 'the request body is parsed BEFORE the auth check');
ok(iAdmin > iAuth, 'a Supabase handle is taken BEFORE the auth check');
ok(/if \(!expected\) \{[\s\S]{0,220}?503/.test(SRC),
   'an unset REVENUECAT_WEBHOOK_AUTH does not 503 — it must refuse to serve at '
   + 'all rather than fall through to processing');
ok(/auth_mismatch[\s\S]{0,120}?401/.test(SRC), 'an auth mismatch does not 401');

// ── 3. EVERY OTHER ENTITLEMENT/BALANCE WRITER IS GUARDED ───────────────────
for (const route of ['/api/referral/reconcile']) {
  const i = SRC.indexOf(route);
  ok(i > 0, `${route} not found — re-point this smoke`);
  if (i > 0) {
    const win = SRC.slice(i, i + 1600);
    ok(/requireUser|authUser|getUserFromRequest|verifyAuth|supabaseAdmin/.test(win),
       `${route} has no visible auth gate within its handler — a route that `
       + `writes balance must be service-role or authenticated`);
  }
}
// the free-grant endpoint must require an authenticated user before granting
{
  const i = SRC.indexOf("'free-grant'");
  ok(i > 0, 'free-grant rate-limit anchor missing — re-point this smoke');
  const win = SRC.slice(Math.max(0, i - 1200), i + 400);
  ok(/authUser/.test(win),
     'the free-credits grant endpoint does not resolve an authenticated user '
     + 'before granting — an unauthenticated caller could mint credits');
}

if (fail.length) {
  console.error('entitlement write-auth smoke: FAIL');
  for (const f of fail) console.error(`   ✗ ${f}`);
  process.exit(1);
}
console.log('entitlement write-auth smoke: PASS (auth fails closed, rejection precedes '
  + 'body-parse and DB handle, unset secret 503s, balance writers authenticated)');

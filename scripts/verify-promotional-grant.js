#!/usr/bin/env node
'use strict';
// PROMOTIONAL-GRANT VERIFICATION — v2 path, runs SERVER-SIDE.
//
// Deliberately not runnable from a laptop: REVENUECAT_SECRET_KEY should exist in
// as few places as possible, so this reads it from the environment it is already
// in. Run it in the Render shell.
//
// WHY v2 AND NOT v1. The first version of this script targeted
// POST /v1/subscribers/{id}/entitlements/{id}/promotional — the endpoint every
// "grant promotional access" doc points at. That would have failed on auth and
// looked like a broken integration. Our key is a **v2** key (.env.example:
// "RevenueCat REST *v2* API key … starts with sk_"), the code authenticates
// `Authorization: Bearer` against https://api.revenuecat.com/v2, and RevenueCat
// states v1 and v2 keys are not interchangeable. The v2 equivalent is:
//
//   POST /v2/projects/{project_id}/customers/{customer_id}/actions/grant_entitlement
//   POST /v2/projects/{project_id}/customers/{customer_id}/actions/revoke_granted_entitlement
//
// ONE RUN ANSWERS THREE THINGS, each of which independently blocks the build:
//   SCOPE    does this key carry customer_information:customers:read_write, or
//            is it read-only? A read-only key fails identically on either API
//            version, so "wrong version" and "wrong scope" look the same until
//            you separate them — this reports the status code verbatim.
//   SHAPE    what the endpoint actually accepts. The body is printed on any 4xx
//            rather than guessed at.
//   WEBHOOK  does a grant emit an event? RevenueCat's docs do not say. If it
//            does not, profiles.tier never flips and a user earns a reward they
//            cannot see — an entitlement orphan created by design.
//
// SAFETY: operates on a synthetic customer id, never a real subscriber, and
// revokes at the end.

const https = require('https');

const KEY = process.env.REVENUECAT_SECRET_KEY;
const PROJECT = process.env.REVENUECAT_PROJECT_ID;
const ENT = process.argv[2] || 'pro';
const SUPA = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const UID = `promo-verify-${Date.now()}`;

if (!KEY || !PROJECT) {
  console.error('CANNOT RUN — REVENUECAT_SECRET_KEY / REVENUECAT_PROJECT_ID not in this environment.');
  console.error('  Run this on the server (Render shell), not locally. That is the point.');
  process.exit(2);
}

function rc(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: 'api.revenuecat.com', path, method,
      headers: {
        Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (r) => {
      let d = ''; r.on('data', (c) => (d += c));
      r.on('end', () => { let j = {}; try { j = d ? JSON.parse(d) : {}; } catch { j = { raw: d.slice(0, 400) }; }
        resolve({ status: r.statusCode, body: j }); });
    });
    req.on('error', (e) => resolve({ status: 0, body: { err: e.message } }));
    if (data) req.write(data);
    req.end();
  });
}
function supa(path) {
  return new Promise((resolve) => {
    if (!SUPA || !SUPA_KEY) return resolve(null);
    const host = SUPA.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    https.get({ host, path: '/rest/v1/' + path,
                headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c));
      r.on('end', () => { try { resolve(JSON.parse(d || '[]')); } catch { resolve([]); } });
    }).on('error', () => resolve(null));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `/v2/projects/${encodeURIComponent(PROJECT)}`;

(async () => {
  console.log(`project: ${PROJECT}   entitlement: ${ENT}   synthetic customer: ${UID}`);

  // ── 0. is the project reachable under this key at all? ────────────────────
  let r = await rc('GET', `${base}`);
  console.log(`\nPROJECT REACHABLE   HTTP ${r.status}`);
  if (r.status === 401 || r.status === 403) {
    console.error('  The key cannot even read the project. Everything below would fail for the');
    console.error('  same reason, so stop here: this is an auth/scope problem, not a grant problem.');
    process.exit(1);
  }

  // ── 1. SCOPE + SHAPE: attempt the grant ───────────────────────────────────
  const endMs = Date.now() + 24 * 3600e3;
  r = await rc('POST', `${base}/customers/${encodeURIComponent(UID)}/actions/grant_entitlement`,
               { entitlement_id: ENT, end_time_ms: endMs });
  console.log(`\nGRANT               HTTP ${r.status}`);
  if (r.status === 403) {
    console.error('  403 — the key lacks customer_information:customers:read_write.');
    console.error('  SCOPE problem, not an API-version problem. Mint a key with write scope.');
    console.error(`  body: ${JSON.stringify(r.body).slice(0, 300)}`);
    process.exit(1);
  }
  if (r.status >= 300) {
    console.error(`  body: ${JSON.stringify(r.body).slice(0, 500)}`);
    console.error('  Not a 403, so the key has scope — this is a SHAPE problem. Use the error');
    console.error('  above to correct the request body; do not guess at it.');
    process.exit(1);
  }
  console.log('  granted ✓  (key carries write scope, body shape accepted)');

  // ── 2. ENTITLED: does RC itself report it? ────────────────────────────────
  r = await rc('GET', `${base}/customers/${encodeURIComponent(UID)}`);
  console.log(`\nENTITLED            HTTP ${r.status}`);
  console.log(`  ${JSON.stringify(r.body).slice(0, 300)}`);

  // ── 3. WEBHOOK: the unknown that decides whether the reward is visible ────
  console.log('\nWEBHOOK             polling our sink for 90s…');
  let hook = null;
  for (let i = 0; i < 18; i++) {
    await sleep(5000);
    const rows = await supa('analytics_events?event=eq.rc_webhook_received&select=props,created_at&order=created_at.desc&limit=40');
    if (rows && rows.length) { hook = rows.find((x) => JSON.stringify(x.props || {}).includes(UID)); if (hook) break; }
    process.stdout.write('.');
  }
  console.log('');
  if (hook) {
    console.log(`  ARRIVED: ${JSON.stringify(hook.props)}`);
    console.log('  -> a grant DOES emit a webhook; the normal tier path applies and the reward is visible.');
  } else {
    console.log('  NONE within 90s.');
    console.log('  -> a grant does NOT reliably emit one. The referral must therefore write our own');
    console.log('     entitlement fields at grant time, or rely on the grant-only self-heal to');
    console.log('     reconcile on the next gated request. Do not ship assuming the webhook exists —');
    console.log('     a reward the user cannot see is worse than no reward.');
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  r = await rc('POST', `${base}/customers/${encodeURIComponent(UID)}/actions/revoke_granted_entitlement`,
               { entitlement_id: ENT });
  console.log(`\ncleanup revoke      HTTP ${r.status} ${r.status < 300 ? '✓' : JSON.stringify(r.body).slice(0, 200)}`);
})();

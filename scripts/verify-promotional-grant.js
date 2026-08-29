#!/usr/bin/env node
'use strict';
// PROMOTIONAL-GRANT VERIFICATION — runs SERVER-SIDE, where the key already is.
//
// Deliberately not runnable from a laptop: REVENUECAT_SECRET_KEY should exist
// in as few places as possible, so this reads it from the environment it is
// already in rather than being handed a copy. Run it in the Render shell.
//
// THE QUESTION IT ANSWERS. The referral reward will be granted as a RevenueCat
// promotional entitlement. RevenueCat's docs do not state whether a promotional
// grant emits a webhook. That matters more than it sounds: if it does NOT, then
// `profiles.tier` never flips, the user is entitled at RevenueCat and free in
// our app, and they see nothing for a referral they earned. That is an
// entitlement orphan created by design — the exact class the purchase verifier
// exists to catch, arriving through a new door.
//
// Three legs, same as the purchase verifier:
//   1. GRANT     RevenueCat accepts the promotional grant
//   2. WEBHOOK   an event reaches /api/revenuecat/webhook (or provably does not)
//   3. ENTITLED  RevenueCat itself reports the entitlement active
//
// SAFETY: grants to a synthetic app_user_id that is not a real profile, and
// revokes at the end. It never touches a paying customer.
//
//   Usage:  node scripts/verify-promotional-grant.js [entitlement_id]
//   Needs:  REVENUECAT_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const https = require('https');

const KEY = process.env.REVENUECAT_SECRET_KEY;
const ENT = process.argv[2] || 'pro';
const SUPA = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const UID = `promo-verify-${Date.now()}`;

if (!KEY) {
  console.error('CANNOT RUN — REVENUECAT_SECRET_KEY is not in this environment.');
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
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (r) => {
      let d = ''; r.on('data', (c) => (d += c));
      r.on('end', () => { let j = {}; try { j = d ? JSON.parse(d) : {}; } catch { j = { raw: d.slice(0, 300) }; }
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

(async () => {
  const endMs = Date.now() + 24 * 3600e3;
  console.log(`synthetic subscriber: ${UID}`);
  console.log(`entitlement: ${ENT}   grant until: ${new Date(endMs).toISOString()}`);

  // ── LEG 1: grant ──────────────────────────────────────────────────────────
  // end_time_ms is the current form; the `duration` strings are deprecated.
  let r = await rc('POST', `/v1/subscribers/${encodeURIComponent(UID)}/entitlements/${encodeURIComponent(ENT)}/promotional`,
                   { end_time_ms: endMs });
  console.log(`\nLEG 1 GRANT      HTTP ${r.status}`);
  if (r.status >= 300) {
    console.error(`  FAILED: ${JSON.stringify(r.body).slice(0, 300)}`);
    console.error('  If this is 404, the entitlement identifier is wrong — check the RC dashboard.');
    process.exit(1);
  }
  console.log('  granted ✓');

  // ── LEG 3 first (it is instant): does RC itself report it active? ─────────
  r = await rc('GET', `/v1/subscribers/${encodeURIComponent(UID)}`);
  const ents = (r.body && r.body.subscriber && r.body.subscriber.entitlements) || {};
  const active = ents[ENT];
  console.log(`\nLEG 3 ENTITLED   HTTP ${r.status}`);
  console.log(active
    ? `  RevenueCat reports '${ENT}' active until ${active.expires_date} ✓`
    : `  RevenueCat does NOT report '${ENT}' — grant did not take effect`);

  // ── LEG 2: did a webhook reach us? ────────────────────────────────────────
  // This is the unknown. Poll our own sink for a row naming this subscriber.
  console.log('\nLEG 2 WEBHOOK    polling our sink for 90s…');
  let hook = null;
  for (let i = 0; i < 18; i++) {
    await sleep(5000);
    const rows = await supa(`analytics_events?event=eq.rc_webhook_received&select=props,created_at&order=created_at.desc&limit=40`);
    if (rows && rows.length) {
      hook = rows.find((x) => JSON.stringify(x.props || {}).includes(UID));
      if (hook) break;
    }
    process.stdout.write('.');
  }
  console.log('');
  if (hook) {
    console.log(`  webhook ARRIVED: ${JSON.stringify(hook.props)}`);
    console.log('  -> a promotional grant DOES emit a webhook. The normal tier path applies.');
  } else {
    console.log('  NO webhook within 90s.');
    console.log('  -> a promotional grant does NOT reliably emit one. Consequence: profiles.tier');
    console.log('     will not flip on its own, so the referral MUST write the grant to our own');
    console.log('     entitlement fields too, or rely on the grant-only self-heal to reconcile on');
    console.log('     the next gated request. Do not ship the reward assuming the webhook exists.');
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  r = await rc('POST', `/v1/subscribers/${encodeURIComponent(UID)}/entitlements/${encodeURIComponent(ENT)}/revoke_promotionals`);
  console.log(`\ncleanup revoke   HTTP ${r.status} ${r.status < 300 ? '✓' : JSON.stringify(r.body).slice(0, 160)}`);
  console.log('\nVERDICT: leg 2 is the answer we needed — see above.');
})();

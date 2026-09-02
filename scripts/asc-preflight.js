'use strict';
// asc-preflight — refuse to submit against a stale premise.
//
// WHY THIS EXISTS
// The ship scripts hardcode their version and build ("ship 1.3.19 / 237") and
// were written against the App Store state of the hour they were authored. Days
// later that state has moved, but the script has not: asc-ship-1319.js would
// still happily try to submit build 237 when 1.3.19 is long since
// READY_FOR_SALE and a NEWER version is already sitting in review. Firing it
// would at best no-op and at worst disturb an in-flight submission carrying
// work the stale one does not have.
//
// A conditional written against "1.3.18 is READY_FOR_SALE => the slot is free"
// is the same bug in prose: the observation was true, the INFERENCE expired.
// The slot is free only if nothing newer is queued, and that has to be READ,
// not remembered.
//
// So every ship script calls this first. It answers one question against LIVE
// ASC state: may THIS version/build be submitted right now?
const fs = require('fs'), crypto = require('crypto'), https = require('https');

const KID = '6UXQ2STG2D', ISS = '64bc4b23-6b09-469c-967c-8a87a619dacb', APP = '6762497454';

function jwt() {
  const p8 = fs.readFileSync(process.env.HOME + '/.appstoreconnect/private_keys/AuthKey_6UXQ2STG2D.p8', 'utf8');
  const n = Math.floor(Date.now() / 1e3), b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = b({ alg: 'ES256', kid: KID, typ: 'JWT' });
  const p = b({ iss: ISS, iat: n, exp: n + 600, aud: 'appstoreconnect-v1' });
  return h + '.' + p + '.' + crypto.sign('SHA256', Buffer.from(h + '.' + p), { key: p8, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}

function get(path) {
  return new Promise((res) => {
    https.get({ host: 'api.appstoreconnect.apple.com', path: encodeURI(path), headers: { Authorization: 'Bearer ' + jwt() } },
      (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch { res({}); } }); })
      .on('error', () => res({}));
  });
}

// States that mean "this version is done" — resubmitting is meaningless.
const TERMINAL = new Set(['READY_FOR_SALE', 'PENDING_DEVELOPER_RELEASE', 'PENDING_APPLE_RELEASE', 'REPLACED_WITH_NEW_VERSION']);
// States that mean a slot is genuinely occupied.
const IN_FLIGHT = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_APPLE_RELEASE']);
// States that need a human decision before anything else is submitted.
const NEEDS_DECISION = new Set(['REJECTED', 'DEVELOPER_REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY']);

const cmp = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};

/** Throws (exit 1) unless `version` may be submitted right now. */
async function assertSubmittable(version) {
  const j = await get(`/v1/apps/${APP}/appStoreVersions?limit=10&fields[appStoreVersions]=versionString,appStoreState`);
  const vers = (j.data || []).map((d) => ({ v: d.attributes.versionString, s: d.attributes.appStoreState, id: d.id }));
  if (!vers.length) {
    console.error('asc-preflight: BLOCK — could not read App Store state. Cannot promise a free slot from a failed read.');
    process.exit(2);
  }
  console.log('asc-preflight: live state —');
  for (const x of vers.slice(0, 5)) console.log(`   ${x.v.padEnd(9)} ${x.s}`);

  const me = vers.find((x) => x.v === version);
  if (me && TERMINAL.has(me.s)) {
    console.error(`asc-preflight: BLOCK — ${version} is already ${me.s}. This script's premise expired; nothing to submit.`);
    process.exit(1);
  }
  const decision = vers.find((x) => NEEDS_DECISION.has(x.s));
  if (decision) {
    console.error(`asc-preflight: BLOCK — ${decision.v} is ${decision.s}. A rejection needs a decision about WHY before anything else is submitted.`);
    process.exit(1);
  }
  const newer = vers.find((x) => IN_FLIGHT.has(x.s) && cmp(x.v, version) > 0);
  if (newer) {
    console.error(`asc-preflight: BLOCK — ${newer.v} is ${newer.s}, which is NEWER than ${version}.`);
    console.error('   Submitting an older build now would displace work already queued. The slot is not free.');
    process.exit(1);
  }
  const same = vers.find((x) => x.v === version && IN_FLIGHT.has(x.s));
  if (same) {
    console.error(`asc-preflight: BLOCK — ${version} is already ${same.s}. Re-submitting would duplicate it.`);
    process.exit(1);
  }
  console.log(`asc-preflight: OK — ${version} may be submitted.`);
  return vers;
}

module.exports = { assertSubmittable, get, jwt, APP };

if (require.main === module) {
  const v = process.argv[2];
  if (!v) { console.error('usage: asc-preflight.js <versionString>'); process.exit(2); }
  assertSubmittable(v).catch((e) => { console.error('asc-preflight: BLOCK —', String(e)); process.exit(2); });
}

'use strict';
// asc-ship.js — the ONE way to submit a build. Replaces the per-version scratch
// scripts (asc-ship-1317/1318/1319/1320.js) and the hardcoded if/else that
// wrapped them.
//
// WHY THE BRANCHES WERE THE BUG
// The runbook said, in prose: "if 1.3.18 is READY_FOR_SALE the review slot is
// free, so submit 1.3.19." That was true the hour it was written. Days later
// 1.3.19 had shipped and 1.3.21 was in review, and the same instruction now
// meant "submit a two-build-old binary over queued work." The observation was
// correct; the INFERENCE expired, silently, with nothing to notice it.
//
// A condition about the world has to be evaluated against the world. So the
// branch logic lives here, reads live App Store state every run, and there is
// no version hardcoded anywhere.
//
//   node scripts/asc-ship.js --decide              what should happen right now
//   node scripts/asc-ship.js 1.3.22 240            submit that version+build
//
// --decide is the form a recurring runbook should call: it answers "is there
// anything to submit, and what" without needing the caller to know the state.
const https = require('https');
const { assertSubmittable, get, jwt, APP } = require('./asc-preflight.js');

function send(path, method, body) {
  const data = body ? JSON.stringify(body) : null;
  return new Promise((res) => {
    const o = {
      host: 'api.appstoreconnect.apple.com', path: encodeURI(path), method,
      headers: {
        Authorization: 'Bearer ' + jwt(), 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const rq = https.request(o, (y) => {
      let d = ''; y.on('data', (c) => d += c);
      y.on('end', () => { try { res({ status: y.statusCode, body: d ? JSON.parse(d) : null }); } catch { res({ status: y.statusCode, body: d }); } });
    });
    rq.on('error', (e) => res({ status: 0, body: String(e) }));
    if (data) rq.write(data);
    rq.end();
  });
}

const IN_FLIGHT = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_APPLE_RELEASE']);
const NEEDS_DECISION = new Set(['REJECTED', 'DEVELOPER_REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY']);

async function decide() {
  const j = await get(`/v1/apps/${APP}/appStoreVersions?limit=10&fields[appStoreVersions]=versionString,appStoreState`);
  const vers = (j.data || []).map((d) => ({ v: d.attributes.versionString, s: d.attributes.appStoreState }));
  if (!vers.length) { console.log('DECIDE: UNKNOWN — could not read App Store state. Do nothing; an unreadable API is not a free slot.'); process.exit(2); }
  for (const x of vers.slice(0, 5)) console.log(`   ${x.v.padEnd(9)} ${x.s}`);

  const stuck = vers.find((x) => NEEDS_DECISION.has(x.s));
  if (stuck) { console.log(`\nDECIDE: HOLD — ${stuck.v} is ${stuck.s}. A rejection needs a decision about why before anything is submitted.`); return; }
  const flight = vers.find((x) => IN_FLIGHT.has(x.s));
  if (flight) { console.log(`\nDECIDE: NOTHING TO DO — ${flight.v} is ${flight.s}. The slot is occupied by the newest work.`); return; }
  const pending = vers.find((x) => x.s === 'PENDING_DEVELOPER_RELEASE');
  if (pending) { console.log(`\nDECIDE: HOLD — ${pending.v} is approved and awaiting a MANUAL release. Submitting now would displace an approved-but-unreleased build.`); return; }
  console.log('\nDECIDE: SLOT FREE — nothing queued. Submit the newest uploaded build with:');
  console.log('   node scripts/asc-ship.js <version> <build>');
}

async function ship(version, buildNum) {
  await assertSubmittable(version);                       // blocks on a stale premise

  const b = await get(`/v1/builds?filter[app]=${APP}&sort=-uploadedDate&limit=20&fields[builds]=version,processingState`);
  // NOTE: /v1/builds?filter[app]&sort=-uploadedDate — the apps-scoped limit=10
  // form silently returns the wrong ordering and has cost hours. Do not simplify.
  const build = (b.data || []).find((x) => x.attributes.version === String(buildNum));
  if (!build) { console.error(`asc-ship: build ${buildNum} not found among the 20 most recent uploads.`); process.exit(1); }
  if (build.attributes.processingState !== 'VALID') { console.error(`asc-ship: build ${buildNum} is ${build.attributes.processingState}, not VALID.`); process.exit(1); }

  const vj = await get(`/v1/apps/${APP}/appStoreVersions?limit=10&fields[appStoreVersions]=versionString,appStoreState`);
  let ver = (vj.data || []).find((x) => x.attributes.versionString === version);
  if (!ver) {
    const c = await send('/v1/appStoreVersions', 'POST', {
      data: { type: 'appStoreVersions', attributes: { platform: 'IOS', versionString: version },
        relationships: { app: { data: { type: 'apps', id: APP } } } },
    });
    if (c.status !== 201) { console.error('asc-ship: create version failed', c.status, JSON.stringify(c.body).slice(0, 300)); process.exit(1); }
    ver = c.body.data;
    console.log(`asc-ship: created version ${version}`);
  }
  const r1 = await send(`/v1/appStoreVersions/${ver.id}/relationships/build`, 'PATCH', { data: { type: 'builds', id: build.id } });
  if (r1.status >= 300) { console.error('asc-ship: attach build failed', r1.status); process.exit(1); }

  const sub = await send('/v1/reviewSubmissions', 'POST', {
    data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: APP } } } },
  });
  if (sub.status !== 201) { console.error('asc-ship: create submission failed', sub.status, JSON.stringify(sub.body).slice(0, 300)); process.exit(1); }
  const subId = sub.body.data.id;
  const item = await send('/v1/reviewSubmissionItems', 'POST', {
    data: { type: 'reviewSubmissionItems', relationships: {
      reviewSubmission: { data: { type: 'reviewSubmissions', id: subId } },
      appStoreVersion: { data: { type: 'appStoreVersions', id: ver.id } } } },
  });
  if (item.status !== 201) { console.error('asc-ship: add item failed', item.status); process.exit(1); }
  const done = await send(`/v1/reviewSubmissions/${subId}`, 'PATCH', { data: { type: 'reviewSubmissions', id: subId, attributes: { submitted: true } } });
  if (done.status >= 300) { console.error('asc-ship: submit failed', done.status); process.exit(1); }

  // VERIFY INDEPENDENTLY — a 200 on the PATCH is not proof of state.
  const chk = await get(`/v1/appStoreVersions/${ver.id}?fields[appStoreVersions]=versionString,appStoreState`);
  const bchk = await get(`/v1/appStoreVersions/${ver.id}/build?fields[builds]=version`);
  console.log(`asc-ship: VERIFIED — ${chk.data?.attributes?.versionString} is ${chk.data?.attributes?.appStoreState}` +
              ` with build ${bchk.data?.attributes?.version} attached. submission=${subId}`);
}

const [a, bnum] = process.argv.slice(2);
if (!a || a === '--decide') decide().catch((e) => { console.error(String(e)); process.exit(2); });
else if (!bnum) { console.error('usage: asc-ship.js <version> <build>   |   asc-ship.js --decide'); process.exit(2); }
else ship(a, bnum).catch((e) => { console.error(String(e)); process.exit(2); });

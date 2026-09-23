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
// WHO rejected it. Apple's verdicts are REJECTED / METADATA_REJECTED /
// INVALID_BINARY; DEVELOPER_REJECTED is set when WE cancel our own submission.
// The distinction only matters at the SAME version — see the withdraw-and-
// replace block below. Everywhere else both are simply "needs a decision".
const SELF_WITHDRAWN = 'DEVELOPER_REJECTED';

/** Where a human records that Resolution Center was clear when we withdrew. */
const DECISIONS_FILE = __dirname + '/asc-rejection-decisions.json';

function readConfirmation(version) {
  try {
    const all = JSON.parse(fs.readFileSync(DECISIONS_FILE, 'utf8'));
    return all[version] || null;
  } catch { return null; }   // absent or unparseable == unconfirmed, which blocks
}

/**
 * May a SELF-WITHDRAWN version be resubmitted with a new build?
 *
 * PURE ON PURPOSE. Every input is passed in, so the three conditions can be
 * RED-proved directly instead of by fabricating live App Store state — the
 * cases that must block (an Apple verdict, a build that does not advance, a
 * missing confirmation) are exactly the ones that are hard to stage for real.
 *
 * All three must hold. Each closes a different hole:
 *   - state is ours, not Apple's      — an Apple verdict is nobody's decision here
 *   - the item was REMOVED, not REJECTED — a reviewer never acted on it
 *   - the build strictly advances     — re-sending one artifact decides nothing
 *   - a DATED human confirmation      — the one thing the API cannot tell us is
 *     whether a reviewer wrote to us in Resolution Center before we pulled it.
 *     It is pinned to the withdrawn BUILD so a confirmation cannot be reused
 *     for a later withdrawal it was never about.
 */
function decideSelfWithdrawn(f) {
  const no = (reason) => ({ allow: false, reason });
  if (f.state !== SELF_WITHDRAWN) return no(`${f.version} is ${f.state} — an Apple verdict, not our withdrawal`);
  if (f.itemState !== 'REMOVED') return no(`the submission item is ${f.itemState}, not REMOVED — a reviewer acted on it`);
  // A FAILED READ IS NOT BUILD ZERO. Number(null) and Number('') are both 0,
  // which would sail past the strictly-greater test below as "build 0" and let
  // an unreadable attached build authorize the submission. Demand real digits
  // before coercing anything. (Caught by the RED suite: the unreadable-build
  // case was blocking on the confirmation mismatch instead of on this.)
  const digits = (x) => /^\d+$/.test(String(x == null ? '' : x).trim());
  if (!digits(f.buildNum) || !digits(f.attachedBuild)) {
    return no(`build numbers unreadable (submitting ${JSON.stringify(f.buildNum)}, withdrawn ${JSON.stringify(f.attachedBuild)}); a failed read is not a free slot`);
  }
  const next = Number(f.buildNum), withdrawn = Number(f.attachedBuild);
  if (!(next > withdrawn)) return no(`build ${f.buildNum} does not replace withdrawn build ${f.attachedBuild}`);
  const c = f.confirmation;
  if (!c) return no(`no Resolution Center confirmation recorded for ${f.version} in ${DECISIONS_FILE}`);
  // ASKED FOR IS NOT ANSWERED. A record may exist while the human check is still
  // outstanding — that is the honest state to be in, and it must not read as a
  // confirmation. Fail closed: anything that is not exactly "confirmed",
  // including a record predating this field, is not one.
  if (c.status !== 'confirmed') {
    return no(`the recorded Resolution Center check is "${c.status || 'unset'}", not confirmed` +
      (c.attestation ? ` — ${c.attestation}` : ''));
  }
  if (String(c.withdrawnBuild) !== String(f.attachedBuild)) {
    return no(`the recorded confirmation is about build ${c.withdrawnBuild}, but build ${f.attachedBuild} was withdrawn`);
  }
  // A date, or a full ISO timestamp. Anchored to YYYY-MM-DD alone this would
  // reject the very confirmation it is waiting for, since the answer is meant
  // to be recorded with its timestamp.
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/.test(String(c.confirmedDate || ''))) {
    return no('the recorded confirmation carries no valid date');
  }
  if (!String(c.confirmedBy || '').trim()) return no('the recorded confirmation names nobody');
  return {
    allow: true,
    line: `we withdrew build ${f.attachedBuild} and build ${f.buildNum} replaces it; ` +
      `Resolution Center confirmed clear by ${c.confirmedBy} on ${c.confirmedDate}` +
      (c.resolutionCenter ? ` — "${c.resolutionCenter}"` : ''),
  };
}

const cmp = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};

/** Throws (exit 1) unless `version` may be submitted right now. */
async function assertSubmittable(version, buildNum) {
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
  // A rejection on an OLDER version is not an open question — replacing it with
  // a newer submission IS the decision, and that is the ordinary withdraw-and-
  // replace path. As written this blocked on ANY needs-decision version at any
  // age, so a single DEVELOPER_REJECTED wedged every future submission forever:
  // 1.3.35 withdrawn deliberately would have blocked 1.3.36, 1.3.37 and the rest
  // until someone edited state by hand. The guard is right that a rejection must
  // not be stepped over silently, so an older one is NAMED loudly and allowed;
  // one at or newer than the version being submitted still blocks, because there
  // the rejection really is about the work in front of you.
  //
  // ONE EXCEPTION, AT THE SAME VERSION: a submission WE withdrew, being replaced
  // by a strictly NEWER BUILD. Withdraw-and-replace does not always increment
  // the version — pulling 1.3.38/258 to ship 1.3.38/259 is the same manoeuvre
  // the paragraph above already allows, performed on the build instead. The
  // version state cannot express that, so this read it as an unresolved
  // rejection and wedged the very replacement it exists to permit.
  //
  // Narrow on purpose: `decideSelfWithdrawn` requires ALL of our-withdrawal,
  // item REMOVED, a strictly higher build, and a DATED human confirmation that
  // Resolution Center was clear. Called without a build (the bare CLI form) it
  // cannot know a replacement exists, so it blocks exactly as before.
  let pass = null;
  const mine = buildNum == null ? null : vers.find((x) => x.v === version && x.s === SELF_WITHDRAWN);
  if (mine) {
    const bj = await get(`/v1/appStoreVersions/${mine.id}/build?fields[builds]=version`);
    if (!bj.data) {
      console.error(`asc-preflight: BLOCK — ${version} is ${SELF_WITHDRAWN} and its attached build could not be read.`);
      console.error('   A failed read is not a free slot.');
      process.exit(2);
    }
    // The item state is the discriminating field: REMOVED is us pulling it,
    // REJECTED is a reviewer. A failed read must not read as REMOVED.
    const sj = await get(`/v1/reviewSubmissions?filter[app]=${APP}&limit=10&include=items`);
    let itemState = null;
    for (const sub of (sj.data || [])) {
      const ij = await get(`/v1/reviewSubmissions/${sub.id}/items?limit=10&include=appStoreVersion`);
      for (const it of (ij.data || [])) {
        const rel = it.relationships && it.relationships.appStoreVersion;
        if (rel && rel.data && rel.data.id === mine.id) itemState = it.attributes.state;
      }
      if (itemState) break;
    }
    if (!itemState) {
      console.error(`asc-preflight: BLOCK — ${version} is ${SELF_WITHDRAWN} and its submission item state could not be read.`);
      process.exit(2);
    }
    const d = decideSelfWithdrawn({
      version, buildNum, state: mine.s,
      attachedBuild: bj.data.attributes.version,
      itemState,
      confirmation: readConfirmation(version),
    });
    if (!d.allow) {
      console.error(`asc-preflight: BLOCK — ${version} is ${SELF_WITHDRAWN}, and ${d.reason}.`);
      process.exit(1);
    }
    pass = d;
    console.log(`asc-preflight: NAMED — ${version}: ${d.line}. That replacement IS the decision.`);
  }
  const decision = vers.find((x) => NEEDS_DECISION.has(x.s) && cmp(x.v, version) >= 0
    && !(pass && x.v === version && x.s === SELF_WITHDRAWN));
  const olderRejected = vers.filter((x) => NEEDS_DECISION.has(x.s) && cmp(x.v, version) < 0);
  for (const o of olderRejected) {
    console.log(`asc-preflight: NOTE — ${o.v} is ${o.s} (older than ${version}). ` +
      'Treating this submission as the decision about it. If that is NOT why it was ' +
      'rejected, stop and resolve it before shipping over the top.');
  }
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

module.exports = { assertSubmittable, get, jwt, APP, decideSelfWithdrawn, readConfirmation, SELF_WITHDRAWN };

if (require.main === module) {
  const v = process.argv[2];
  if (!v) { console.error('usage: asc-preflight.js <versionString>'); process.exit(2); }
  assertSubmittable(v).catch((e) => { console.error('asc-preflight: BLOCK —', String(e)); process.exit(2); });
}

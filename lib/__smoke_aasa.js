'use strict';
// GATE: the referral link must be able to open the app.
//
// MEASURED FAILURE THIS GATE EXISTS FOR (2026-08-29). Referral attribution was
// 0% ALL TIME — 57 distinct users shared an invite link, 14 opened one, and
// ZERO were ever attributed. Not a leaky funnel: a closed circuit. The share
// URL is https://usepromptly.app/?ref=CODE, but /apple-app-site-association
// returned 404 and the app declared no associated-domains, so the link could
// never reach the app — not after a fresh install, and not even for users who
// already had it installed. ReferralService's own header noted "universal links
// when the entitlement + AASA ship". They never shipped, and nothing failed.
//
// A referral link that cannot open the app should break a build, not sit live
// for months while users share it.
//
// NOTE ON SCOPE: this asserts the SERVER half. The client half (the
// `associated-domains` entitlement) cannot be checked from here because it
// lives in the iOS repo path and ships on its own cadence — it is asserted by
// the iOS-side gate. Both halves are required; either alone attributes nobody.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEAM = '8KT9332327';
const BUNDLE = 'app.usepromptly.ios';
const APP_ID = `${TEAM}.${BUNDLE}`;

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ── 1. the route exists, at the path Apple actually fetches ─────────────────
assert.ok(server.includes("'/.well-known/apple-app-site-association'"),
  'server.js must serve /.well-known/apple-app-site-association — Apple fetches exactly this path');

// ── 2. the payload is well-formed and names THIS app ────────────────────────
// Extract the object the route serves and prove it parses. A malformed AASA
// fails silently on device: iOS just never associates the domain.
const m = server.match(/JSON\.stringify\(\{\s*applinks:[\s\S]*?\n    \}\);/);
assert.ok(m, 'could not locate the AASA payload in server.js');
const payloadSrc = m[0].replace(/^JSON\.stringify\(/, '').replace(/\);$/, '');
let payload;
assert.doesNotThrow(() => { payload = eval('(' + payloadSrc + ')'); },
  'the AASA payload must be valid — a malformed one fails silently on device');

const details = payload.applinks && payload.applinks.details;
assert.ok(Array.isArray(details) && details.length, 'applinks.details must be a non-empty array');
assert.ok(details[0].appIDs.includes(APP_ID),
  `appIDs must contain ${APP_ID} — a wrong team or bundle id associates nothing, silently`);

// ── 3. it matches referral links, and ONLY referral links ───────────────────
// A bare "/" match would make every marketing page open the app, which is a
// worse bug than the one this fixes.
const comps = details[0].components;
assert.ok(Array.isArray(comps) && comps.length, 'components must be present');
const refComp = comps.find((c) => c['?'] && c['?'].ref);
assert.ok(refComp, 'a component must match the ?ref= query — that is the invite link');
const unscoped = comps.find((c) => c['/'] === '*' || (c['/'] === '/' && !c['?']));
assert.ok(!unscoped,
  'no component may match the whole site: that would open the app for every marketing page');

// ── 4. Content-Type, because the wrong one is ignored by iOS ────────────────
const routeBlock = server.slice(server.indexOf("'/.well-known/apple-app-site-association'"));
assert.ok(/Content-Type'?\s*:\s*'application\/json'/.test(routeBlock.slice(0, 1600)),
  "the AASA must be served as application/json — iOS ignores other content types");

// ── 5. and it must not be behind a redirect ─────────────────────────────────
assert.ok(!/writeHead\(\s*30\d/.test(routeBlock.slice(0, 1600)),
  'the AASA must not redirect — Apple does not follow redirects when fetching it');

console.log(`aasa smoke: PASS — ${APP_ID} associated, scoped to ?ref= invite links, served as JSON without redirect.`);

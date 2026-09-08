'use strict';
// GATE (2026-09-07) — /validate is the ONE worker endpoint the app calls
// directly, with no server proxy in front of it. It therefore sent no
// `_worker_auth` and 11 of 11 real calls arrived missing: an unauthenticated
// GPU endpoint anyone can bill us for.
//
// Two halves have to agree, in two languages, across two repos' worth of
// review, or the field silently does nothing:
//   • the SERVER hands the app a secret, on an AUTHENTICATED response;
//   • the APP sends it back under the exact field name the worker pops.
//
// This runs both halves by execution. The name-drift half is the one a source
// review misses: `_worker_auth` vs `worker_auth` reads identically to a human
// and fails closed at the worker, which is exactly how it would ship as "armed"
// while every call is still rejected.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function check(cond, msg) {
  if (cond) { console.log(`ok   - ${msg}`); }
  else { failures++; console.log(`FAIL - ${msg}`); }
}

// ── 1. THE SECRET RESOLVER, by execution ────────────────────────────────────
const saved = {
  v: process.env.MODAL_VALIDATE_SECRET,
  r: process.env.MODAL_RUN_SECRET,
};
delete process.env.MODAL_VALIDATE_SECRET;
delete process.env.MODAL_RUN_SECRET;
const { clientValidateAuth, WORKER_AUTH_FIELD, workerAuthField } =
  require('./video-processor/dispatch-to-modal');

check(clientValidateAuth() === null,
      'no secret set -> null, so the field is OMITTED rather than sent empty');

process.env.MODAL_RUN_SECRET = 'run-secret';
check(clientValidateAuth() === 'run-secret',
      'falls back to MODAL_RUN_SECRET so the client half can ship first');

process.env.MODAL_VALIDATE_SECRET = 'validate-secret';
check(clientValidateAuth() === 'validate-secret',
      'MODAL_VALIDATE_SECRET WINS — sharing run_job’s secret means an extraction '
      + 'from the app also buys arbitrary GPU dispatch');

process.env.MODAL_VALIDATE_SECRET = '   ';
check(clientValidateAuth() === 'run-secret',
      'a whitespace-only secret is not a secret; it falls through');

process.env.MODAL_VALIDATE_SECRET = saved.v === undefined ? '' : saved.v;
if (saved.v === undefined) delete process.env.MODAL_VALIDATE_SECRET;
process.env.MODAL_RUN_SECRET = saved.r === undefined ? '' : saved.r;
if (saved.r === undefined) delete process.env.MODAL_RUN_SECRET;

// ── 2. ONE FIELD NAME, and the app spells it the same ───────────────────────
process.env.MODAL_RUN_SECRET = 'x';
const proxied = workerAuthField();
delete process.env.MODAL_RUN_SECRET;
check(Object.keys(proxied)[0] === WORKER_AUTH_FIELD,
      `the proxied dispatch uses ${WORKER_AUTH_FIELD}`);

const api = fs.readFileSync(
  path.join(ROOT, 'ios/Promptly/Promptly/Services/APIService.swift'), 'utf8');
const stripSwift = (src) => src.replace(/^\s*\/\/.*$/gm, '');
const strip = stripSwift;
const validateFn = stripSwift(api).slice(
  stripSwift(api).indexOf('func validateVideo(sampleS3Url:'),
  stripSwift(api).indexOf('func createVideoJob('));
check(validateFn.length > 0, 'validateVideo is still findable in APIService');
check(validateFn.includes(`body["${WORKER_AUTH_FIELD}"] = workerAuth`),
      `the app sends ${WORKER_AUTH_FIELD} — the same name the worker pops`);
check(!/setValue\([^)]*workerAuth/.test(validateFn),
      'carried in the BODY, not a header — Modal cannot import fastapi at deploy '
      + 'time, which is why run_job uses the body');

// ── 3. FAILS OPEN. Layer 2 is an optimisation; every build already in the
//    field predates this field, so arming the worker rejects them. Blocking
//    uploads on a validation service would be far worse than skipping it.
check(/if let workerAuth \{ body\["_worker_auth"\] = workerAuth \}/.test(validateFn),
      'the field is conditional — an unknown token still sends the call');

// ── 4. THE SECRET IS NOT IN THE BINARY. It rides an AUTHENTICATED response,
//    so it is rotatable without an App Store release — which matters because a
//    baked-in value could never be rotated for builds already in the field.
// COMMENTS ARE NOT CODE. The first version of this check was failed by the
// doc comment that explains it — the same shape that once let auth-seam-gate be
// satisfied by its own prose.
const usage = strip(fs.readFileSync(
  path.join(ROOT, 'ios/Promptly/Promptly/Services/UsageService.swift'), 'utf8'));
check(/let validate_token: String\?/.test(usage),
      'the app reads the token from the /api/usage snapshot');
check(!/UserDefaults/.test(usage),
      'UsageService still persists nothing — the token cannot land in a plist or a backup');

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const usageHandler = server.slice(
  server.indexOf("parsed.pathname === '/api/usage'"),
  server.indexOf("parsed.pathname === '/api/usage'") + 14000);
check(/requireSupabaseUser\(req\)/.test(usageHandler),
      'the carrier response is behind requireSupabaseUser');
check(/validate_token: clientValidateAuth\(\)/.test(usageHandler),
      'the handler emits validate_token from the shared resolver');

// THE ONE THAT WOULD HAVE PUBLISHED IT. /api/health is public; carrying the
// secret there would hand it to the world — strictly worse than sending none.
const healthIdx = server.indexOf('first_session_autopicker:');
const healthRegion = server.slice(Math.max(0, healthIdx - 6000), healthIdx + 6000);
check(!/validate_token/.test(healthRegion),
      'the token is NOT on the public /api/health payload');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — validate worker-auth, both halves`);
process.exit(failures === 0 ? 0 : 1);

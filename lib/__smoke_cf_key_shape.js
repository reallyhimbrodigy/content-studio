'use strict';

// A KEY PAIR ID THAT IS NOT A KEY PAIR ID (live P0, 2026-08-23)
//
// CLOUDFRONT_KEY_PAIR_ID was set to the PUBLIC KEY PEM. Every presence check in
// the stack passed — signedMode true, signer loaded, canSign true, a 344-char
// Signature produced — and CloudFront rejected all of it:
//
//     <Error><Code>MissingKey</Code>
//     <Message>Missing Key-Pair-Id query parameter or cookie value</Message>
//
// With exports/* behind Restrict-viewer-access that is every paying user locked
// out of their own file, reported by our own health as fully configured. The
// bug is not that a check was missing; it is that every check asked "is it SET?"
// when the only useful question was "what IS it?".
//
// This smoke pins three things, each of which failed independently today:
//   1. the shape test itself rejects a PEM and accepts a real id
//   2. a malformed id DEMOTES out of signed mode (never mints a doomed URL)
//   3. the demotion is LOUD — health can name it, so it is not a silent
//      degrade to S3 presigned that nobody ever notices
//
// The module reads env at require() time, so each case runs in a child process
// with its own env. Mutating process.env in-process would test only whichever
// value happened to be loaded first.

const { execFileSync } = require('child_process');
const path = require('path');

const CF = path.join(__dirname, '..', 'services', 'cloudfront.js');
const REAL_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkUhzI4PpU1xFIsrmu6Gk',
  'dQIDAQAB',
  '-----END PUBLIC KEY-----',
].join('\n');
// Shape only — never a live key. Any RSA PEM would do; the signer is not
// exercised here, only the id classification.
const FAKE_PRIVATE = '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----';

// cloudfront.js logs to stdout at require() time, so the child's output is not
// pure JSON. Parse a sentinel-delimited line instead of the whole stream —
// scraping raw stdout made every case die on the module's own banner.
const MARK = '__CFPROBE__';

function probe(env) {
  const out = execFileSync(
    process.execPath,
    ['-e', `const c=require(${JSON.stringify(CF)});process.stdout.write("\\n${MARK}"+JSON.stringify({s:!!c.signedMode,u:!!c.unsignedMode,m:!!c.keyPairIdMalformed}))`],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CLOUDFRONT_DOMAIN: 'd1iax8jos987n3.cloudfront.net',
        ...env,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const line = out.split('\n').find((l) => l.startsWith(MARK));
  if (!line) throw new Error(`probe produced no ${MARK} line; got: ${out.slice(-200)}`);
  return JSON.parse(line.slice(MARK.length));
}

const failures = [];
function check(name, cond, detail) {
  if (cond) { console.log(`  ok  ${name}`); return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── 1. THE ACTUAL LIVE BUG: a PEM in the id slot ───────────────────────────
const pem = probe({ CLOUDFRONT_KEY_PAIR_ID: REAL_PEM, CLOUDFRONT_PRIVATE_KEY: FAKE_PRIVATE });
check('a PEM in CLOUDFRONT_KEY_PAIR_ID does NOT enter signed mode', pem.s === false,
  'signedMode stayed true — doomed signed URLs would be minted and every export 403s');
check('a PEM in CLOUDFRONT_KEY_PAIR_ID is reported as MALFORMED', pem.m === true,
  'silently indistinguishable from "no CDN key configured"');
check('a malformed id still leaves the CDN reachable (unsigned fallback)', pem.u === true,
  'exports would lose the CDN entirely rather than degrade');

// ── 2. A REAL key pair id must still work ──────────────────────────────────
// The guard is worthless if it also rejects the correct value — that would turn
// a fixable config error into a permanent outage the moment the owner fixes it.
const good = probe({ CLOUDFRONT_KEY_PAIR_ID: 'K2JCJMDEHXQW5F', CLOUDFRONT_PRIVATE_KEY: FAKE_PRIVATE });
check('a well-formed key pair id DOES enter signed mode', good.s === true,
  'the guard rejects valid ids — fixing the config would not restore signing');
check('a well-formed key pair id is not flagged malformed', good.m === false);

// ── 3. Absent id is unsigned but NOT malformed ─────────────────────────────
// These two must never collapse together: one is "not configured yet", the
// other is "configured wrong and actively breaking exports".
const none = probe({ CLOUDFRONT_PRIVATE_KEY: FAKE_PRIVATE });
check('an ABSENT key pair id is unsigned but NOT malformed', none.s === false && none.m === false,
  `signed=${none.s} malformed=${none.m}`);

// ── 4. Near-miss shapes that a lazy regex would wave through ───────────────
for (const [label, val] of [
  ['a whitespace-only id', '   '],
  ['an id with an embedded newline', 'K2JCJMDEH\nXQW5F'],
  ['an id with a trailing PEM fragment', 'K2JCJMDEHXQW5F-----BEGIN'],
]) {
  const r = probe({ CLOUDFRONT_KEY_PAIR_ID: val, CLOUDFRONT_PRIVATE_KEY: FAKE_PRIVATE });
  check(`${label} does not enter signed mode`, r.s === false, 'signedMode true');
}

if (failures.length) {
  console.error(`\n[smoke] FAILED: ${failures.length} CloudFront key-shape assertion(s)`);
  process.exit(1);
}
console.log('[smoke] CloudFront key pair id shape: OK');

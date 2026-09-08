'use strict';
// SMOKE — /api/render accepts only a source THIS user uploaded.
//
// THE HOLE THIS CLOSES. video_url and proxy_video_url came straight off the
// request body, validated by isSafeRemoteMediaUrl alone. That is an SSRF guard
// — it proves the URL is not internal and says nothing about who owns it. So:
//   * any public https URL was accepted and downloaded by the worker, on our
//     compute, at our cost;
//   * another user's source key rendered fine. Measured on 14d of production:
//     one real cross-account render (two accounts, same human) out of 1,887
//     jobs — proof the path was reachable, not merely theoretical.
//
// WHY THIS SMOKE EXECUTES SERVER.JS TEXT INSTEAD OF MATCHING IT. A regex over
// source cannot tell live code from a comment, a string, or a block that was
// moved behind an early return — this session produced nine such false greens,
// one of which inserted a whole rule INSIDE a docstring and passed every check.
// So the guard is extracted from server.js and CALLED, with fakes for its
// collaborators. A deleted, weakened, or unreachable guard changes what this
// test observes, because the test runs the shipped bytes.
const fs = require('fs');
const path = require('path');
const { isOwnedSource } = require('./source-ownership');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const fail = [];
const ok = (c, m) => { if (!c) fail.push(m); };

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const CDN = 'https://d1iax8jos987n3.cloudfront.net/';

// ── PART 1: the predicate, at runtime ──────────────────────────────────────
// Shape drawn from real rows, not invented: the production key format is
// sources/<uuid>/<epoch-ms>-<filename>.
ok(isOwnedSource(CDN + 'sources/' + A + '/1788256272843-clip.mp4', A) === true,
   "a user's OWN upload is rejected — this would block every render");
ok(isOwnedSource(CDN + 'sources/' + B + '/1788256272843-clip.mp4', A) === false,
   "ANOTHER USER'S source key is accepted");
ok(isOwnedSource('https://evil.example.com/movie.mp4', A) === false,
   'an arbitrary internet URL is accepted as a source');
ok(isOwnedSource(CDN + 'renders-private/' + A + '/out.mp4', A) === false,
   'a render output is accepted as a source (only upload prefixes are sources)');
ok(isOwnedSource(CDN + 'sources/' + A + '-evil/x.mp4', A) === false,
   'PATH-PREFIX CONFUSION: `<uid>-evil/` passes for `<uid>` — startsWith instead '
   + 'of an exact segment match');
ok(isOwnedSource(CDN + 'sources//x.mp4', A) === false,
   'an EMPTY owner segment is accepted');
ok(isOwnedSource('not a url', A) === false, 'an unparseable URL is accepted');
ok(isOwnedSource(CDN + 'sources/' + A + '/x.mp4', '') === false,
   'an EMPTY user id is accepted — a missing session would authorise everything');
// Real keys are lowercase uuids; case-insensitivity is deliberate, not accidental.
ok(isOwnedSource(CDN + 'sources/' + A.toUpperCase() + '/x.mp4', A) === true,
   'uuid case sensitivity would reject a legitimate source');

// ── PART 2: the guard as it actually ships, EXECUTED ───────────────────────
// Extract the real for-loop from server.js and run it. Fakes stand in for
// sendJson/console/authUser; everything else is the shipped text.
const m = SRC.match(
  /for \(const \[label, u\] of \[\['video_url'[\s\S]*?\n {8}\}/);
ok(!!m, 'the ownership guard is GONE from server.js (or was restructured) — '
      + 'this smoke cannot find the block it is meant to verify');
if (m) {
  const runGuard = new Function('videoUrl', 'proxyVideoUrl', '_sampleSrc',
    'authUser', 'isOwnedSource', 'sendJson', 'stripQuery', 'console', 'res',
    m[0] + '\n return {status: 200};');
  const call = (videoUrl, proxyVideoUrl, sampleSrc = '') => runGuard(
    videoUrl, proxyVideoUrl, sampleSrc, { id: A }, isOwnedSource,
    (_res, status, body) => ({ status, body }),
    (u) => String(u || '').split('?')[0],
    { warn() {}, log() {} }, {});

  ok(call(CDN + 'sources/' + A + '/clip.mp4', '').status === 200,
     "the guard REJECTS a user's own upload — every render would 403");
  ok(call(CDN + 'sources/' + B + '/clip.mp4', '').status === 403,
     "the guard ACCEPTS another user's source key");
  ok(call('https://evil.example.com/x.mp4', '').status === 403,
     'the guard ACCEPTS an arbitrary internet URL as video_url');

  // The proxy is the parameter that is easy to forget: it is never stored on
  // the job row, yet it is passed to the worker and downloaded there.
  ok(call(CDN + 'sources/' + A + '/clip.mp4',
          'https://evil.example.com/x.mp4').status === 403,
     'the guard ACCEPTS a foreign PROXY url — the same hole under another name');
  ok(call(CDN + 'sources/' + A + '/clip.mp4',
          CDN + 'sources/' + B + '/p.mp4').status === 403,
     "the guard ACCEPTS another user's key as the proxy");
  ok(call(CDN + 'sources/' + A + '/c.mp4', CDN + 'sources/' + A + '/p.mp4')
       .status === 200, 'a legitimate source+proxy pair is rejected');

  // The sample clip is exempt ONLY by exact equality with the server's own env
  // value — a user cannot forge their way into the exemption.
  const SAMPLE = 'https://cdn.example.com/official/sample.mp4';
  ok(call(SAMPLE, '', SAMPLE).status === 200,
     'the configured sample clip is rejected — the demo path would break');
  ok(call(SAMPLE + '?x=1', '', SAMPLE).status === 403,
     'a near-miss on the sample URL is exempted — the exemption is not exact');
  ok(call('https://evil.example.com/x.mp4', '', '').status === 403,
     'with SAMPLE_DEMO_SOURCE_URL unset, an arbitrary URL is exempted');
}

// ── PART 3: the guard runs BEFORE dispatch ─────────────────────────────────
// A correct guard placed after the worker call would prove nothing.
const gi = SRC.indexOf("for (const [label, u] of [['video_url'");
const di = SRC.indexOf('proxyVideoUrl: proxyVideoUrl || null');
ok(gi > 0 && di > gi,
   'the ownership guard does not precede the worker dispatch — a source would '
   + 'be sent to the worker before it is authorised');

if (fail.length) {
  console.error('FAIL __smoke_source_ownership:');
  for (const f of fail) console.error('  - ' + f);
  process.exit(1);
}
console.log('ok __smoke_source_ownership — predicate + shipped guard executed '
  + '(own/foreign/arbitrary/proxy/sample), guard precedes dispatch');

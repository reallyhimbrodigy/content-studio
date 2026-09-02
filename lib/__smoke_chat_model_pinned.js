// THE CHAT MODEL IS PINNED, NEVER AN ALIAS. [Rule 1]
//
// MEASURED: `gemini-flash-latest` is an ALIAS and it ROTATED. The AI Studio
// usage panel shows 1.87K 429s on Aug 8 with ZERO of every other error class,
// and the per-model request curve runs 3.6 Flash -> 3.7 Flash -> ZERO. That is
// the alias moving onto a model with NO PROVISIONED QUOTA on this project: the
// limit is zero, so volume is irrelevant. Chat runs ~0.3 req/min against
// paid-tier limits in the thousands and still 429s on 100% of requests.
//
// SAME CLASS AS THE supabase FLOAT. `supabase>=2,<3` resolved to something
// nobody chose and took editorial down for 11 hours via a package nobody typed.
// A floating model reference does the same thing one service over: the config
// names a moving target, and the damage lands far from the change.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
// CODE ONLY. Comments here necessarily QUOTE the alias to explain the incident,
// and a check that reads its own documentation is not a check — this repo has
// now written that bug eleven times.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// 1. THE LIVE CALL SITES MUST NOT NAME AN ALIAS.
for (const [label, re] of [
  ['/api/chat', /models\/\$\{CHAT_MODEL\}:generateContent/],
  ['/api/chat/stream', /models\/\$\{CHAT_MODEL\}:streamGenerateContent/],
]) {
  assert.ok(re.test(CODE),
    `${label} no longer routes through CHAT_MODEL — a hard-coded model here is how `
    + 'the alias got in, and it will rotate again');
}
// SCOPED TO THE LIVE ROUTE HANDLERS, deliberately. server.js also carries
// DIAGNOSTIC probes that call the alias ON PURPOSE — they exist to test what
// `-latest` currently resolves to, which is the very question this incident
// turns on. My first version of this assertion scanned the whole file and
// flagged those probes as live call sites: a true positive about the CHECK
// being too broad, caught before it shipped. Scope to what serves users.
function handlerSlice(marker) {
  const i = CODE.indexOf(marker);
  assert.ok(i > 0, `route handler not found: ${marker}`);
  return CODE.slice(i, i + 9000);
}
for (const marker of ["parsed.pathname === '/api/chat' &&",
                      "parsed.pathname === '/api/chat/stream' &&"]) {
  const slice = handlerSlice(marker);
  assert.ok(!/models\/gemini-[a-z0-9.]+-latest:(generate|stream)/.test(slice),
    `a *-latest ALIAS is back on a LIVE chat call site (${marker}). Aliases rotate `
    + 'onto models with no provisioned quota — that is exactly what produced 1.87K '
    + '429s with zero other error classes');
}

// 2. THE DEFAULT MUST BE AN EXPLICIT VERSION. The env override exists so the
//    owner can move it from the dashboard without a deploy; the DEFAULT is the
//    thing that ships, and it must never be a moving target.
const m = CODE.match(/CHAT_MODEL\s*=\s*\(process\.env\.CHAT_MODEL\s*\|\|\s*'([^']+)'\)/);
assert.ok(m, 'CHAT_MODEL is no longer declared with an explicit default');
const pinned = m[1];
assert.ok(!/-latest$/.test(pinned),
  `the DEFAULT chat model "${pinned}" is an alias — pin an explicit version`);
assert.ok(/^gemini-\d+(\.\d+)?-[a-z-]+$/.test(pinned),
  `the DEFAULT chat model "${pinned}" does not look like an explicit version `
  + '(expected e.g. gemini-3.6-flash)');

// 3. AN OVERRIDE THAT REINTRODUCES AN ALIAS MUST BE LOUD. A silent alias via env
//    would recreate the outage with no signal at all.
assert.ok(/-latest\$\|/.test(CODE) && /is an ALIAS/.test(SRC),
  'the startup alias warning is gone — an env override could silently restore the '
  + 'exact configuration that zeroed chat');

// 4. THE MODEL MUST REACH THE QUOTA LEDGER, so a 429 says WHICH model was
//    refused. Without it the metric name arrives with no subject.
assert.ok(/model: CHAT_MODEL/.test(CODE),
  'recordQuotaFailure no longer receives CHAT_MODEL — a quota_metric with no model '
  + 'cannot tell you which pin to move');

console.log(`chat model pin smoke: PASS (pinned "${pinned}", both live surfaces route `
  + 'through it, no alias on a live call site, override warns loudly, model reaches '
  + 'the quota ledger)');
process.exit(0);

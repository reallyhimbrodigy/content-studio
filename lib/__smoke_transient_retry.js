// A TRANSIENT 429 MUST NOT REACH A USER AS A 502. [Rule 1, Rule 7]
//
// MEASURED, 35-minute window on 2026-08-17: 28 upstream 429s, 100% carrying
// "This model is currently experiencing high demand... usually temporary", and
// 11 of them reached a USER as a 502 — on a feature that had just returned from
// nine days dead. In the SAME window 7 requests SUCCEEDED for 4 users.
//
// That last number is the whole justification: contention is INTERMITTENT, not
// total, so a second attempt lands often enough to matter. Retrying into a wall
// would only add latency.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
// CODE ONLY — the comments here necessarily quote both 429 messages to explain
// the incident, and a check that reads its own documentation is not a check.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// 1. BOTH surfaces retry. Instrumenting one leaves half the users exposed.
assert.strictEqual(
  (CODE.match(/fetchGeminiWithTransientRetry\(/g) || []).length, 3,
  'expected the helper plus BOTH call sites to reference it — /api/chat and '
  + '/api/chat/stream both 429 and both surfaced 502s');

// 2. IT RETRIES ONLY transient_capacity. A billing 429 is permanent until a
//    human tops up an account; retrying it burns latency to reach the same wall.
assert.ok(/classification !== 'transient_capacity'/.test(CODE),
  'the retry is no longer gated on the transient classification — a billing 429 '
  + 'would be retried into the same wall, and an unknown shape would be retried blind');

// 3. BOUNDED. Chat is interactive: a user waiting through an exponential ladder
//    feels worse than a fast honest error.
const ceil = CODE.match(/CHAT_RETRY_MAX_MS\s*=\s*(\d+)/);
assert.ok(ceil, 'the latency ceiling is gone');
assert.ok(Number(ceil[1]) <= 2000,
  `added-latency ceiling is ${ceil[1]}ms — too long for an interactive turn`);
assert.ok(!/for\s*\(|while\s*\(/.test(
  CODE.slice(CODE.indexOf('async function fetchGeminiWithTransientRetry'),
             CODE.indexOf('const CHAT_MODEL'))),
  'the retry contains a LOOP — it must be exactly one extra attempt, not a ladder');

// 4. THE UPSTREAM'S OWN retryDelay is honoured when offered, clamped to the
//    ceiling. Waiting longer than the server asked is latency for nothing.
assert.ok(/retry_delay/.test(CODE) && /CHAT_RETRY_MAX_MS\)/.test(CODE),
  'the upstream retryDelay is ignored or unclamped');

// 5. THE BODY IS READ ONCE. A Response body cannot be consumed twice, and the
//    classifier needs it to decide whether to retry at all.
const fn = CODE.slice(CODE.indexOf('async function fetchGeminiWithTransientRetry'),
                      CODE.indexOf('const CHAT_MODEL'));
assert.strictEqual((fn.match(/await res\.text\(\)/g) || []).length, 1,
  'the first response body must be read exactly once, then passed to the caller — '
  + 'consuming it twice throws, and not passing it loses the error text');
assert.ok(/firstBody/.test(CODE),
  'the caller no longer receives the already-read body, so the 502 path would '
  + 'log an empty error');

console.log('transient retry smoke: PASS (both surfaces, transient-only, one '
  + 'bounded attempt, upstream delay honoured + clamped, body read once)');
process.exit(0);

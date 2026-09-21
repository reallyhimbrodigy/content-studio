'use strict';

// GATE — /validate is the ONE worker endpoint the app calls DIRECTLY, with no
// server proxy, so its auth has to ride the /api/usage snapshot. Build 256
// already decodes `let validate_token: String?` and sends it as `_worker_auth`;
// the PRODUCER was never written on any branch, which is why 11 of 11 real
// calls arrived unauthenticated. This gates the producer.
//
// The two halves that must agree are in two languages and (now) two repos, so
// the field NAME is asserted literally. A rename on either side is a silent
// nil on a shipped client that cannot be fixed by a server deploy.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fail = [];
const ok = (c, m) => { if (!c) fail.push(m); };

const saved = process.env.MODAL_VALIDATE_SECRET;
const savedRun = process.env.MODAL_RUN_SECRET;
delete require.cache[require.resolve('./validate-token')];
const T = require('./validate-token');

// ── FAIL CLOSED, AND NEVER TO THE DISPATCH SECRET ──────────────────────────
delete process.env.MODAL_VALIDATE_SECRET;
delete process.env.MODAL_RUN_SECRET;
ok(T.mintValidateToken('u1') === null,
   'unset MODAL_VALIDATE_SECRET must mint NOTHING — a token minted without a '
   + 'configured secret is a token signed with nothing');

process.env.MODAL_RUN_SECRET = 'run-secret';
ok(T.mintValidateToken('u1') === null,
   'MINTED FROM MODAL_RUN_SECRET. Falling back to the dispatch secret means an '
   + 'extraction from any app binary buys arbitrary GPU dispatch — the exact '
   + 'reason /validate has its own key');

process.env.MODAL_VALIDATE_SECRET = '   ';
ok(T.mintValidateToken('u1') === null,
   'a whitespace-only secret is not a secret');

// ── PER USER, NOT A SHARED STRING ──────────────────────────────────────────
process.env.MODAL_VALIDATE_SECRET = 'validate-secret';
const tok = T.mintValidateToken('user-aaa');
ok(typeof tok === 'string' && tok.length > 0, 'a configured secret must mint');
ok(T.verifyValidateToken(tok, 'user-aaa').ok,
   'the token must verify for the user it was issued to');
ok(!T.verifyValidateToken(tok, 'user-bbb').ok,
   'A TOKEN LIFTED FROM ONE USER VERIFIES FOR ANOTHER — it is a shared secret '
   + 'with extra steps, and replay is the whole threat');
ok(T.verifyValidateToken(tok, 'user-bbb').reason === 'bad_signature',
   'a wrong-user token must read bad_signature, not a vague refusal');
ok(T.mintValidateToken('') === null,
   'an unbound token (no user) is a shared secret — refuse to mint it');

// ── SHORT LIVED, WITH A CEILING THAT IS NOT A DEFAULT ──────────────────────
ok(T.MAX_TTL_SECONDS <= 3600, 'the TTL ceiling must be one hour or less');
const nowSec = Math.floor(Date.now() / 1000);
const farTok = T.mintValidateToken('user-aaa', { ttlSeconds: 7 * 24 * 3600 });
const farExp = Number(String(farTok).split('.')[1]);
ok(farExp - nowSec <= T.MAX_TTL_SECONDS + 2,
   'a caller asking for a week got one — the ceiling is a clamp, not a default');
ok(!T.verifyValidateToken(tok, 'user-aaa', { nowMs: Date.now() + 3700e3 }).ok,
   'an expired token must not verify');
ok(T.verifyValidateToken(tok, 'user-aaa', { nowMs: Date.now() + 3700e3 }).reason === 'expired',
   'expired must be DISTINCT from forged so the worker can log them apart');

// ── FORGERY AND MALFORMED INPUT DO NOT THROW ───────────────────────────────
for (const bad of [null, undefined, '', 'garbage', 'v1.x.y', 'v2.1.2', tok + 'a', 'v1.' + farExp]) {
  let threw = false;
  try { T.verifyValidateToken(bad, 'user-aaa'); } catch { threw = true; }
  ok(!threw, `verify threw on ${JSON.stringify(bad)} — a forged token must be `
    + 'refused, never turned into a 500');
}

// ── THE SERVER ACTUALLY EMITS IT, UNDER THE SHIPPED NAME ───────────────────
const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
ok(/validate_token:\s*mintValidateToken\(/.test(srv),
   'server.js never puts validate_token on a response — the field the shipped '
   + 'client decodes has no producer, which is the bug this gate exists for');
const usageAt = srv.indexOf("parsed.pathname === '/api/usage'");
const mintAt = srv.indexOf('validate_token: mintValidateToken(');
ok(usageAt >= 0 && mintAt > usageAt,
   'validate_token is minted OUTSIDE the /api/usage handler — it must ride the '
   + 'snapshot the client already fetches');

// The shipped name is snake_case because Swift decodes it literally. Assert the
// exact spelling rather than a case-insensitive match: `validateToken` on the
// wire is a nil on every shipped build and no server deploy can fix it.
ok(/\bvalidate_token\b/.test(srv) && !/validateToken:/.test(srv),
   'the response key must be snake_case validate_token, exactly as '
   + 'UsageService.swift:50 decodes it');

process.env.MODAL_VALIDATE_SECRET = saved === undefined ? '' : saved;
if (saved === undefined) delete process.env.MODAL_VALIDATE_SECRET;
process.env.MODAL_RUN_SECRET = savedRun === undefined ? '' : savedRun;
if (savedRun === undefined) delete process.env.MODAL_RUN_SECRET;

if (fail.length) {
  console.error('FAIL __smoke_validate_token:');
  for (const f of fail) console.error('  - ' + f);
  process.exit(1);
}
console.log('ok __smoke_validate_token — per-user, <=1h, opaque; fails closed '
  + 'with no MODAL_RUN_SECRET fallback; emitted on /api/usage as validate_token');

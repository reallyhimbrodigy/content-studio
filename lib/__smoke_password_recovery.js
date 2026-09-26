'use strict';
// ── PASSWORD RECOVERY — THE RESCUE, THE PAGE, AND THE ORDERING ──────────────
//
// WHAT WAS BROKEN. Supabase recovery emails landed on the homepage and nothing
// happened. 64 users requested recovery in 30 days; 17 never signed in again.
//
// THE CAUSE, MEASURED 2026-09-26 by probing /auth/v1/verify with each candidate
// redirect_to and reading where Supabase actually sent it:
//
//   https://usepromptly.app                      -> https://usepromptly.app/#…  ALLOWED
//   https://usepromptly.app/reset-password.html  -> http://usepromptly.app/#…   REJECTED
//   https://usepromptly.app/reset-password       -> http://usepromptly.app/#…   REJECTED
//
// The Redirect URLs allowlist holds the bare origin and rejects any path, so
// Supabase falls back to the Site URL — `http://usepromptly.app`, the homepage.
// user-store.js passes `${origin}/reset-password.html`, so the WEB flow broke for
// the same reason as iOS.
//
// These legs cover the half that is ours: the rescue forwards the token, the page
// can consume all three token shapes, and the ordering the rescue depends on
// cannot be undone by a well-meaning `defer`.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let legs = 0;
const leg = (name, fn) => { fn(); legs += 1; console.log(`  ok  ${name}`); };

// ── DRIVE THE RESCUE, DO NOT READ IT ───────────────────────────────────────
// The file is an IIFE that takes the global. Wrapping it in a function whose
// PARAMETER is named `window` makes `typeof window !== 'undefined'` true and
// hands it the fake — so this executes the shipped bytes rather than asserting
// about their text. "Source is where code might be; runtime is where it is."
const RESCUE_SRC = read('js/recovery-redirect.js');

function runRescue({ pathname = '/', hash = '', search = '' }) {
  const calls = [];
  const fakeWindow = {
    document: {},
    URLSearchParams,
    location: {
      pathname, hash, search,
      replace: (u) => calls.push(['replace', u]),
      assign: (u) => calls.push(['assign', u]),
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', RESCUE_SRC)(fakeWindow);
  return calls;
}

const RECOVERY_HASH = '#access_token=eyJab.c&refresh_token=rrr&expires_in=3600&type=recovery';

leg('a recovery fragment forwards to the reset page, payload intact', () => {
  const calls = runRescue({ pathname: '/', hash: RECOVERY_HASH });
  assert.strictEqual(calls.length, 1, `expected one navigation, got ${JSON.stringify(calls)}`);
  const [how, url] = calls[0];
  // replace(), not assign(): the recovery URL must not sit in history, where a
  // back button re-runs a consumed single-use token and shows a false error.
  assert.strictEqual(how, 'replace', 'must use location.replace, not assign');
  assert.ok(url.startsWith('/reset-password.html#'), `forwarded to ${url}`);
  // EVERY FIELD SURVIVES. Rebuilding a subset is how refresh_token goes missing
  // and setSession fails on a link that was fine.
  for (const part of ['access_token=eyJab.c', 'refresh_token=rrr', 'type=recovery']) {
    assert.ok(url.includes(part), `lost ${part} in ${url}`);
  }
});

leg('an expired-link error forwards too, rather than dying on the homepage', () => {
  // This is the COMMON case — one-hour, single-use links — and leaving it on the
  // homepage shows the user nothing at all.
  const calls = runRescue({ pathname: '/',
    hash: '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired' });
  assert.strictEqual(calls.length, 1, 'an auth error must be forwarded, not swallowed');
  assert.ok(calls[0][1].includes('error_code=otp_expired'));
});

leg('a bare ?code= is NOT hijacked — that shape is shared with OAuth sign-in', () => {
  // THE LEG THAT PROTECTS LOGIN. Google and Apple sign-in come back to the
  // origin with ?code=. Forwarding those to a password form would break every
  // social login on the site, which is far worse than the bug being fixed.
  assert.deepStrictEqual(runRescue({ pathname: '/', search: '?code=abc123' }), [],
    'a bare ?code= must be left alone');
  // …but an explicit recovery token_hash IS ours.
  const calls = runRescue({ pathname: '/', search: '?token_hash=pkce_x&type=recovery' });
  assert.strictEqual(calls.length, 1, 'token_hash + type=recovery must forward');
  assert.ok(calls[0][1].includes('token_hash=pkce_x'));
});

leg('it never loops, and never fires on an ordinary page load', () => {
  assert.deepStrictEqual(runRescue({ pathname: '/reset-password.html', hash: RECOVERY_HASH }), [],
    'already on the reset page — forwarding again is an infinite loop');
  assert.deepStrictEqual(runRescue({ pathname: '/reset-password', hash: RECOVERY_HASH }), [],
    'the extensionless path must be recognised as the reset page too');
  assert.deepStrictEqual(runRescue({ pathname: '/' }), [],
    'no hash and no query must do nothing at all');
  assert.deepStrictEqual(runRescue({ pathname: '/', search: '?ref=ABCD23' }), [],
    'a referral link must reach js/referral-landing.js untouched');
  assert.deepStrictEqual(runRescue({ pathname: '/', hash: '#pricing' }), [],
    'an ordinary anchor must not navigate anywhere');
});

leg('the rescue cannot throw the homepage away', () => {
  // A rescue that throws must leave the page exactly as it was. Driven with a
  // location that raises on every read.
  const hostile = { document: {}, URLSearchParams,
    location: { get pathname() { throw new Error('boom'); } } };
  // eslint-disable-next-line no-new-func
  assert.doesNotThrow(() => new Function('window', RESCUE_SRC)(hostile),
    'the rescue must swallow its own failures — the homepage is not its to break');
});

// ── THE ORDERING PROPERTY THE WHOLE FIX RESTS ON ───────────────────────────
leg('the rescue loads FIRST and synchronously on the homepage', () => {
  const html = read('index.html');
  const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(tags.length > 1, `expected several script tags, found ${tags.length}`);
  const first = tags[0];
  assert.ok(/recovery-redirect\.js/.test(first),
    `the recovery rescue is not the FIRST script on the homepage — it is ${first}. `
    + 'Any Supabase client on this page is created with detectSessionInUrl:true, '
    + 'which CONSUMES the recovery fragment and strips it from the URL. If that '
    + 'runs first there is nothing left to forward and the user is silently '
    + 'signed in on the marketing page with no way to set a password.');
  // NOT defer, NOT async, NOT a module — all three would let a module run first.
  // This is the whole reason the tag carries a comment telling people not to.
  for (const bad of ['defer', 'async', 'type="module"']) {
    assert.ok(!first.includes(bad),
      `the rescue tag carries ${bad}, which surrenders the ordering it depends on`);
  }
});

// ── THE PAGE CAN CONSUME EVERY SHAPE A RECOVERY LINK ARRIVES IN ───────────
leg('the reset page handles all three token forms and the error form', () => {
  const page = read('reset-password.html');
  // Named individually, because each is load-bearing on its own and a count
  // would let one vanish behind the total.
  const required = {
    'setSession(': 'the implicit #access_token form this project emits today',
    'verifyOtp(': 'the token_hash form, the only one that survives being opened '
      + 'in a different browser from the one that asked',
    'exchangeCodeForSession(': 'the PKCE ?code= form, in case the project flow changes',
    'getSession(': 'the last-resort path for when detectSessionInUrl already consumed the URL',
    "error_code": 'the expired / already-used link branch',
  };
  for (const [needle, why] of Object.entries(required)) {
    assert.ok(page.includes(needle), `reset-password.html no longer handles ${needle} — ${why}`);
  }
  assert.ok(page.includes('updateUser('), 'the page no longer sets a password at all');
});

leg('the page offers a new link, and says what to do next on success', () => {
  const page = read('reset-password.html');
  assert.ok(/id="relink-btn"/.test(page) && /Send a new link/.test(page),
    'an expired link must offer a fresh one FROM THIS PAGE — it is the common '
    + 'failure, not an edge case, and sending the user elsewhere to start over '
    + 'is how 17 of 64 never came back');
  assert.ok(/Password updated\. Open Promptly and sign in\./.test(page),
    'the success copy must tell the user where to go next');
  assert.ok(/app\.usepromptly\.ios:\/\/open/.test(page),
    'the Open Promptly button must use the registered scheme — the same one '
    + 'js/referral-landing.js already uses in production');
  // AND IT MUST NOT BOUNCE TO THE HOMEPAGE. This page is opened from an email,
  // on a phone, by someone whose next step is the app.
  assert.ok(!/window\.location\.href = '\/'/.test(page),
    'the page still redirects to the homepage after success, which is the last '
    + 'thing between the user and signing in');
});

leg('anon key only — the service key never reaches the browser', () => {
  for (const f of ['reset-password.html', 'js/recovery-redirect.js', 'supabase-client.js']) {
    const src = read(f);
    for (const bad of ['service_role', 'SERVICE_ROLE', 'SUPABASE_SERVICE']) {
      assert.ok(!src.includes(bad),
        `${f} mentions ${bad} — a service key in a page served to browsers is a `
        + 'full-database credential handed to every visitor');
    }
  }
});

console.log(`[smoke] password recovery: ${legs}/9 legs green `
  + '(rescue driven, ordering pinned, three token forms, relink, anon-only)');
assert.strictEqual(legs, 9, `expected 9 legs, ran ${legs}`);

'use strict';
// ── A BUILD THAT CANNOT ASK FOR ITS GRANT MUST NOT BE CHARGED ──────────────
//
// debitApplies' own documentation claimed the drift was impossible: "ONE ENV
// VAR GOVERNS BOTH SIDES on purpose ... so the two can never drift into a
// window where a build is charged but ungrantable."
//
// The premise was wrong. FREE_CREDITS_MIN_BUILD decides whether the SERVER will
// accept a device claim. Whether the CLIENT makes one is a property of the
// shipped binary, and no env var reaches it. The caller
// (CreditsService.claimFreeGrantIfNeeded) landed 2026-09-05 14:50 PDT; build
// 246 was cut 2026-09-04 16:13 PDT, 22.6 hours earlier. With the floor at 245:
//
//   882 signed-in active users on 246, ONE device claim (and that one recorded
//   44 minutes BEFORE the caller was committed, so a dev build), against
//   25-100% claim rates on every build from 247 up.
//
// Free users on 246 therefore held a permanent balance of 0 while being fully
// chargeable, and seven of them were refused at the wall on credits they were
// never given. Paid users were unaffected — RevenueCat's recurring grant needs
// no device claim, which is why the only two 246 accounts that ever spent
// credits are both Pro.
//
// The floor is now max(env, CLIENT_CLAIM_MIN_BUILD). This asserts the clamp
// holds for EVERY env value, not just today's.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('./free-credits');
const { stripComments } = require('./__gate_strip');

const CLIENT = F.CLIENT_CLAIM_MIN_BUILD;

// ── 1. THE EXACT DEFECT, both directions ──────────────────────────────────
assert.strictEqual(F.debitApplies({ build: 246, minBuild: 245 }), false,
  'build 246 charged at floor 245 IS the defect: 882 users who cannot claim, '
  + 'cannot be granted, and were charged anyway');
assert.strictEqual(F.debitApplies({ build: 247, minBuild: 245 }), true,
  '247 ships the caller and must still be charged — over-correcting into "charge '
  + 'nobody" would retire the meter by accident');

// ── 2. THE CLAMP HOLDS FOR EVERY ENV VALUE, not just the one set today ────
// A property, so a future operator cannot reintroduce the window by editing a
// variable. Below the client floor the env is raised; above it the env wins.
for (let env = 200; env <= 320; env += 1) {
  const effective = F.effectiveDebitFloor(env);
  assert.strictEqual(effective, Math.max(env, CLIENT), `env=${env}`);
  assert.ok(effective >= CLIENT,
    `env=${env} produced a floor below the client's ${CLIENT} — the window is back`);
  for (const build of [env - 1, env, CLIENT - 1, CLIENT, CLIENT + 1, 400]) {
    const charged = F.debitApplies({ build, minBuild: env });
    if (charged) {
      assert.ok(build >= CLIENT,
        `build ${build} charged under env ${env} but cannot claim its grant`);
      assert.ok(build >= env, `build ${build} charged under env ${env}`);
    }
  }
}

// ── 3. THE TWO FAIL-OPEN CASES SURVIVE ────────────────────────────────────
// Both predate this change and both are deliberate; a clamp that quietly armed
// a dark feature, or that 402'd a client whose header we cannot read, would be
// a worse bug than the one being fixed.
assert.strictEqual(F.effectiveDebitFloor(null), null, 'unset stays dark');
for (const build of [246, 247, 999]) {
  assert.strictEqual(F.debitApplies({ build, minBuild: null }), false,
    'FREE_CREDITS_MIN_BUILD unset must charge NOBODY — ship-dark is load-bearing');
  assert.strictEqual(F.debitApplies({ build, minBuild: NaN }), false);
  assert.strictEqual(F.debitApplies({ build, minBuild: '247' }), false,
    'a string floor is not an integer floor — parse at the edge, not here');
}
for (const floor of [245, 247, 300]) {
  assert.strictEqual(F.debitApplies({ build: null, minBuild: floor }), false,
    'an unreadable build must render free rather than 402 a user we cannot identify');
  assert.strictEqual(F.debitApplies({ build: 'abc', minBuild: floor }), false);
}

// ── 4. THE CONSTANT IS A FACT ABOUT A BINARY, so it lives in code ─────────
{
  const src = stripComments(fs.readFileSync(path.join(__dirname, 'free-credits.js'), 'utf8'));
  assert.ok(/const CLIENT_CLAIM_MIN_BUILD = \d+;/.test(src),
    'CLIENT_CLAIM_MIN_BUILD must be a literal in code — putting it in the '
    + 'environment is what let the two numbers drift in the first place');
  assert.ok(!/process\.env[^\n]*CLIENT_CLAIM/.test(src),
    'it must not be readable from the environment at all');
  assert.ok(/Math\.max\(/.test(src),
    'the effective floor is a max, so the env can only ever be stricter');
  assert.ok(Number.isInteger(CLIENT) && CLIENT >= 247,
    `CLIENT_CLAIM_MIN_BUILD is ${CLIENT}; 247 is the first build cut after the `
    + 'caller commit (6963794, 2026-09-05 14:50 PDT). Lowering it charges users '
    + 'whose binary never asks for a grant.');
}

// ── 5. THE DEBIT SITE AND /api/health BOTH READ THE EFFECTIVE FLOOR ───────
// Reporting `floor=245` while refusing build 246 sends the reader to the wrong
// variable, and a clamp nobody can see is a clamp nobody maintains.
{
  const srv = stripComments(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));
  assert.ok(/effectiveDebitFloor\(_debitFloor\)/.test(srv),
    'the build_below_floor observation must name the EFFECTIVE floor');
  assert.ok(/creditsDebitFloor/.test(srv), '/api/health must expose the floor');
  for (const field of ['env:', 'client:', 'effective:', 'envBelowClient:']) {
    assert.ok(new RegExp(`creditsDebitFloor[\\s\\S]{0,900}${field}`).test(srv),
      `creditsDebitFloor must report ${field} — one number cannot show a gap`);
  }
  assert.ok(/is below the first build whose/.test(srv),
    'a floor set below the client build must be named out loud at boot, not '
    + 'silently corrected — silent correction is how the next operator sets it again');
}

console.log(`[smoke] debit floor vs client: PASS (build 246 at env 245 is NOT charged; 247 `
  + `still is; the clamp holds across 121 env values and every build around each; unset `
  + `stays dark and an unreadable build stays free; CLIENT_CLAIM_MIN_BUILD=${CLIENT} is a `
  + `code literal unreachable from the environment; the debit log, /api/health and a boot `
  + `alert all report the effective floor)`);

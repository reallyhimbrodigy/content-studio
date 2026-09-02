'use strict';
// Gate for the CREDITS arming coupling and the RevenueCat health block
// (2026-09-02).
//
// FORGED FROM A 23-DAY FAILURE. On 2026-08-10 /sync was diagnosed as 100%
// NO_RC_CUSTOMER from a mismatched REVENUECAT_PROJECT_ID / REVENUECAT_SECRET_KEY
// pair, and a `CONFIG SUSPECT` log line was added to make it visible. It fired
// continuously for 23 days. A log line is only visible to someone already
// looking — the same disease as the event-allowlist smoke that ran inside
// Render's build, where the app-* branches it scans do not exist, and therefore
// passed by scanning nothing.
//
// The specific trap this closes: `credits.isConfigured()` is a PRESENCE test,
// not a validity test — it returns true for a mismatched pair. So `CREDITS=1`
// against a 404ing project would have served a meter that 503s for 100% of
// users, with nothing saying so first.
//
// WHAT IS ASSERTED, and why each is separable:
//   1. `credits` on /api/health is CONJOINED with the RC reachability probe.
//      Deleting that conjunction is what makes the failure possible again.
//   2. The probe is REFRESHED, not cached for the process lifetime. The older
//      _rcProjectProbe is a lifetime cache: once it says http_404 it repeats
//      that verdict from memory forever, so a FIXED credential still reads
//      broken until a restart. A stale 'ok' would be worse.
//   3. The health block leaks NOTHING. /api/health is UNAUTHENTICATED.
//
// THIS IS A SOURCE ASSERTION, and its limits are stated rather than implied: it
// proves the coupling is written, not that it executes. The executing proof is
// the boot test in the commit that added it (CREDITS=1 + a 404ing project ->
// credits served 'off'). A cert reasons about text; text is not behaviour.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const fail = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); };

// ── 1. credits is gated on the probe, not on the env var alone ──────────────
// Match the whole arming expression, whitespace-insensitively.
const arming = SRC.replace(/\s+/g, ' ');
ok(/credits: \(\/\^\(1\|on\|true\|yes\)\$\/i\.test\(String\(process\.env\.CREDITS \?\? ''\)\.trim\(\)\) && _rcHealthProbe\.value === 'ok'\)/.test(arming),
  "credits on /api/health is NOT conjoined with _rcHealthProbe.value === 'ok' — "
  + 'CREDITS=1 could arm a meter against an unreachable RevenueCat project, which '
  + '503s for every user. This conjunction IS the gate.');

// Fail closed: the truthy branch must yield 'on' and the fallback 'off', not
// the reverse — an inverted ternary would arm exactly when RC is broken.
ok(/&& _rcHealthProbe\.value === 'ok'\) \? 'on' : 'off'/.test(arming),
  "the credits ternary is not `? 'on' : 'off'` — check it did not get inverted");

// ── 2. the probe REFRESHES; it is not a process-lifetime verdict ────────────
ok(/_rcHealthProbe = \{ at: 0, value: null \}/.test(arming),
  '_rcHealthProbe must start unmeasured (value: null) — "not probed" must never '
  + 'read as "ok"');
ok(/Date\.now\(\) - _rcHealthProbe\.at > \d+/.test(arming),
  '_rcHealthProbe has no time-based refresh — a lifetime cache repeats a stale '
  + 'verdict forever, so a FIXED credential keeps reading broken until a restart '
  + '(and a stale "ok" would be worse). This is the flaw in _rcProjectProbe.');

// ── 3. nothing sensitive on an UNAUTHENTICATED endpoint ────────────────────
const block = (SRC.match(/revenuecat: \(\(\) => \{[\s\S]*?\n {6}\}\)\(\),/) || [''])[0];
ok(block.length > 0, 'the revenuecat health block was not found at all');

// Check the RETURNED KEYS, not mentions of the identifiers. `projectId` and
// `secret` are READ inside the block (`Boolean(projectId && secret)`) and that
// is fine — reading them is the point. What must never happen is one of them
// becoming a key of the returned object. An earlier version of this smoke
// searched for the identifier anywhere after `return {` and reported a leak
// that did not exist: a false RED is as much a broken check as a false green.
const ret = (block.match(/return \{([\s\S]*?)\n {8}\};/) || [, ''])[1];
const keys = [...ret.matchAll(/^ {10}(\w+):/gm)].map((m) => m[1]);
ok(keys.length > 0, 'could not parse the returned keys of the revenuecat block');
for (const banned of ['projectId', 'secret', 'secretKey', 'key']) {
  ok(!keys.includes(banned),
    `the revenuecat health block returns \`${banned}\` — /api/health is UNAUTHENTICATED`);
}
for (const required of ['configured', 'projectIdShape', 'secretShape', 'probe']) {
  ok(keys.includes(required),
    `the revenuecat health block no longer returns \`${required}\``);
}
ok(/probe: _rcHealthProbe\.value/.test(block),
  'the block must expose the probe result — it is the field that distinguishes '
  + '"configured" (presence) from "actually reachable"');

if (fail.length) {
  console.error('credits arming gate: FAIL');
  for (const f of fail) console.error(`   ✗ ${f}`);
  process.exit(1);
}
console.log('credits arming gate: PASS (credits conjoined with a REFRESHING RC probe; '
  + 'health block exposes shapes + probe and leaks neither id nor secret)');

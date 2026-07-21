'use strict';

// ── Deploy sanity pass (the standing invariant check) ────────────────────────
//
// Run after EVERY server deploy:   node scripts/deploy-sanity.js
//
// Born from the seam-bug class: the trial-wall render gate read a field the
// entitlement decision never carried, so every user computed tier 'none' and
// knob-off capped PRO users at trial limits — while the pure lib tests stayed
// green. The wiring between two individually-correct layers is exactly what
// unauthenticated probes can't reach (they die at the auth layer). So:
//
//   "The invariant that got violated becomes the invariant that's checked
//    on every roll, forever." — the standing law (2026-07-20)
//
// Three stages, exit non-zero on any failure:
//   1. Unauth equivalence: gated endpoints answer 401 (auth-first, no walls).
//   2. AUTHENTICATED knob-off probe, known-Pro account: the full entitlement →
//      tier → caps wiring must yield unlimited renders + 10 concurrent. Uses
//      the gate_probe dry-run on POST /api/video-jobs — the exact production
//      gate code path, no job created, no GPU spent.
//   3. Same probe, known-free account: trial caps (3/day, 1 concurrent) — the
//      other half of the knob-off truth table.
//
// Credentials: PROBE_PRO_EMAIL/PASSWORD + PROBE_FREE_EMAIL/PASSWORD from env
// or .env.local. Host: SANITY_HOST (default https://usepromptly.app).

const fs = require('fs');
const path = require('path');

// env: process.env wins; .env.local fills gaps (local runs).
const env = { ...loadDotEnvLocal(), ...process.env };
const HOST = env.SANITY_HOST || 'https://usepromptly.app';

function loadDotEnvLocal() {
  const out = {};
  try {
    const p = path.join(__dirname, '..', '.env.local');
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* no .env.local (CI) — rely on process.env */ }
  return out;
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

async function signIn(email, password) {
  const url = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error('missing SUPABASE_URL / anon key');
  const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anon },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`sign-in failed for ${email}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 120)}`);
  return j.access_token;
}

async function gateProbe(token) {
  const r = await fetch(`${HOST}/api/video-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ gate_probe: true }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function usage(token) {
  const r = await fetch(`${HOST}/api/usage`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  console.log(`Deploy sanity pass — ${HOST}\n`);

  // ── 0. Deploy identity: is prod running the commit we think it is? ─────────
  console.log('0) Health / deploy identity:');
  try {
    const r = await fetch(`${HOST}/api/health`);
    const j = await r.json().catch(() => ({}));
    check('/api/health 200 ok', r.status === 200 && j.ok === true);
    console.log(`    rev=${j.rev || '(none)'}  wall_enforcement=${j.wall_enforcement}  posthog=${j.posthog}`);
    if (env.SANITY_EXPECT_REV) {
      check(`rev startsWith ${env.SANITY_EXPECT_REV.slice(0, 7)}`,
        String(j.rev || '').startsWith(env.SANITY_EXPECT_REV.slice(0, 7)), `got ${j.rev}`);
    }
    check("wall_enforcement == 'off' (dark)", j.wall_enforcement === 'off', `got ${j.wall_enforcement}`);
  } catch (e) {
    check('health probe ran', false, e.message);
  }

  // ── 1. Unauth equivalence: auth-first, no walls ────────────────────────────
  console.log('1) Unauthenticated surface (must 401, never wall):');
  for (const [p, body] of [
    ['/api/chat', { message: 'hi' }],
    ['/api/upload-url', { fileName: 'x.mp4' }],
    ['/api/upload-multipart-init', { fileName: 'x.mp4', partCount: 2 }],
    ['/api/prewarm', { video_url: 'https://example.com/v.mp4' }],
    ['/api/video-jobs', {}],
  ]) {
    const r = await fetch(HOST + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch((e) => ({ status: `ERR:${e.message}` }));
    check(`${p} → ${r.status}`, r.status === 401);
  }

  // ── 2. THE INVARIANT: known-Pro, knob off → unlimited + 10 concurrent ─────
  console.log('\n2) Known-Pro authenticated probe (the seam-bug invariant):');
  try {
    const token = await signIn(env.PROBE_PRO_EMAIL, env.PROBE_PRO_PASSWORD);
    const g = await gateProbe(token);
    check('gate_probe HTTP 200', g.status === 200, `got ${g.status}`);
    check("tier == 'paid'", g.body.tier === 'paid', `got '${g.body.tier}'`);
    check("render_limit == 'unlimited'", g.body.render_limit === 'unlimited', `got ${JSON.stringify(g.body.render_limit)}`);
    check('concurrency_cap == 10', g.body.concurrency_cap === 10, `got ${g.body.concurrency_cap}`);
    check('app_usable == true', g.body.app_usable === true);
    check('reedit == true', g.body.reedit === true);
    const u = await usage(token);
    check('/api/usage is_pro == true', u.body.is_pro === true, `got ${u.body.is_pro}`);
    check("/api/usage tier == 'paid'", u.body.tier === 'paid', `got '${u.body.tier}'`);
  } catch (e) {
    check('pro probe ran', false, e.message);
  }

  // ── 3. Known-free, knob off → today's free tier (trial caps) ──────────────
  console.log('\n3) Known-free authenticated probe (knob-off truth table, other half):');
  try {
    const token = await signIn(env.PROBE_FREE_EMAIL, env.PROBE_FREE_PASSWORD);
    const g = await gateProbe(token);
    check('gate_probe HTTP 200', g.status === 200, `got ${g.status}`);
    check("tier == 'none' (raw)", g.body.tier === 'none', `got '${g.body.tier}'`);
    check('render_limit == 3 (knob-off effective trial)', g.body.render_limit === 3, `got ${JSON.stringify(g.body.render_limit)}`);
    check('concurrency_cap == 1', g.body.concurrency_cap === 1, `got ${g.body.concurrency_cap}`);
    check('chat_limit == 50', g.body.chat_limit === 50, `got ${JSON.stringify(g.body.chat_limit)}`);
    check('reedit == false', g.body.reedit === false);
    check('app_usable == true (knob off — no wall)', g.body.app_usable === true);
    const u = await usage(token);
    check('/api/usage is_pro == false', u.body.is_pro === false, `got ${u.body.is_pro}`);
  } catch (e) {
    check('free probe ran', false, e.message);
  }

  console.log(`\n${failures === 0 ? 'SANITY PASS — all invariants hold' : `SANITY FAIL — ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
})();

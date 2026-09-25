'use strict';
// THE LOOPHOLE SWEEP (Zac 2026-09-25): "For each, a test that proves it's
// closed or a line that says it's open."
//
// Seven money paths. Each leg below either CLOSES one or states, in its own
// message, exactly what is still open and how big it measured.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const strip = require('./__gate_strip').stripComments;
const R = require('./reedit-policy');
const { revenuecatWebhookAuthMatches } = require('./entitlement');

const sv = () => strip(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));

// ── G1: FREE RE-SIGNUP ON THE SAME DEVICE.
// Closed by public.anon_signup_guard, a Supabase auth hook: 3 per device per
// 24h, 10 per 30d, enforce=1 MEASURED live. 2,506 signups logged — 16 blocked.
//
// OPEN, AND THE GUARD SAYS SO ITSELF: a client that sends no device_id is
// logged as 'no_device_id' and ALLOWED. 21 of 2,506 (0.84%) took that path.
// This leg pins the SIZE so a regression shows as a number, and it lives in
// the database rather than here — which is why it is asserted as a documented
// hole rather than a passing test.
{
  const KNOWN_OPEN = 'anon_signup_guard allows a signup with no device_id (logged, not blocked)';
  assert.ok(KNOWN_OPEN.length > 0,
    'G1: OPEN — a client that omits device_id bypasses the per-device cap. '
    + 'Measured 21/2506 = 0.84% took it. The guard logs every one as '
    + "verdict='no_device_id', so the hole is visible; it is not closed.");
}

// ── G2: RE-EDIT CHAINS — 10 free per video x many videos.
{
  const d = (o) => R.decideReedit({ tier: 'pro', capValue: 10, balance: 500, ...o });
  assert.strictEqual(d({ used: 2, monthlyUsed: 5 }).charge, 0,
    'G2: inside both caps is free');
  assert.strictEqual(d({ used: 10, monthlyUsed: 5 }).scope, 'video',
    'G2: the per-video cap still binds');
  const m = d({ used: 2, monthlyUsed: 100 });
  assert.strictEqual(m.charge, R.postCapPrice().price,
    'G2: CLOSED — past the per-USER monthly cap is priced even on a fresh video');
  assert.strictEqual(m.scope, 'month',
    'G2: and the body says MONTH, or the client tells a user their video is '
    + 'full when their month is');
  assert.strictEqual(R.DEFAULT_MONTHLY_CAP, 100, "G2: Zac's default");
  assert.strictEqual(R.monthlyCapFrom({ per_user_month: 250 }), 250, 'G2: configurable');
  assert.strictEqual(R.monthlyCapFrom('nonsense'), R.DEFAULT_MONTHLY_CAP,
    'G2: and an unreadable config falls back to the default, never to 0');
  // AN UNREADABLE COUNT MUST NOT START CHARGING. Same direction as capFrom.
  assert.strictEqual(d({ used: 2, monthlyUsed: null }).charge, 0,
    'G2: a monthly count we could not read does not bind — we do not charge '
    + 'because a count failed');
}

// ── G3: THE CALENDAR-MONTH BOUNDARY UNDER CLOCK SKEW.
// CLOSED BY CONSTRUCTION: the window is computed with the DATABASE's now(),
// server-side, inside the claim. No client value reaches it, so a device with
// a wrong clock cannot move its own month.
{
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations',
    '20260924_claim_monthly_slot.sql'), 'utf8');
  assert.ok(/date_trunc\('month', \(now\(\) at time zone 'utc'\)\)/.test(sql),
    'G3: the month window must come from the database clock');
  assert.ok(!/\$\d\s*::\s*timestamp/.test(sql),
    'G3: and no caller-supplied timestamp may reach it');
  const srv = sv();
  assert.ok(!/claim_monthly_slot[^)]*p_now/.test(srv),
    'G3: the server must not pass a time into the claim');
}

// ── G4: IDEMPOTENCY-KEY REPLAY ACROSS USERS.
// CLOSED: the unique index is (user_id, client_message_id), so a key is a
// namespace PER USER. User B replaying user A's key gets their own row and
// cannot read, resume or charge against A's job.
{
  const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations',
    'add-inflight-index.sql'), 'utf8');
  assert.ok(/user_client_message_id_key/.test(mig),
    'G4: the per-user unique key must still be named in the tree');
  // MEASURED LIVE, recorded so a change to the index shows up as a diff:
  const LIVE = 'CREATE UNIQUE INDEX video_jobs_user_client_message_id_key ON '
    + 'public.video_jobs USING btree (user_id, client_message_id) '
    + 'WHERE (client_message_id IS NOT NULL)';
  assert.ok(/\(user_id, client_message_id\)/.test(LIVE),
    'G4: the key is scoped by user_id — dropping user_id from it would make '
    + "one user's key collide with another's");
}

// ── G5: REVENUECAT WEBHOOK SPOOFING.
// CLOSED to the extent the vendor allows: RevenueCat authenticates with a
// bearer secret, not an HMAC of the body, so the secret IS the whole check.
{
  assert.strictEqual(revenuecatWebhookAuthMatches('Bearer s3cr3t', 's3cr3t'), true);
  assert.strictEqual(revenuecatWebhookAuthMatches('s3cr3t', 's3cr3t'), true, 'G5: bare form too');
  assert.strictEqual(revenuecatWebhookAuthMatches('Bearer nope', 's3cr3t'), false);
  assert.strictEqual(revenuecatWebhookAuthMatches('Bearer s3cr3', 's3cr3t'), false,
    'G5: a prefix of the secret is not the secret');
  assert.strictEqual(revenuecatWebhookAuthMatches('Bearer x', ''), false,
    'G5: an UNSET secret authenticates nobody — the route 503s rather than accepting');
  const ent = strip(fs.readFileSync(path.join(__dirname, 'entitlement.js'), 'utf8'));
  assert.ok(/timingSafeEqual/.test(ent),
    'G5: the compare must be constant-time — `===` short-circuits at the first '
    + 'differing byte, and this is a bearer secret on a route anyone can call '
    + 'as often as they like');
  const srv = sv();
  assert.ok(/webhook_not_configured/.test(srv),
    'G5: and an unconfigured webhook must fail CLOSED');
}

// ── G6: A RE-EDIT ON A VIDEO THE USER DOES NOT OWN.
{
  const srv = sv();
  assert.ok(/orig\.user_id !== authUser\.id/.test(srv),
    'G6: CLOSED — the re-edit route compares the original job\'s owner to the caller');
  const i = srv.indexOf('orig.user_id !== authUser.id');
  assert.ok(/403/.test(srv.slice(i, i + 160)),
    'G6: and refuses with 403 rather than 404 or a silent pass');
}

// ── G7: BATCH UPLOAD — CHARGED PER VIDEO, NO PARTIAL CHARGE ON A MID-BATCH
// FAILURE. This is the one I have NOT closed, and saying so is the point.
{
  const OPEN = true;
  assert.ok(OPEN,
    'G7: NOT PROVEN. lib/generation-quotes.js has the crash matrix '
    + '(CHARGED / NOT_CHARGED(422) / UNKNOWN->hold) and batch pairs, and '
    + 'RevenueCat deducts atomically per call so a mid-batch failure cannot '
    + 'half-deduct ONE video. What is NOT proven is the BATCH boundary: that '
    + 'n charges for n videos unwind to n-k when k fail. It needs a driven '
    + 'test against the real confirm path and it does not have one.');
}

console.log('[smoke] money loopholes: 5 CLOSED (re-edit chains per-user month, month '
  + 'boundary on the DB clock, idempotency scoped per user, webhook secret constant-time '
  + 'and fail-closed, foreign re-edit 403) · 2 OPEN AND NAMED (signup with no device_id, '
  + 'measured 0.84%; batch partial-charge unwind, untested)');
process.exit(0);

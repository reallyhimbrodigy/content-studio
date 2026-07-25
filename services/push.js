// APNs push notifications via the HTTP/2 provider API.
//
// Auth uses an Apple Developer "Auth Key" (.p8) — the modern token-based
// auth. We sign a short-lived JWT with ES256 every ~50 minutes (Apple
// rejects tokens older than 1 hour, so we refresh comfortably ahead).
//
// Required environment variables:
//   APNS_AUTH_KEY_BASE64   — base64-encoded contents of the .p8 file
//   APNS_KEY_ID            — 10-char Key ID from developer.apple.com
//   APNS_TEAM_ID           — 10-char Team ID (DEVELOPMENT_TEAM in pbxproj)
//   APNS_BUNDLE_ID         — app bundle id (e.g. app.usepromptly.ios)
//   APNS_USE_SANDBOX       — "1" to use sandbox gateway (TestFlight/Xcode);
//                            unset for production gateway
//
// If any of the auth vars are missing, sendPush() is a no-op so dev
// machines without APNs creds don't crash — sentBy will be 'noop' so the
// caller can log the skip.

const crypto = require('crypto');
const http2 = require('http2');
const { supabaseAdmin } = require('./supabase-admin');

const PROD_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

let cachedToken = null;
let cachedTokenIssuedAt = 0;

function loadAuthKey() {
  const b64 = process.env.APNS_AUTH_KEY_BASE64;
  if (b64) {
    try {
      return Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      /* fall through to the PEM form */
    }
  }
  // Belt: accept the raw-PEM env form (APNS_KEY) the legacy pushNotifier.js
  // convention used, so whichever variable the Render dashboard carries works.
  const pem = process.env.APNS_KEY;
  if (pem && pem.includes('PRIVATE KEY')) return pem;
  return null;
}

function configured() {
  return Boolean(
    (process.env.APNS_AUTH_KEY_BASE64 || process.env.APNS_KEY) &&
    process.env.APNS_KEY_ID &&
    process.env.APNS_TEAM_ID &&
    process.env.APNS_BUNDLE_ID
  );
}

// JWT signed with ES256. Apple wants:
//   header  = { alg: ES256, kid: APNS_KEY_ID }
//   payload = { iss: APNS_TEAM_ID, iat: <now in seconds> }
function buildAuthToken() {
  const now = Math.floor(Date.now() / 1000);
  // Reuse cached token if it's <50 min old. Apple max is 60 min.
  if (cachedToken && now - cachedTokenIssuedAt < 50 * 60) return cachedToken;

  const keyPem = loadAuthKey();
  if (!keyPem) throw new Error('APNS auth key not configured');

  const header = { alg: 'ES256', kid: process.env.APNS_KEY_ID };
  const payload = { iss: process.env.APNS_TEAM_ID, iat: now };

  const b64url = (buf) => Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  // Sign with ES256 — output is DER-encoded ASN.1 by default; we need
  // the raw 64-byte (r||s) JOSE format that Apple expects.
  const signer = crypto.createSign('SHA256');
  signer.update(signingInput);
  signer.end();
  const derSig = signer.sign(keyPem);
  const joseSig = derToJose(derSig);
  const sigB64 = b64url(joseSig);

  cachedToken = `${signingInput}.${sigB64}`;
  cachedTokenIssuedAt = now;
  return cachedToken;
}

// Convert DER-encoded ECDSA signature to JOSE concat (r||s) for ES256.
// Each integer is 32 bytes (P-256). DER may pad with a leading 0x00 byte
// when the high bit is set; strip it. May also be shorter than 32 bytes
// when the leading bytes are zero; left-pad to 32.
function derToJose(der) {
  // DER format: 0x30 <total-len> 0x02 <r-len> <r> 0x02 <s-len> <s>
  if (der[0] !== 0x30) throw new Error('Invalid DER signature');
  let offset = 2;
  if ((der[1] & 0x80) !== 0) {
    // Multi-byte length encoding — skip the length bytes.
    offset += der[1] & 0x7f;
  }
  if (der[offset++] !== 0x02) throw new Error('Invalid DER signature: expected r INTEGER');
  let rLen = der[offset++];
  let r = der.slice(offset, offset + rLen);
  offset += rLen;
  if (der[offset++] !== 0x02) throw new Error('Invalid DER signature: expected s INTEGER');
  let sLen = der[offset++];
  let s = der.slice(offset, offset + sLen);

  const stripLeadingZero = (buf) => (buf.length > 0 && buf[0] === 0x00) ? buf.slice(1) : buf;
  const padTo32 = (buf) => {
    if (buf.length >= 32) return buf.slice(buf.length - 32);
    const out = Buffer.alloc(32);
    buf.copy(out, 32 - buf.length);
    return out;
  };

  return Buffer.concat([padTo32(stripLeadingZero(r)), padTo32(stripLeadingZero(s))]);
}

/**
 * Send a single APNs push.
 *   to: device token (hex string from iOS client)
 *   alert: { title, body } — omit for silent (content-available) pushes
 *   data: extra payload merged into the JSON
 *   opts.silent: true → background prefetch push (no banner, no sound).
 *     iOS wakes the app for ~30s in didReceiveRemoteNotification so it
 *     can pre-warm caches before the user sees the alert variant.
 *   opts.apsExtra: extra keys merged into the aps dictionary (e.g.
 *     { 'thread-id': 'render-alert' } so operator alerts collapse into
 *     one notification thread).
 * Returns { ok, status, reason }. ok=true on 200, false otherwise.
 */
async function sendOne(token, alert, data = {}, opts = {}) {
  if (!configured()) return { ok: false, status: 0, reason: 'not_configured' };

  const host = process.env.APNS_USE_SANDBOX === '1' ? SANDBOX_HOST : PROD_HOST;
  const client = http2.connect(host);

  const silent = Boolean(opts.silent);
  const aps = silent
    ? { 'content-available': 1 }
    : { alert, sound: 'default', 'mutable-content': 1, ...(opts.apsExtra || {}) };

  const body = JSON.stringify({ aps, ...data });

  return new Promise((resolve) => {
    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      'authorization': `bearer ${buildAuthToken()}`,
      'apns-topic': process.env.APNS_BUNDLE_ID,
      // 'background' is REQUIRED for content-available-only pushes —
      // Apple drops them silently if you send as 'alert'. Priority 5
      // (rather than 10) is also required for background push and lets
      // the OS schedule delivery for power efficiency.
      'apns-push-type': silent ? 'background' : 'alert',
      'apns-priority': silent ? '5' : '10',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    };

    const req = client.request(headers);
    let resStatus = 0;
    let resBody = '';

    req.on('response', (h) => { resStatus = h[':status']; });
    req.on('data', (chunk) => { resBody += chunk; });
    req.on('end', () => {
      client.close();
      if (resStatus === 200) {
        resolve({ ok: true, status: 200, reason: null });
      } else {
        let reason = 'unknown';
        try { reason = JSON.parse(resBody).reason || reason; } catch {}
        resolve({ ok: false, status: resStatus, reason });
      }
    });
    req.on('error', (err) => {
      client.close();
      resolve({ ok: false, status: 0, reason: err.message });
    });

    req.end(body);
  });
}

/**
 * Send a push to every device a user has registered. Removes tokens that
 * Apple says are dead (BadDeviceToken / Unregistered).
 *   userId: Supabase auth user id
 *   alert: { title, body }
 *   data: extra payload (e.g. { jobId, type: 'render-complete' })
 *   opts: { silent: true } for content-available background pushes
 */
async function sendToUser(userId, alert, data = {}, opts = {}) {
  if (!configured()) return { sent: 0, skipped: 'not_configured' };
  if (!supabaseAdmin) return { sent: 0, skipped: 'no_supabase' };

  const { data: tokens, error } = await supabaseAdmin
    .from('device_tokens')
    .select('id, token')
    .eq('user_id', userId)
    .eq('platform', 'ios');

  if (error) {
    console.error('[push] device_tokens select failed:', error.message);
    return { sent: 0, skipped: 'db_error' };
  }
  if (!tokens || tokens.length === 0) return { sent: 0, skipped: 'no_tokens' };

  const results = await Promise.all(tokens.map((row) =>
    sendOne(row.token, alert, data, opts).then((r) => ({ ...r, row }))
  ));

  let sent = 0;
  const deadIds = [];
  const perToken = [];
  for (const r of results) {
    // Per-token APNs response record — the definitive delivery diagnostic
    // (returned to callers so proof endpoints can report it without log access).
    perToken.push({ token: String(r.row.token || '').slice(0, 8), status: r.status, reason: r.reason || null });
    if (r.ok) {
      sent++;
    } else if (r.reason === 'BadDeviceToken' || r.reason === 'Unregistered' || r.status === 410) {
      deadIds.push(r.row.id);
    } else {
      console.warn(`[push] APNs error for ${r.row.id}: ${r.status} ${r.reason}`);
    }
  }

  if (deadIds.length) {
    await supabaseAdmin
      .from('device_tokens')
      .delete()
      .in('id', deadIds);
    console.log(`[push] Pruned ${deadIds.length} dead device tokens`);
  }

  return { sent, total: tokens.length, results: perToken };
}

// Owner-alert title law: every operator push must carry "[Promptly]" in the
// title — the bare word "Render"/"render" collides with Render-the-host in the
// owner's notification stack (real confusion, reaper comment 2026-07). Callers
// should write compliant titles; this is the mechanical guarantee for the ones
// that don't.
function normalizeOwnerTitle(title) {
  const t = String(title || '').trim() || '[Promptly] alert';
  if (t.includes('[Promptly]')) return t;
  // Keep a leading emoji (e.g. "⚠️ ") in front of the tag so alert severity
  // stays visually scannable: "⚠️ [Promptly] …".
  const m = t.match(/^(\p{Extended_Pictographic}️?\s+)(.*)$/u);
  if (m) return `${m[1]}[Promptly] ${m[2]}`;
  return `[Promptly] ${t}`;
}

/**
 * Operator [ALERT] channel — a visible push to the founder's own device(s).
 * Rides the SAME transport as user pushes (the one proven live by prod
 * push_sent events), instead of the legacy pushNotifier transport whose
 * APNS_KEY/APNS_PRODUCTION env convention never matched the deployed
 * environment (the "worked in logs, never landed" mailman bug).
 * Best-effort: never throws to the caller.
 */
async function sendOwnerAlert({ ownerUserId, title, body, threadId }) {
  try {
    if (!ownerUserId) {
      console.warn('[alert] skipping owner alert: no ownerUserId');
      return { sent: 0, skipped: 'no_owner' };
    }
    const finalTitle = normalizeOwnerTitle(title);
    const r = await sendToUser(ownerUserId, { title: finalTitle, body: body || '' }, { type: 'ops-alert' }, {
      apsExtra: { 'thread-id': threadId || 'ops-alert' },
    });
    const detail = (r.results || [])
      .map((t) => `${t.token}…:${t.status}${t.reason ? `/${t.reason}` : ''}`)
      .join(' ');
    console.log(`[alert] owner=${ownerUserId} sent=${r.sent ?? 0}/${r.total ?? 0}`
      + `${r.skipped ? ` skipped=${r.skipped}` : ''} title="${finalTitle.slice(0, 60)}"${detail ? ` apns=[${detail}]` : ''}`);
    return r;
  } catch (err) {
    console.error('[alert] owner alert unexpected error:', err && err.message);
    return { sent: 0, skipped: 'error' };
  }
}

module.exports = {
  configured,
  sendOne,
  sendToUser,
  sendOwnerAlert,
  normalizeOwnerTitle,
};

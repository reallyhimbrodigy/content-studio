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
  if (!b64) return null;
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function configured() {
  return Boolean(
    process.env.APNS_AUTH_KEY_BASE64 &&
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
 *   alert: { title, body }
 *   data: extra payload merged into the JSON
 * Returns { ok, status, reason }. ok=true on 200, false otherwise.
 */
async function sendOne(token, alert, data = {}) {
  if (!configured()) return { ok: false, status: 0, reason: 'not_configured' };

  const host = process.env.APNS_USE_SANDBOX === '1' ? SANDBOX_HOST : PROD_HOST;
  const client = http2.connect(host);

  const body = JSON.stringify({
    aps: {
      alert,
      sound: 'default',
      'mutable-content': 1,
    },
    ...data,
  });

  return new Promise((resolve) => {
    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      'authorization': `bearer ${buildAuthToken()}`,
      'apns-topic': process.env.APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
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
 */
async function sendToUser(userId, alert, data = {}) {
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
    sendOne(row.token, alert, data).then((r) => ({ ...r, row }))
  ));

  let sent = 0;
  const deadIds = [];
  for (const r of results) {
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

  return { sent, total: tokens.length };
}

module.exports = {
  configured,
  sendOne,
  sendToUser,
};

// Apple Push Notification Service (APNs) HTTP/2 client.
//
// Implements the minimum surface area needed to send "your video is
// ready" notifications to registered iOS devices when a render
// completes. Uses Node's built-in http2 + crypto so we don't take a
// dependency on a third-party APNs library — APNs is just HTTP/2 POSTs
// + an ES256-signed JWT in the Authorization header, ~150 lines total.
//
// Env vars required (set in Render dashboard):
//   APNS_KEY        — the PEM-encoded private key body. Must include
//                     the "-----BEGIN PRIVATE KEY-----" header lines.
//   APNS_KEY_ID     — Key ID from the Apple Developer auth-key page.
//   APNS_TEAM_ID    — Apple Developer Team ID.
//   APNS_BUNDLE_ID  — App bundle ID. Used as the APNs topic header.
//   APNS_PRODUCTION — "true" for App Store / TestFlight builds,
//                     anything else (or unset) for the sandbox gateway.
//
// External surface:
//   - sendRenderCompleteNotification({ userId, jobId, videoUrl,
//     hlsManifestUrl, supabaseAdmin }): dispatches the visible "Your
//     video is ready" alert to every registered device for this user.
//     Best-effort: errors are logged but never thrown to the caller,
//     because notification failure is not a user-facing render failure.
//
// Tradeoffs / known limits:
//   - One HTTP/2 connection per call. APNs is happy with sustained
//     connections, but the volume here is low enough (one push per
//     finished render) that the overhead is in the noise.
//   - JWT regenerated on every call. APNs accepts the same JWT for
//     up to ~60 minutes but the calculation is microseconds, so
//     caching adds complexity for no measurable win at this volume.
//   - On 410 BadDeviceToken the offending token is deleted from
//     Supabase so the same dead token isn't re-sent on the next
//     render — keeps device_tokens lean and avoids re-sending into
//     the void after a user uninstalls the app.

const http2 = require('node:http2');
const crypto = require('node:crypto');

/// Sign an ES256 JWT with the APNs auth key. Header has kid (key id),
/// payload has iss (team id) + iat (unix seconds). Apple rejects JWTs
/// older than ~60 minutes; we regenerate on every send so we don't
/// have to manage a cache lifecycle.
function buildAPNsJWT() {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const keyPem = process.env.APNS_KEY;
  if (!keyId || !teamId || !keyPem) {
    throw new Error('APNS env vars missing — set APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID');
  }

  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: teamId,
    iat: Math.floor(Date.now() / 1000),
  })).toString('base64url');
  const signingInput = `${header}.${payload}`;

  // crypto.sign returns a DER-encoded ECDSA signature. APNs requires
  // the JOSE raw (r || s) format with each component zero-padded to
  // 32 bytes — convert here.
  const der = crypto.sign('SHA256', Buffer.from(signingInput), keyPem);
  const jose = derToJoseSignature(der);
  return `${signingInput}.${jose.toString('base64url')}`;
}

/// DER-encoded ECDSA-P256 → JOSE raw signature (64 bytes, r || s).
function derToJoseSignature(der) {
  // SEQUENCE { INTEGER r, INTEGER s }
  // 0x30 totalLen 0x02 rLen r... 0x02 sLen s...
  let off = 0;
  if (der[off++] !== 0x30) throw new Error('Invalid DER signature (not SEQUENCE)');
  const seqLen = der[off++];
  if (seqLen + 2 !== der.length) {
    // multi-byte length form — unusual for P-256 but handle it
    // gracefully by reading the actual byte count
  }
  if (der[off++] !== 0x02) throw new Error('Invalid DER signature (no INTEGER r)');
  let rLen = der[off++];
  let r = der.slice(off, off + rLen);
  off += rLen;
  if (der[off++] !== 0x02) throw new Error('Invalid DER signature (no INTEGER s)');
  let sLen = der[off++];
  let s = der.slice(off, off + sLen);

  // Strip leading 0x00 (DER sign-extension byte)
  if (r[0] === 0x00) r = r.slice(1);
  if (s[0] === 0x00) s = s.slice(1);
  // Left-pad to 32 bytes
  const rPad = Buffer.concat([Buffer.alloc(32 - r.length), r]);
  const sPad = Buffer.concat([Buffer.alloc(32 - s.length), s]);
  return Buffer.concat([rPad, sPad]);
}

/// Post one device-targeted notification. Returns { ok, status,
/// reason, deviceToken } — caller decides what to do with failures
/// (we use the reason field to detect "BadDeviceToken" and clean up).
function sendOne({ client, deviceToken, jwt, topic, payload }) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${jwt}`,
      'apns-topic': topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
      'content-length': body.length,
    });

    let status = 0;
    let responseBody = '';
    req.on('response', (headers) => { status = headers[':status']; });
    req.on('data', (chunk) => { responseBody += chunk.toString('utf8'); });
    req.on('end', () => {
      let reason = null;
      if (status !== 200 && responseBody) {
        try { reason = JSON.parse(responseBody).reason || null; } catch {}
      }
      resolve({ ok: status === 200, status, reason, deviceToken });
    });
    req.on('error', (err) => {
      resolve({ ok: false, status: 0, reason: err.message, deviceToken });
    });
    req.end(body);
  });
}

/// Public entrypoint. Fetches every device token registered to this
/// user from Supabase, opens an HTTP/2 connection to APNs, fans out
/// the alert + custom payload, then prunes any token APNs rejected as
/// BadDeviceToken / Unregistered (user uninstalled the app, etc).
///
/// Errors are caught + logged. Notification failure must never
/// propagate up to the caller — the user's video is still rendered
/// and they can find it via SSE or by re-opening the app.
async function sendRenderCompleteNotification({
  userId,
  jobId,
  videoUrl,
  hlsManifestUrl,
  vibe,
  supabaseAdmin,
}) {
  try {
    if (!userId || !jobId || !videoUrl) {
      console.warn('[push] skipping render-complete: missing required field');
      return;
    }
    const topic = process.env.APNS_BUNDLE_ID;
    if (!topic) {
      console.warn('[push] APNS_BUNDLE_ID not set — skipping');
      return;
    }

    const { data: tokens, error } = await supabaseAdmin
      .from('device_tokens')
      .select('token, bundle_id, platform')
      .eq('user_id', userId)
      .eq('platform', 'ios');
    if (error) {
      console.error('[push] DB lookup error:', error.message);
      return;
    }
    const validTokens = (tokens || [])
      .filter((t) => t.token && (!t.bundle_id || t.bundle_id === topic))
      .map((t) => t.token);
    if (validTokens.length === 0) {
      console.log(`[push] no registered iOS tokens for user=${userId}`);
      return;
    }

    let jwt;
    try {
      jwt = buildAPNsJWT();
    } catch (e) {
      console.error('[push] JWT build failed:', e.message);
      return;
    }

    const gateway = (process.env.APNS_PRODUCTION === 'true')
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';
    const client = http2.connect(gateway);

    const apsPayload = {
      aps: {
        alert: {
          title: 'Your video is ready ✨',
          body: vibe
            ? `Tap to see your "${truncate(vibe, 40)}" edit.`
            : 'Tap to see how your edit turned out.',
        },
        sound: 'default',
        'mutable-content': 1,
      },
      type: 'render-complete',
      jobId,
      videoUrl,
    };
    if (hlsManifestUrl) apsPayload.hlsManifestUrl = hlsManifestUrl;

    const results = await Promise.all(validTokens.map((deviceToken) =>
      sendOne({ client, deviceToken, jwt, topic, payload: apsPayload })
    ));
    client.close();

    let okCount = 0;
    const deadTokens = [];
    for (const r of results) {
      if (r.ok) {
        okCount++;
      } else {
        console.warn(`[push] failed token=${r.deviceToken.slice(0, 8)}... status=${r.status} reason=${r.reason}`);
        if (r.reason === 'BadDeviceToken' || r.reason === 'Unregistered' || r.status === 410) {
          deadTokens.push(r.deviceToken);
        }
      }
    }
    console.log(`[push] render-complete user=${userId} job=${jobId} sent=${okCount}/${validTokens.length}`);

    if (deadTokens.length > 0) {
      await supabaseAdmin
        .from('device_tokens')
        .delete()
        .in('token', deadTokens);
      console.log(`[push] pruned ${deadTokens.length} dead token(s)`);
    }
  } catch (err) {
    console.error('[push] unexpected error:', err.message);
  }
}

function truncate(s, n) {
  if (!s || s.length <= n) return s || '';
  return s.slice(0, n - 1).trim() + '…';
}

// Owner alert — a visible push to the founder's own device(s), used as the
// operational [ALERT] channel for terminal REAL render failures (RENDER_FATAL /
// UNKNOWN / INTEGRITY_TRIP / CONTAINER_TEARDOWN — never designed rejections).
// Same APNs machinery as the render-complete push, targeted at ownerUserId's
// registered iOS tokens instead of the job's user. Best-effort: a notification
// failure must never propagate — this is an operator convenience, not a
// user-facing path.
async function sendOwnerAlert({ ownerUserId, title, body, threadId, supabaseAdmin }) {
  try {
    if (!ownerUserId) {
      console.warn('[alert] skipping owner alert: no ownerUserId');
      return;
    }
    const topic = process.env.APNS_BUNDLE_ID;
    if (!topic) {
      console.warn('[alert] APNS_BUNDLE_ID not set — skipping owner alert');
      return;
    }
    const { data: tokens, error } = await supabaseAdmin
      .from('device_tokens')
      .select('token, bundle_id, platform')
      .eq('user_id', ownerUserId)
      .eq('platform', 'ios');
    if (error) {
      console.error('[alert] DB lookup error:', error.message);
      return;
    }
    const validTokens = (tokens || [])
      .filter((t) => t.token && (!t.bundle_id || t.bundle_id === topic))
      .map((t) => t.token);
    if (validTokens.length === 0) {
      console.log(`[alert] no registered iOS tokens for owner=${ownerUserId}`);
      return;
    }

    let jwt;
    try {
      jwt = buildAPNsJWT();
    } catch (e) {
      console.error('[alert] JWT build failed:', e.message);
      return;
    }

    const gateway = (process.env.APNS_PRODUCTION === 'true')
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';
    const client = http2.connect(gateway);

    const apsPayload = {
      aps: {
        alert: { title: title || 'Promptly alert', body: body || '' },
        sound: 'default',
        // Group operator alerts so a burst collapses into one thread.
        'thread-id': threadId || 'ops-alert',
      },
      type: 'ops-alert',
    };

    const results = await Promise.all(validTokens.map((deviceToken) =>
      sendOne({ client, deviceToken, jwt, topic, payload: apsPayload })
    ));
    client.close();

    let okCount = 0;
    const deadTokens = [];
    for (const r of results) {
      if (r.ok) okCount++;
      else {
        // Surface the APNs response code — the definitive owner-push diagnostic.
        // status=400 reason=BadTopic → APNS_BUNDLE_ID ≠ the app bundle;
        // status=400/410 reason=BadDeviceToken/Unregistered → stale token (deleted
        // below, owner must re-register); status=403 → JWT/key (APNS_KEY/KEY_ID);
        // 400 reason=DeviceTokenNotForTopic → wrong APNS_PRODUCTION gateway.
        console.warn(`[alert] owner push failed token=${String(r.deviceToken).slice(0, 8)}... `
          + `status=${r.status} reason=${r.reason} gateway=${process.env.APNS_PRODUCTION === 'true' ? 'prod' : 'sandbox'}`);
        if (r.reason === 'BadDeviceToken' || r.reason === 'Unregistered' || r.status === 410) {
          deadTokens.push(r.deviceToken);
        }
      }
    }
    console.log(`[alert] owner=${ownerUserId} sent=${okCount}/${validTokens.length} title="${truncate(title, 40)}"`);
    if (deadTokens.length > 0) {
      await supabaseAdmin.from('device_tokens').delete().in('token', deadTokens);
    }
  } catch (err) {
    console.error('[alert] unexpected error:', err.message);
  }
}

module.exports = { sendRenderCompleteNotification, sendOwnerAlert };

'use strict';
// EVERY HTTP OUTCOME, COUNTED. The instrument that makes "every possible error"
// a checkable claim instead of an assertion.
//
// WHY THIS EXISTS (Zac 2026-08-03): "ENUMERATE EVERY ROUTE IN content-studio AND
// ITS FAILURE MODES, then check each against 30 days of logs for non-2xx rates.
// UNTIL THAT EXISTS, 'every possible error' CANNOT BE CLAIMED."
//
// The enumeration was done statically — 34 API routes, ~100 distinct failure
// modes. The MEASUREMENT could not be: content-studio has no APM, no log sink,
// no Sentry/OTel/pino dependency, and no Render API credential. It writes to
// stdout, and stdout is not retained for 30 days. So there was no 30-day
// non-2xx rate to read, for ANY route. That is the real finding: the job
// pipeline has six terminal states we can count, and the other 34 routes have
// none — a user hitting `502 AI service error` on /api/chat leaves no trace we
// can query the next morning.
//
// WHERE IT HOOKS. Not sendJson (226 call sites, and 22 handlers use
// res.writeHead directly and would be invisible). `res.on('finish')` at the ONE
// createServer entry, which fires for every response including static files,
// unrouted 404s, and 500s thrown out of the outer catch. Nothing can respond
// without passing through it.
//
// THREE THINGS IT MUST NOT DO, each of which has bitten this codebase:
//   * Never block or delay a response — record on 'finish', flush on a timer.
//   * Never throw. An instrument that can crash the server is worse than none.
//   * Never grow without bound. A scanner hitting /aaa1, /aaa2 ... would make
//     an unbounded key space, so unknown paths collapse to one bucket and the
//     map is capped.
//
// RULE 7 — the counts carry distinct USERS, not just events. A user who retries
// a failing route five times is one lost user, not five failures. The actor
// comes from the Supabase JWT `sub` already on the request; no handler changes,
// and the token itself is never stored or logged.

const KNOWN_PREFIXES = [
  '/api/account/delete', '/api/admin/email-test', '/api/admin/feedback',
  '/api/admin/submissions', '/api/chat/stream', '/api/chat',
  '/api/cron/process-jobs', '/api/devices/register', '/api/devices/unregister',
  '/api/events', '/api/feedback', '/api/health',
  '/api/internal/lifecycle-push-proof', '/api/internal/render-alert',
  '/api/modal-complete', '/api/modal-progress', '/api/modal-webhook',
  '/api/prewarm', '/api/profile/settings', '/api/render-cancelled',
  '/api/revenuecat/sync', '/api/revenuecat/webhook',
  '/api/submissions/upload-url', '/api/submissions',
  '/api/upload-multipart-abort', '/api/upload-multipart-complete',
  '/api/upload-multipart-init', '/api/upload-url', '/api/upload',
  '/api/usage', '/api/user/subscription',
  '/api/video-jobs/re-edit', '/api/video-jobs',
];

const MAX_KEYS = 500;          // hard cap; past it we count into an overflow key
const FLUSH_MS = 60_000;

// Longest-prefix match against the known surface. Anything else — scanners,
// typos, probes for /wp-login.php — collapses into one bucket so a hostile
// caller cannot inflate the key space.
function normalizeRoute(pathname) {
  const p = String(pathname || '/').split('?')[0];
  if (!p.startsWith('/api/')) return p === '/' ? '/' : '/__static';
  let best = null;
  for (const k of KNOWN_PREFIXES) {
    if ((p === k || p.startsWith(`${k}/`)) && (!best || k.length > best.length)) best = k;
  }
  return best || '/__unrouted';
}

// The Supabase access token is a JWT; its payload carries `sub`, the user id.
// Decoded, never verified here (this is a counter, not an auth boundary) and
// never stored — only the id reaches the ledger.
function actorFromRequest(req) {
  try {
    const h = String((req && req.headers && req.headers.authorization) || '');
    const m = /^Bearer\s+([\w-]+\.([\w-]+)\.[\w-]+)$/.exec(h);
    if (!m) return null;
    const claims = JSON.parse(Buffer.from(m[2], 'base64').toString('utf8'));
    const sub = claims && claims.sub;
    return (typeof sub === 'string' && sub.length >= 8) ? sub : null;
  } catch (_) { return null; }
}

const _buckets = new Map();   // "METHOD route code" -> {method,route,code,n,users:Set}
let _overflow = 0;
let _timer = null;
let _flushing = false;

function record(method, pathname, statusCode, actor) {
  try {
    const code = Number(statusCode);
    if (!Number.isFinite(code) || code < 400) return;   // only failures
    const route = normalizeRoute(pathname);
    const key = `${method || 'GET'} ${route} ${code}`;
    let b = _buckets.get(key);
    if (!b) {
      if (_buckets.size >= MAX_KEYS) { _overflow += 1; return; }
      b = { method: method || 'GET', route, code, n: 0, users: new Set() };
      _buckets.set(key, b);
    }
    b.n += 1;
    if (actor && b.users.size < 2000) b.users.add(actor);
  } catch (_) { /* an instrument never throws */ }
}

// Attach to the single createServer handler. Returns nothing and must never
// affect the response.
function attach(req, res) {
  try {
    const actor = actorFromRequest(req);
    const pathname = String(req.url || '/').split('?')[0];
    res.on('finish', () => record(req.method, pathname, res.statusCode, actor));
  } catch (_) { /* never break a request to measure it */ }
}

function drain() {
  const out = [];
  for (const b of _buckets.values()) {
    out.push({ method: b.method, route: b.route, code: b.code, n: b.n, users: b.users.size });
  }
  if (_overflow) { out.push({ method: 'ANY', route: '/__overflow', code: 0, n: _overflow, users: 0 }); }
  _buckets.clear();
  _overflow = 0;
  return out;
}

// Flush aggregates — one row per (method, route, code) per minute, not one row
// per failure. Written straight to analytics_events server-side, which bypasses
// the /api/events client allowlist by design (that allowlist guards the open
// endpoint, not our own writes).
async function flush(supabase, log = console) {
  if (_flushing) return 0;
  _flushing = true;
  try {
    const rows = drain();
    if (!rows.length || !supabase) return 0;
    const payload = rows.map((r) => ({
      event: 'api_outcome',
      props: { route: r.route, code: r.code, method: r.method, n: r.n, users: r.users },
    }));
    const { error } = await supabase.from('analytics_events').insert(payload);
    if (error) {
      log.warn(`[api-ledger] flush failed: ${error.message} (${rows.length} buckets lost)`);
      return 0;
    }
    const worst = rows.slice().sort((a, b) => b.n - a.n)[0];
    log.log(`[api-ledger] flushed ${rows.length} buckets, ${rows.reduce((s, r) => s + r.n, 0)} failures`
      + (worst ? ` — worst ${worst.method} ${worst.route} ${worst.code} n=${worst.n}/${worst.users}u` : ''));
    return rows.length;
  } catch (e) {
    log.warn(`[api-ledger] flush threw: ${e && e.message}`);
    return 0;
  } finally { _flushing = false; }
}

function start(supabase, log = console) {
  if (_timer) return _timer;
  _timer = setInterval(() => { flush(supabase, log); }, FLUSH_MS);
  if (_timer.unref) _timer.unref();
  return _timer;
}

module.exports = {
  attach, record, flush, start, drain, normalizeRoute, actorFromRequest,
  KNOWN_PREFIXES, MAX_KEYS, FLUSH_MS,
};

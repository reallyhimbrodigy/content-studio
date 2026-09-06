'use strict';
// GET /api/install/seen?device_id= → {seen: bool}
//
// WHAT IT ANSWERS. "Has this device ever reached us before?" It is the third
// funnel proof: without it the frontend cannot separate a genuine first install
// from a reinstall, so install→signup was posed on debug data.
//
// TWO SOURCES, CHEAPEST FIRST.
//   1. free_credit_grants.device_id — the PRIMARY KEY, so this lookup is an
//      index hit and always cheap.
//   2. analytics_events.anon_user_id — the broad one (37,407 devices vs 5
//      grants on 2026-09-06), and the reason this file has a throttle.
//
// THE COST THAT SHAPED THIS FILE. anon_user_id has NO INDEX. Measured with
// EXPLAIN ANALYZE on production: a MISS seq-scans 531,590 rows and takes
// 5,324 ms. On an UNAUTHENTICATED endpoint that is a pool-exhaustion DoS — a
// dozen concurrent requests with random device ids would take the database
// down. So until the index exists this path is bounded three ways: a
// concurrency cap, a memo cache, and a hard timeout.
//
// THE INDEX THAT RETIRES THE THROTTLE:
//   CREATE INDEX CONCURRENTLY analytics_events_anon_user_idx
//     ON public.analytics_events (anon_user_id) WHERE anon_user_id IS NOT NULL;
// The throttle stays afterwards regardless — it is correct for a public
// endpoint either way — but the cap can be raised.
//
// NEVER FABRICATES A FALSE. A `seen:false` that really means "the lookup did
// not run" is the exact class of bug that produced four bogus zeros in one day.
// Every failure — no DB handle, throttled, timed out, query error — returns an
// ERROR, never a tidy negative.

const MAX_INFLIGHT = 4;          // concurrent uncached analytics lookups
const LOOKUP_TIMEOUT_MS = 4000;  // shorter than the measured 5.3s worst case
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 5000;

let inflight = 0;
const cache = new Map();         // device_id -> {seen, at}

function cacheGet(id) {
  const hit = cache.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(id); return null; }
  return hit;
}

function cacheSet(id, seen) {
  // A seen device never becomes unseen, so entries are safe to keep; the bound
  // is memory, not staleness.
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(id, { seen, at: Date.now() });
}

/**
 * Validated for SHAPE only — a length/charset bound, so a hostile caller cannot
 * push a megabyte of text into an unindexed query.
 *
 * THE CHARSET IS MEASURED, NOT GUESSED. The first version of this bound was
 * /^[A-Za-z0-9._:-]+$/, written from an invented UUID fixture. Production holds
 * TWO id shapes, counted 2026-09-06 over 37,410 devices:
 *   $RCAnonymousID:<32 hex>   47 chars   20,782 devices (55.6%)
 *   <uuid>                    36 chars   16,623 devices (44.4%)
 * The RevenueCat form starts with '$', which that bound rejected — it would
 * have 400'd the majority of real devices while every test stayed green,
 * because the fixture was invented rather than sampled.
 */
function validDeviceId(s) {
  return typeof s === 'string' && s.length >= 8 && s.length <= 128
    && /^[A-Za-z0-9._:$-]+$/.test(s);
}

async function withTimeout(p, ms) {
  let t;
  try {
    return await Promise.race([
      p,
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); }),
    ]);
  } finally { clearTimeout(t); }
}

/**
 * @returns {{status:number, body:object}} — 200 {seen}, or an error status.
 *   Never returns {seen:false} for a lookup that did not complete.
 */
async function installSeen(deviceId, db) {
  const id = String(deviceId || '').trim();
  if (!validDeviceId(id)) {
    return { status: 400, body: { error: 'bad_device_id' } };
  }
  if (!db) {
    // Loud, not a false. A missing service handle is a config defect.
    return { status: 503, body: { error: 'no_db' } };
  }

  const cached = cacheGet(id);
  if (cached) return { status: 200, body: { seen: cached.seen, cached: true } };

  // ── source 1: the grants PK. Always cheap, so never throttled. ───────────
  try {
    const g = await withTimeout(
      db.from('free_credit_grants').select('device_id').eq('device_id', id).limit(1),
      LOOKUP_TIMEOUT_MS);
    if (g && g.error) throw new Error(g.error.message || 'grants query failed');
    if (g && Array.isArray(g.data) && g.data.length > 0) {
      cacheSet(id, true);
      return { status: 200, body: { seen: true, source: 'grant' } };
    }
  } catch (e) {
    return { status: 503, body: { error: 'lookup_failed', where: 'grants' } };
  }

  // ── source 2: analytics. Unindexed today — hence the cap. ────────────────
  if (inflight >= MAX_INFLIGHT) {
    // 503 + Retry-After, never a fabricated `seen:false`.
    return { status: 503, body: { error: 'lookup_busy' }, retryAfter: 2 };
  }
  inflight++;
  try {
    const a = await withTimeout(
      db.from('analytics_events').select('anon_user_id').eq('anon_user_id', id).limit(1),
      LOOKUP_TIMEOUT_MS);
    if (a && a.error) throw new Error(a.error.message || 'analytics query failed');
    const seen = !!(a && Array.isArray(a.data) && a.data.length > 0);
    cacheSet(id, seen);
    return { status: 200, body: { seen, source: seen ? 'analytics' : 'none' } };
  } catch (e) {
    return {
      status: 503,
      body: { error: String(e && e.message) === 'timeout' ? 'lookup_timeout' : 'lookup_failed',
              where: 'analytics' },
      retryAfter: 2,
    };
  } finally {
    inflight--;
  }
}

// Test seam: the throttle is only observable if a test can drive it.
installSeen._state = () => ({ inflight, cacheSize: cache.size });
installSeen._reset = () => { inflight = 0; cache.clear(); };

module.exports = { installSeen, validDeviceId, MAX_INFLIGHT, LOOKUP_TIMEOUT_MS };

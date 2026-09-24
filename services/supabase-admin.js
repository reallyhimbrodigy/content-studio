const { createClient } = require('@supabase/supabase-js');
const _guard = require('../lib/origin-latency-guard');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
// NOTE: Supabase service role key is only used on the server; never expose client-side.

// ── EVERY ORIGIN ROUND TRIP IS TIMED, FROM ONE PLACE ─────────────────────
//
// lib/origin-latency-guard.js was written, gated and INERT: nothing called
// observe(), so it watched an empty stream and could never fire. A guard with
// no producer is the consumer-with-no-producer shape this repo keeps paying
// for, and it is the reason the 2026-09-24 slowdown had no alarm attached to
// it at all.
//
// The wiring point is the CLIENT'S FETCH, not the call sites. supabase-js
// takes a custom fetch, so one function covers every PostgREST read, write and
// RPC in the process — including the ones nobody remembers to instrument — and
// it carries a real HTTP STATUS, which the 5xx arm needs. Wrapping call sites
// instead would be dozens of edits and a permanent gap the day someone adds
// the next one.
//
// A REJECTED FETCH IS A 5xx, DELIBERATELY. During the outage Supabase was
// unreachable and the call never completed — no status at all. Recording that
// as "no status" would drop it out of BOTH sides of the error rate, so the
// instrument would be quietest exactly when the origin is most broken. It is
// recorded as 599 (a non-status, above the 5xx bar) so it counts as bad.
function _timedFetch(...args) {
  const t0 = Date.now();
  return fetch(...args).then(
    (r) => { _guard.observe(Date.now() - t0, Date.now(), { status: r.status }); return r; },
    (e) => { _guard.observe(Date.now() - t0, Date.now(), { status: 599 }); throw e; },
  );
}

let supabaseAdmin = null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('⚠️ Supabase admin client is not fully configured.');
} else {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: { fetch: _timedFetch },
  });
}

module.exports = { supabaseAdmin, _timedFetch };

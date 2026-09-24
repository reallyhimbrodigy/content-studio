'use strict';
// WE HEAR ABOUT THE DATABASE BEFORE USERS DO.
//
// On 2026-09-24 the Supabase project went from 108ms average origin time at
// 00:30 to 4,134ms at 00:35, 5,720ms at 00:40, and dead at 00:41. Eleven
// minutes of visible, monotonic degradation that nobody was told about —
// including me: I hit three query timeouts in that window, read them as "big
// table, transient load", and moved on.
//
// ── IT MEASURES OUR OWN CALLS, NOT AN EDGE REPORT ──────────────────────────
// The ask was "edge origin-time p95". We cannot read Cloudflare's edge log
// from the server, and polling a dashboard for it would add a dependency that
// dies with the thing it is watching. So this times OUR OWN Supabase calls in
// process. That is strictly better for this purpose: it measures what the
// server actually experiences, it needs nothing to be up except us, and it
// cannot disagree with reality the way a second source can.
//
// ── p95 OVER A WINDOW, AND THE WINDOW IS WHY ───────────────────────────────
// A single slow query is normal — a 44-second analytics insert happened on a
// healthy day. A p95 that STAYS above the bar is the signal, which is why the
// rule is "3 consecutive minutes" and not "one sample". An average would have
// been worse: the mean is dragged by exactly the long tail that occurs
// harmlessly, and it hides a bimodal split where most calls are fine and a
// growing slice is not.
//
// ── IT MUST NOT PAGE ON A COLD START OR A QUIET MINUTE ─────────────────────
// A p95 over four samples is not a p95. MIN_SAMPLES exists so a deploy at 3am
// with two requests cannot produce a percentile and a page — the same "a
// median of three is a number that looks like knowledge" rule the ETA field
// already follows.

const WINDOW_MS = 60 * 1000;        // one bucket per minute
const BREACH_MINUTES = 3;           // consecutive minutes over the bar
const P95_BAR_MS = 2000;            // Zac's bar
const MIN_SAMPLES = 20;             // below this a percentile is theatre
// THE SECOND CONDITION, per Zac: 5xx over 20% for 2 minutes. It catches a
// failure the latency bar CANNOT — a database that answers FAST AND WRONG.
// On 2026-09-24 origin time climbed for eleven minutes before the 522s
// started, so latency was the early signal; but a connection pool that
// refuses instantly produces a flood of quick 5xx and a p95 that looks
// HEALTHIER than normal. One bar would have called that recovery.
const ERR_RATE_BAR = 0.20;
const ERR_BREACH_MINUTES = 2;
const REARM_MS = 30 * 60 * 1000;    // do not re-page for half an hour

let _bucket = { startedAt: 0, samples: [] };
let _breaches = 0;
let _errBreaches = 0;
let _errBucket = { n: 0, bad: 0 };
let _lastPagedAt = 0;
let _sink = null;                   // injected: (title, body) => Promise

function configure({ sink } = {}) { _sink = sink || null; }

function _p95(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  // Nearest-rank, so a 20-sample window reports a real observation rather
  // than an interpolation between two of them.
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

/** Record one Supabase round trip. Never throws — an instrument that can
 *  break the thing it measures is worse than no instrument. */
function observe(ms, now = Date.now(), { status } = {}) {
  try {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (!_bucket.startedAt) _bucket.startedAt = now;
    if (now - _bucket.startedAt >= WINDOW_MS) {
      _roll(now);
    }
    _bucket.samples.push(ms);
    // STATUS IS OPTIONAL AND ABSENT IS NOT A SUCCESS. A caller that does not
    // report one contributes to neither side of the rate, rather than being
    // counted as a 2xx and diluting it.
    if (status !== undefined && status !== null) {
      _errBucket.n += 1;
      if (Number(status) >= 500) _errBucket.bad += 1;
    }
  } catch (_) { /* never */ }
}

function _roll(now) {
  const n = _bucket.samples.length;
  const p95 = _p95(_bucket.samples);
  _bucket = { startedAt: now, samples: [] };

  // A MINUTE WITH TOO FEW SAMPLES IS NOT A PASS AND NOT A FAIL — it is
  // UNMEASURED, and it leaves the breach counter alone. Resetting it would let
  // one quiet minute launder an outage: slow, slow, quiet, slow would never
  // reach three.
  if (n < MIN_SAMPLES || p95 === null) {
    console.log(`[origin-latency] UNMEASURED minute (${n} samples, need ${MIN_SAMPLES}) `
      + `— breach streak held at ${_breaches}`);
    return;
  }
  // THE ERROR RATE ROLLS ON THE SAME MINUTE, with its own floor: a rate over
  // four requests is not a rate.
  const _en = _errBucket.n, _ebad = _errBucket.bad;
  _errBucket = { n: 0, bad: 0 };
  if (_en >= MIN_SAMPLES) {
    const rate = _ebad / _en;
    if (rate > ERR_RATE_BAR) {
      _errBreaches += 1;
      console.warn(`[origin-latency] 5xx rate ${(rate * 100).toFixed(0)}% over `
        + `${ERR_RATE_BAR * 100}% (${_ebad}/${_en}) — ${_errBreaches}/${ERR_BREACH_MINUTES}`);
      if (_errBreaches >= ERR_BREACH_MINUTES) _page(p95 === null ? -1 : p95, _en, now, 'errors');
    } else {
      _errBreaches = 0;
    }
  }

  if (p95 > P95_BAR_MS) {
    _breaches += 1;
    console.warn(`[origin-latency] p95=${p95}ms over ${P95_BAR_MS}ms `
      + `(${n} samples) — ${_breaches}/${BREACH_MINUTES} consecutive`);
    if (_breaches >= BREACH_MINUTES) _page(p95, n, now);
  } else {
    if (_breaches) console.log(`[origin-latency] recovered, p95=${p95}ms (${n} samples)`);
    _breaches = 0;
  }
}

function _page(p95, n, now, why = 'latency') {
  // NEVER-PAGED IS NOT PAGED-AT-EPOCH. _lastPagedAt starts at 0, and treating
  // that as a timestamp makes `now - 0 < REARM_MS` true for any clock under
  // 30 minutes — so the very first page is suppressed. Absent rendered as a
  // value, in the re-arm of the guard written to catch an absence. Found by
  // L2, which is exactly what a check is for.
  if (_lastPagedAt && now - _lastPagedAt < REARM_MS) return;   // one page, not a storm
  _lastPagedAt = now;
  const title = why === 'errors'
    ? '🔥 [Promptly] 5xx rate over 20%'
    : '🐢 [Promptly] database slowing down';
  const body = why === 'errors'
    ? `more than ${ERR_RATE_BAR * 100}% of origin calls are 5xx for `
      + `${ERR_BREACH_MINUTES} min (${n}/min). This can look FAST — a pool that `
      + 'refuses instantly has a healthy p95.'
    : `origin p95 ${Math.round(p95)}ms for ${BREACH_MINUTES} min (${n}/min). `
      + 'Supabase is degrading — check CPU/IO before it stops answering.';
  console.error(`[ALERT] ${title} — ${body}`);
  if (!_sink) {
    // NOT SILENT. An alert path with no sink is the consumer-with-no-producer
    // shape, and it would look like "no alerts fired".
    console.error('[origin-latency] NO SINK CONFIGURED — the page was logged and sent nowhere.');
    return;
  }
  Promise.resolve(_sink(title, body)).catch((e) =>
    console.error('[origin-latency] sink failed:', e && e.message));
}

/** Wrap a promise-returning DB call so its latency is recorded either way.
 *  A FAILED call is timed TOO: the 44-second insert that never returns is
 *  exactly the sample worth having, and dropping errors would make the
 *  instrument healthiest at the moment things are worst. */
async function timed(fn) {
  const t0 = Date.now();
  try { return await fn(); }
  finally { observe(Date.now() - t0); }
}

function _state() {
  return { breaches: _breaches, errBreaches: _errBreaches,
           errN: _errBucket.n, errBad: _errBucket.bad,
           samples: _bucket.samples.length,
           lastPagedAt: _lastPagedAt, bar: P95_BAR_MS, minSamples: MIN_SAMPLES };
}
function _reset() {
  _bucket = { startedAt: 0, samples: [] };
  _errBucket = { n: 0, bad: 0 };
  _breaches = 0; _errBreaches = 0; _lastPagedAt = 0;
}

module.exports = { observe, timed, configure, _p95, _state, _reset,
                   WINDOW_MS, BREACH_MINUTES, P95_BAR_MS, MIN_SAMPLES, REARM_MS,
                   ERR_RATE_BAR, ERR_BREACH_MINUTES };

'use strict';
// WHY THIS EXISTS. A path that ships DARK and refuses is correct behaviour, but
// a dark path that leaves NO TRACE is unobservable — and today that cost real
// time. `FREE_CREDITS_MIN_BUILD` being unset silently disabled the entire
// credits debit while /healthz reported `debit_armed: true`, and the only way to
// establish it was elimination across five conjuncts, because there was nothing
// to grep. The env var was doing exactly what it was designed to do; the
// problem was that nobody could see it doing it.
//
// THE WINDOW IS PART OF THE NUMBER. These counters are in-memory, so a deploy or
// an instance cycle zeroes them. "refused 40 times" is unreadable without
// knowing whether that is a day or ten minutes — the same contaminated-cohort
// mistake `localeStats` already fixed, so this follows that shape deliberately.
//
// THROTTLED, because this sits on a request path a whole installed base can hit.
// One line per reason per interval, carrying the COUNT, is a denominator; one
// line per request is noise that gets filtered and then ignored.

const LOG_INTERVAL_MS = 5 * 60 * 1000;
const _counts = new Map();          // reason -> { n, firstAt, lastAt, lastLoggedAt }
let _since = Date.now();

function observeDarkRefusal(reason, detail) {
  const key = String(reason || 'unknown');
  const now = Date.now();
  let c = _counts.get(key);
  if (!c) {
    c = { n: 0, firstAt: now, lastAt: now, lastLoggedAt: 0 };
    _counts.set(key, c);
  }
  c.n += 1;
  c.lastAt = now;
  // Always log the FIRST one immediately. A path that starts refusing should be
  // visible now, not in five minutes — the first occurrence is the signal, the
  // rest are volume.
  if (c.n === 1 || now - c.lastLoggedAt >= LOG_INTERVAL_MS) {
    c.lastLoggedAt = now;
    console.log('  [dark-refusal] %s n=%d window_s=%d%s',
      key, c.n, Math.round((now - c.firstAt) / 1000),
      detail ? ' ' + String(detail).slice(0, 120) : '');
  }
  return c.n;
}

function darkRefusalStats() {
  const now = Date.now();
  const out = {};
  for (const [k, c] of _counts) {
    out[k] = { n: c.n, window_s: Math.round((now - c.firstAt) / 1000) };
  }
  return { since: new Date(_since).toISOString(),
           window_s: Math.round((now - _since) / 1000),
           reasons: out };
}

function _resetForTests() { _counts.clear(); _since = Date.now(); }

module.exports = { observeDarkRefusal, darkRefusalStats, _resetForTests,
                   LOG_INTERVAL_MS };

'use strict';
// EVERY PAGE THE GUARD FIRES IS RECORDED, WHETHER OR NOT ANYONE SAW IT.
//
// Zac 2026-09-24: "ops-alert returns UNDELIVERED / no_tokens, which is a
// machine-readable miss, not success into the void. Wire it today, and log
// every fire to a line or table you can query, so fires before Zac has a token
// are still visible."
//
// That is the whole design. The page and its DELIVERY are two different facts:
//
//   FIRED       the guard decided the origin is in trouble
//   DELIVERED   a device actually took the notification
//
// device_tokens is 0 for the owner today, so every fire right now is
// FIRED + UNDELIVERED(no_tokens). Reading that as "nothing fired" is the
// mistake — it is the act-versus-fact confusion that made the scoreboard log
// "written" 144 times a day about a row that does not exist. So the fire is
// recorded FIRST, from the guard's own decision, and the delivery result is
// attached afterwards as a separate field.
//
// THREE SINKS, DELIBERATELY, because each fails differently:
//   1. a single greppable log line — works with nothing applied, survives a
//      DB outage, and a DB outage is exactly when this fires
//   2. an in-memory ring on /healthz — queryable with a curl RIGHT NOW,
//      before any migration, which is what "still visible" has to mean today
//   3. a row in ops_alert_fires — durable across restarts, once Zac applies
//      20260924_ops_alert_fires.sql. Absent -> ONE loud line, never silence.

const RING_MAX = 50;
const _ring = [];
let _tableMissingLogged = false;

/** Newest first. Exposed on /healthz as `ops_fires`. */
function recent(n = 10) {
  return _ring.slice(0, Math.max(0, n));
}

function _line(rec) {
  // ONE LINE, FIXED KEYS, GREPPABLE. `[ops-fire]` is the needle.
  return `[ops-fire] at=${rec.at} why=${rec.why} p95_ms=${rec.p95_ms} `
    + `samples=${rec.samples} delivery=${rec.delivery} reason=${rec.reason} `
    + `delivered=${rec.delivered} recipients=${rec.recipients}`;
}

/**
 * Record one fire. Never throws — an instrument that can break the thing it
 * measures is worse than no instrument.
 *
 * `delivery` is one of DELIVERED / UNDELIVERED / UNKNOWN / NOT_ATTEMPTED, and
 * UNKNOWN is never folded into either neighbour: read as delivered it hides an
 * outage, read as failed it triggers a retry for an alert that already landed.
 */
async function record(rec, { supabaseAdmin = null, log = console } = {}) {
  const row = {
    at: new Date(rec.at || Date.now()).toISOString(),
    why: String(rec.why || 'unknown'),
    p95_ms: Number.isFinite(rec.p95_ms) ? Math.round(rec.p95_ms) : null,
    samples: Number.isFinite(rec.samples) ? rec.samples : null,
    delivery: String(rec.delivery || 'NOT_ATTEMPTED'),
    reason: String(rec.reason || ''),
    delivered: Number.isFinite(rec.delivered) ? rec.delivered : 0,
    recipients: Number.isFinite(rec.recipients) ? rec.recipients : 0,
    title: String(rec.title || '').slice(0, 200),
  };
  try { log.error(_line(row)); } catch (_) { /* a log must never fail a fire */ }
  _ring.unshift(row);
  while (_ring.length > RING_MAX) _ring.pop();

  if (!supabaseAdmin) return row;
  try {
    const { error } = await supabaseAdmin.from('ops_alert_fires').insert(row);
    if (error) {
      // ONCE, not every fire: a missing table during an origin incident would
      // otherwise add its own noise to the log you are trying to read.
      if (!_tableMissingLogged) {
        _tableMissingLogged = true;
        log.error('[ops-fire] ops_alert_fires INSERT FAILED — fires are in the log '
          + `and on /healthz only, not durable. Apply supabase/migrations/`
          + `20260924_ops_alert_fires.sql. (${error.message})`);
      }
    }
  } catch (e) {
    if (!_tableMissingLogged) {
      _tableMissingLogged = true;
      log.error('[ops-fire] ops_alert_fires insert threw:', e && e.message);
    }
  }
  return row;
}

function _reset() { _ring.length = 0; _tableMissingLogged = false; }

module.exports = { record, recent, _reset, RING_MAX, _line };

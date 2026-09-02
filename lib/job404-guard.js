'use strict';

// Runaway-poll guard for GET /api/video-jobs/:jobId.
//
// A client on ANY shipped build that polls a job_id which will never resolve for
// it hits the DB roughly 1.3x/second forever: 38,070 such 404s were recorded in
// one 24h window from <=5 users/minute. Two roots, both terminal for the caller:
//   * job_never_existed  — the id was never written (upload/create never landed)
//   * identity_mismatch  — the row exists under a DIFFERENT user_id (anon->authed
//                          / billing-identity churn), so the user-scoped read 404s
// The client ignores 429, so no app release can stop the loop. What we CAN do is
// stop those requests reaching Supabase: allow the first few polls per (user,job)
// through (so a normal create-race resolves), then short-circuit every later poll
// in memory. DB contact per stuck id drops from thousands to a handful.
//
// Pure and dependency-free so the guard's cap is unit-testable without a server or
// a database — see lib/__smoke_jobstatus_404_guard.js, which makes the runaway
// regression impossible at deploy.

const DEFAULTS = {
  ttlMs: 10 * 60 * 1000, // remember a dead (user,job) for 10 minutes
  shortCircuitAfter: 3, // let create-race polls through, then cap
  maxEntries: 20000, // bounded memory ceiling
};

function makeJob404Guard(opts = {}) {
  const { ttlMs, shortCircuitAfter, maxEntries } = { ...DEFAULTS, ...opts };
  const map = new Map(); // key -> { count, first, last, cause, emitted }

  function prune(now) {
    if (map.size <= maxEntries) return;
    for (const [k, e] of map) if (now - e.last > ttlMs) map.delete(k);
    if (map.size > maxEntries) {
      // Still over ceiling after expiring stale entries: drop the oldest ~10%
      // (Map preserves insertion order, so the first keys are the oldest).
      const drop = Math.ceil(maxEntries * 0.1);
      let i = 0;
      for (const k of map.keys()) {
        map.delete(k);
        if (++i >= drop) break;
      }
    }
  }

  return {
    // Called BEFORE the DB query. If a confirmed-dead id is being hammered, returns
    // shortCircuit:true and the caller MUST answer without touching the database.
    check(key, now) {
      const e = map.get(key);
      if (e && now - e.last < ttlMs && e.count >= shortCircuitAfter) {
        e.count++;
        e.last = now;
        return { shortCircuit: true, cause: e.cause, count: e.count };
      }
      return { shortCircuit: false, cause: e ? e.cause : null, count: e ? e.count : 0 };
    },

    // Called AFTER a DB 404, with the probed cause. Returns:
    //   count       — total 404s seen for this (user,job)
    //   shortCircuit — whether this and later polls should now skip the DB
    //   emitFirst   — true EXACTLY once per (user,job), so the caller can persist
    //                 the cause once (not on every one of thousands of polls)
    record404(key, cause, now) {
      const e = map.get(key) || { count: 0, first: now, last: now, cause, emitted: false };
      e.count++;
      e.last = now;
      e.cause = cause;
      const emitFirst = !e.emitted;
      e.emitted = true;
      map.set(key, e);
      prune(now);
      return { count: e.count, shortCircuit: e.count >= shortCircuitAfter, emitFirst };
    },

    // The id resolved (a 200) — forget it so a genuinely new 404 later starts fresh.
    clear(key) {
      map.delete(key);
    },

    size() {
      return map.size;
    },
  };
}

module.exports = { makeJob404Guard, DEFAULTS };

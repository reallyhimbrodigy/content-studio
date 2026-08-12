'use strict';
// THE DAILY SCOREBOARD, IN-PROCESS — no separate Render service to exist or not.
//
// JUDGE's daily row was wired as a NEW `daily-scoreboard` cron service in
// render.yaml. Whether that service exists has been [UNKNOWN] since it was
// added: the same blueprint-sync question that turned out to be REAL for the
// build gate (npm install runs on Render; `node validate_deploy.js` does not).
// A scoreboard nobody can prove runs is a scoreboard nobody can trust, and its
// absence is silent — it leaves no trace either way, because with the table
// un-migrated it falls back to a JSONL file on an ephemeral disk.
//
// So it moves into the process that is definitely running: the web service.
// One boot, one timer, and a CATCH-UP that makes a missed day self-heal.
//
// IDEMPOTENT BY CONSTRUCTION. The scoreboard upserts one row per UTC day, so
// running it twice for the same day is a no-op overwrite, not a double count.
// That is what makes catch-up safe to run on EVERY boot — and boots are
// frequent (every deploy), which is exactly why it must be safe rather than
// merely usually-harmless.
//
// This adds no new instrument and no new watch: it is the same scoreboard,
// relocated to somewhere provable.

const path = require('path');
const { spawn } = require('child_process');

const RUN_HOUR_UTC = 15;            // JUDGE's 15:00 UTC slot, unchanged
const CHECK_MS = 10 * 60 * 1000;    // coarse tick; the day-guard does the real work
const SCRIPT = path.join(__dirname, '..', 'scripts', 'scoreboard.js');

function utcDayString(d) {
  return d.toISOString().slice(0, 10);
}

/** The UTC day the scoreboard should have covered by now (it reports yesterday). */
function dueDay(now) {
  const d = new Date(now.getTime());
  // Before 15:00 UTC today, the newest day we owe is the day before yesterday's
  // run; at/after 15:00 we owe yesterday.
  d.setUTCDate(d.getUTCDate() - (now.getUTCHours() >= RUN_HOUR_UTC ? 1 : 2));
  return utcDayString(d);
}

/**
 * Run the scoreboard for one day. Fire-and-forget, never throws, never blocks
 * a request: a reporting job must not be able to take the server down.
 */
function runFor(day, { log = console } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [SCRIPT, '--day', day], {
        cwd: path.join(__dirname, '..'),
        stdio: 'ignore',
        detached: false,
      });
    } catch (e) {
      log.error(`[scoreboard] could not spawn for ${day}: ${e && e.message}`);
      return resolve(false);
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      log.error(`[scoreboard] ${day} exceeded its 10m budget — killed`);
      resolve(false);
    }, 10 * 60 * 1000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) log.error(`[scoreboard] ${day} written`);
      else log.error(`[scoreboard] ${day} exited ${code}`);
      resolve(code === 0);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      log.error(`[scoreboard] ${day} failed: ${e && e.message}`);
      resolve(false);
    });
  });
}

/**
 * Start the scheduler. Returns a handle with stop() for tests.
 *
 * `hasRow(day)` is injected so this module never owns a DB client: the caller
 * (server.js) already has supabaseAdmin. When it cannot tell (table missing,
 * query error), it returns null and we DO NOT run — an unknown is not a
 * missing row, and re-running blindly on every boot would hammer the judge.
 */
function startScoreboardScheduler({ hasRow, log = console, now = () => new Date(),
  intervalMs = CHECK_MS } = {}) {
  let stopped = false;
  let running = false;

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const day = dueDay(now());
      const present = await hasRow(day);
      if (present === null || present === undefined) {
        // Cannot tell — say so once per tick and do nothing. Silence here is
        // how "the scoreboard stopped" would hide.
        log.error(`[scoreboard] cannot determine whether ${day} exists — not running`);
      } else if (present === false) {
        log.error(`[scoreboard] ${day} missing — catching up`);
        await runFor(day, { log });
      }
    } catch (e) {
      log.error('[scoreboard] tick failed (non-fatal):', e && e.message);
    } finally {
      running = false;
    }
  }

  // CATCH-UP ON BOOT: the whole point. A deploy, a restart or a missed window
  // self-heals on the next boot instead of leaving a permanent hole in the row
  // series — and because the write is an upsert keyed by day, a boot storm
  // cannot double-count.
  const first = setTimeout(tick, 5000);   // let the server finish booting first
  const iv = setInterval(tick, intervalMs);
  if (iv.unref) iv.unref();
  if (first.unref) first.unref();

  return {
    stop() { stopped = true; clearTimeout(first); clearInterval(iv); },
    _tick: tick,
  };
}

module.exports = { startScoreboardScheduler, dueDay, utcDayString, RUN_HOUR_UTC };

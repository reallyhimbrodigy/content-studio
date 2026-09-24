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

// ── THE RUNAWAY, AND WHY IT WAS INVISIBLE (2026-09-24) ───────────────────
//
// This scheduler spawned the scoreboard EVERY TEN MINUTES, ON EVERY INSTANCE,
// FOR FIVE DAYS. Each spawn ran the fulfilment judge, which walked the entire
// completed history of video_jobs — 9,210 rows of TOASTed jsonb, ~90 MB a
// pass. 244 calls / 652 s of database time in under four hours [MEASURED,
// pg_stat_statements], straight through the outage window.
//
// It could not stop, because the row it was catching up on could never be
// written: `scripts/scoreboard.js` had gained nine `agentic_*` keys (a122697,
// 2026-09-19) that daily_scoreboard has no columns for, so PostgREST rejected
// every upsert. The last row the scoreboard ever wrote is 2026-09-18 — the day
// before. hasRow() returned false forever; the catch-up fired forever.
//
// THREE INDEPENDENT MECHANISMS HID IT, and each one is fixed below:
//   1. `stdio: 'ignore'` DISCARDED the child's own diagnosis. The child printed
//      "TABLE WRITE FAILED (400 ...)" on every run and nobody ever saw it.
//   2. scoreboard.js EXITED 0 on a failed write.
//   3. and this file logged "written" FROM THE EXIT CODE — reporting the ACT
//      instead of the FACT. Render's log says `[scoreboard] 2026-09-22
//      written` 144 times a day about a row that does not exist.
//
// So: read the row back, never the exit code; keep the child's stderr; and
// BACK OFF — a catch-up that cannot succeed must stop, not loop. The retry
// budget is the check that makes this regression impossible: even a brand-new
// reason the write fails costs three runs a day, not a hundred and forty-four.
const FAIL_BACKOFF_MS = 60 * 60 * 1000;   // after a run that leaves the row missing
const MAX_ATTEMPTS_PER_DAY = 3;           // then give up LOUDLY until the next day
const STDERR_KEEP = 2000;                 // bytes of the child's tail to surface

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
// `script` is injectable for ONE reason: LAW 7 (the child's stderr must reach
// the log) is a property of THIS function's spawn options, and a smoke that
// asserts it by reading the source cannot tell code from a comment. That has
// cost this pair of builders five separate false greens. So the smoke drives
// the real runFor against a two-line child instead.
function runFor(day, { log = console, script = SCRIPT } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [script, '--day', day], {
        cwd: path.join(__dirname, '..'),
        // stderr is PIPED, not ignored. The child has been printing the cause
        // of this exact failure on every run for five days into /dev/null.
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: false,
      });
    } catch (e) {
      log.error(`[scoreboard] could not spawn for ${day}: ${e && e.message}`);
      return resolve({ exited: false, code: null, stderr: String((e && e.message) || '') });
    }
    let stderr = '';
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => {
        stderr += d;
        if (stderr.length > STDERR_KEEP * 2) stderr = stderr.slice(-STDERR_KEEP);
      });
    }
    const done = (rec) => resolve({ ...rec, stderr: stderr.slice(-STDERR_KEEP) });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      log.error(`[scoreboard] ${day} exceeded its 10m budget — killed`);
      done({ exited: false, code: null });
    }, 10 * 60 * 1000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      // DELIBERATELY SAYS NOTHING ABOUT THE ROW. Whether the row exists is a
      // question only the table can answer, and the caller asks it.
      if (code !== 0) log.error(`[scoreboard] ${day} exited ${code}`);
      done({ exited: true, code });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      log.error(`[scoreboard] ${day} spawn failed: ${e && e.message}`);
      done({ exited: false, code: null });
    });
  });
}

/**
 * Start the scheduler. Returns a handle with stop() for tests.
 *
 * `run` is injected too, and only so the SMOKE can assert the catch-up decision
 * without spawning the real scoreboard. That is not a nicety: the smoke runs
 * inside validate_deploy's 60s-per-smoke budget, and a real child that loads
 * dotenv and queries Supabase made the gate FLAKY — which, now that postinstall
 * arms the gate on Render, would mean random build failures. A flaky gate is
 * worse than a missing one.
 *
 * `hasRow(day)` is injected so this module never owns a DB client: the caller
 * (server.js) already has supabaseAdmin. When it cannot tell (table missing,
 * query error), it returns null and we DO NOT run — an unknown is not a
 * missing row, and re-running blindly on every boot would hammer the judge.
 */
function startScoreboardScheduler({ hasRow, log = console, now = () => new Date(),
  intervalMs = CHECK_MS, run = runFor,
  failBackoffMs = FAIL_BACKOFF_MS, maxAttempts = MAX_ATTEMPTS_PER_DAY } = {}) {
  let stopped = false;
  let running = false;
  // day -> {n, nextAt, gaveUp}. Bounded: only the due day and its immediate
  // neighbours are ever keyed, and stale days are pruned each tick.
  const attempts = new Map();

  function budget(day, t) {
    let st = attempts.get(day);
    if (!st) { st = { n: 0, nextAt: 0, gaveUp: false }; attempts.set(day, st); }
    for (const k of attempts.keys()) if (k < day && k < new Date(t - 3 * 86400e3).toISOString().slice(0, 10)) attempts.delete(k);
    return st;
  }

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const t = now().getTime();
      const day = dueDay(now());
      const present = await hasRow(day);
      if (present === null || present === undefined) {
        // Cannot tell — say so once per tick and do nothing. Silence here is
        // how "the scoreboard stopped" would hide.
        log.error(`[scoreboard] cannot determine whether ${day} exists — not running`);
        return;
      }
      if (present) { attempts.delete(day); return; }

      const st = budget(day, t);
      if (st.n >= maxAttempts) {
        if (!st.gaveUp) {
          st.gaveUp = true;
          log.error(`[scoreboard] GIVING UP on ${day} after ${st.n} attempts — the row is still missing `
            + 'and re-running cannot help. This is a DEFECT in the scoreboard write path, not a transient. '
            + 'See the stderr tail above for the cause.');
        }
        return;
      }
      if (t < st.nextAt) return;   // in backoff; quiet by design

      st.n += 1;
      st.nextAt = t + failBackoffMs;
      log.error(`[scoreboard] ${day} missing — catching up (attempt ${st.n}/${maxAttempts})`);
      const rec = await run(day, { log });

      // ── READ THE ROW, NOT THE EXIT CODE ──────────────────────────────
      // The previous version logged "written" whenever the child exited 0.
      // The child exits 0 on a FAILED upsert, so that line was false 144
      // times a day for five days.
      const after = await hasRow(day);
      if (after === true) {
        log.error(`[scoreboard] ${day} written (row read back)`);
        attempts.delete(day);
      } else {
        const tail = (rec && rec.stderr ? String(rec.stderr) : '').trim().split('\n').slice(-6).join(' | ');
        log.error(`[scoreboard] ${day} RAN BUT THE ROW IS STILL ${after === false ? 'MISSING' : 'UNREADABLE'}`
          + ` — next attempt no sooner than ${Math.round(failBackoffMs / 60000)}m`
          + (tail ? ` — child stderr: ${tail}` : ' — child printed nothing to stderr'));
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

module.exports = {
  startScoreboardScheduler, dueDay, utcDayString, runFor,
  RUN_HOUR_UTC, FAIL_BACKOFF_MS, MAX_ATTEMPTS_PER_DAY,
};

'use strict';
// Gate for the in-process daily scoreboard (2026-08-12).
//
// It replaced a render.yaml cron service whose existence was [UNKNOWN] — the
// same blueprint-sync question that turned out to be REAL for the build gate
// (npm install runs on Render; `node validate_deploy.js` did not). A scoreboard
// nobody can prove runs is a scoreboard nobody can trust.
//
// Laws:
//   1. CATCH-UP RUNS when the due day's row is missing — that is the whole
//      point; a deploy or a missed window must self-heal on the next boot.
//   2. IT DOES NOT RUN when the row is already there (the upsert would be
//      harmless, but a job that fires on every boot regardless is a job nobody
//      will leave enabled).
//   3. UNKNOWN IS NOT MISSING. A table-absent or errored probe returns null and
//      must NOT trigger a run — running blind on every boot would hammer the
//      judge, and it is the exact "confident zero" class this codebase keeps
//      paying for.
//   4. A failing probe must NEVER throw into boot.
//   5. The due day is the day the scoreboard OWES, which depends on whether
//      15:00 UTC has passed.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  startScoreboardScheduler, dueDay, RUN_HOUR_UTC,
} = require('./scoreboard-scheduler');

// ── LAW 5: the due-day boundary
assert.strictEqual(RUN_HOUR_UTC, 15, 'the 15:00 UTC slot is JUDGE\'s, do not drift it');
assert.strictEqual(dueDay(new Date('2026-08-12T16:00:00Z')), '2026-08-11',
  'after 15:00 UTC we owe yesterday');
assert.strictEqual(dueDay(new Date('2026-08-12T09:00:00Z')), '2026-08-10',
  'before 15:00 UTC yesterday is not owed yet — owing it would run a partial day');
assert.strictEqual(dueDay(new Date('2026-08-01T15:00:00Z')), '2026-07-31',
  'month boundary must roll back correctly');

const calls = [];
const quiet = { error: (...a) => calls.push(String(a[0])) };

function harness(hasRow) {
  const ran = [];
  const sched = startScoreboardScheduler({
    hasRow, log: quiet, intervalMs: 1e9,
    now: () => new Date('2026-08-12T16:00:00Z'),
  });
  // Replace the spawn path by asserting on the log line the tick emits; the
  // real run is a child process and this smoke must not spawn one.
  return { sched, ran };
}

(async () => {
  // ── LAW 3: unknown must NOT run
  calls.length = 0;
  let h = harness(async () => null);
  await h.sched._tick();
  h.sched.stop();
  assert.ok(calls.some((c) => /cannot determine/.test(c)),
    'LAW 3: an unreadable probe must say so');
  assert.ok(!calls.some((c) => /catching up/.test(c)),
    'LAW 3: UNKNOWN must never trigger a run — that is the confident-zero class');

  // ── LAW 2: present row must NOT run
  calls.length = 0;
  h = harness(async () => true);
  await h.sched._tick();
  h.sched.stop();
  assert.ok(!calls.some((c) => /catching up/.test(c)),
    'LAW 2: an existing row must not be recomputed on every boot');
  assert.ok(!calls.some((c) => /cannot determine/.test(c)));

  // ── LAW 1: missing row DOES catch up (log proves the decision; the child
  // process itself is out of scope for a smoke)
  calls.length = 0;
  h = harness(async () => false);
  const p = h.sched._tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.some((c) => /missing — catching up/.test(c)),
    'LAW 1: a missing due-day row MUST trigger catch-up');
  h.sched.stop();
  await p.catch(() => {});

  // ── LAW 4: a throwing probe must not escape
  calls.length = 0;
  h = harness(async () => { throw new Error('boom'); });
  await h.sched._tick();   // must not reject
  h.sched.stop();
  assert.ok(calls.some((c) => /tick failed|cannot determine/.test(c)),
    'LAW 4: a throwing probe must be caught and logged, never thrown into boot');

  // ── WIRING: server.js must actually start it, and the scoreboard script the
  // scheduler shells out to must exist.
  const sv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/startScoreboardScheduler\s*\(/.test(sv),
    'server.js must start the scheduler — a scheduler nothing starts is the cron service all over again');
  assert.ok(/daily_scoreboard/.test(sv),
    'server.js must inject a hasRow probe against daily_scoreboard');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'scoreboard.js')),
    'scripts/scoreboard.js is gone — the scheduler has nothing to run');

  console.log('[smoke] scoreboard scheduler: ALL PASS (due-day boundary incl. month roll, '
    + 'catch-up on missing, silent on present, UNKNOWN never runs, throwing probe never '
    + 'escapes boot, server.js wiring)');
  process.exit(0);
})().catch((e) => {
  console.error('scoreboard-scheduler smoke FAILED:', e && e.message);
  process.exit(1);
});

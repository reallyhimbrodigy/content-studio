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
  FAIL_BACKOFF_MS, MAX_ATTEMPTS_PER_DAY, runFor,
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

// A harness whose hasRow answers from a mutable box, so the SECOND probe (the
// read-back after the run) can differ from the first — which is the whole
// difference between reporting the act and reporting the fact.
function boxHarness(box, opts = {}) {
  const ran = [];
  let t = Date.parse('2026-08-12T16:00:00Z');
  const sched = startScoreboardScheduler({
    hasRow: async () => box.present,
    log: quiet,
    intervalMs: 1e9,
    now: () => new Date(t),
    run: async (day) => { ran.push(day); if (box.writeSucceeds) box.present = true; return { exited: true, code: box.exitCode ?? 0, stderr: box.stderr || '' }; },
    failBackoffMs: opts.failBackoffMs ?? 60 * 60 * 1000,
    maxAttempts: opts.maxAttempts ?? 3,
  });
  return { sched, ran, advance: (ms) => { t += ms; } };
}

function harness(hasRow) {
  // The runner is INJECTED so this smoke never spawns the real scoreboard.
  // It once did, and a child that loads dotenv and queries Supabase blew
  // validate_deploy's 60s-per-smoke budget on a cold run — one red gate out of
  // four. With postinstall now arming the gate on Render, a flaky smoke means
  // random build failures, which is worse than no gate at all.
  const ran = [];
  const sched = startScoreboardScheduler({
    hasRow, log: quiet, intervalMs: 1e9,
    now: () => new Date('2026-08-12T16:00:00Z'),
    run: async (day) => { ran.push(day); return true; },
  });
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
  assert.deepStrictEqual(h.ran, [], 'LAW 3: and nothing may actually run');

  // ── LAW 2: present row must NOT run
  calls.length = 0;
  h = harness(async () => true);
  await h.sched._tick();
  h.sched.stop();
  assert.ok(!calls.some((c) => /catching up/.test(c)),
    'LAW 2: an existing row must not be recomputed on every boot');
  assert.deepStrictEqual(h.ran, [], 'LAW 2: and nothing may actually run');
  assert.ok(!calls.some((c) => /cannot determine/.test(c)));

  // ── LAW 1: missing row DOES catch up (log proves the decision; the child
  // process itself is out of scope for a smoke)
  calls.length = 0;
  h = harness(async () => false);
  await h.sched._tick();
  h.sched.stop();
  assert.ok(calls.some((c) => /missing — catching up/.test(c)),
    'LAW 1: a missing due-day row MUST trigger catch-up');
  assert.deepStrictEqual(h.ran, ['2026-08-11'],
    'LAW 1: catch-up must run the DUE day, exactly once');

  // ── LAW 4: a throwing probe must not escape
  calls.length = 0;
  h = harness(async () => { throw new Error('boom'); });
  await h.sched._tick();   // must not reject
  h.sched.stop();
  assert.ok(calls.some((c) => /tick failed|cannot determine/.test(c)),
    'LAW 4: a throwing probe must be caught and logged, never thrown into boot');

  // ══ LAWS EARNED 2026-09-24 — THE RUNAWAY ═══════════════════════════════
  //
  // The scheduler spawned the scoreboard every ten minutes, on every instance,
  // for five days, because the row it was catching up on could never be
  // written (eleven agentic_* keys with no columns -> PostgREST 400) and three
  // separate mechanisms hid it: the child's stderr was discarded, the child
  // exited 0 on a failed write, and this module logged "written" from that
  // exit code. Each run walked the full completed history of video_jobs.

  // ── LAW 6: "WRITTEN" IS READ FROM THE ROW, NEVER FROM THE EXIT CODE.
  // The run exits 0 and the row stays missing — exactly the production case.
  calls.length = 0;
  let b = { present: false, writeSucceeds: false, exitCode: 0, stderr: 'TABLE WRITE FAILED (400: PGRST204 agentic_state)' };
  let bh = boxHarness(b);
  await bh.sched._tick();
  bh.sched.stop();
  assert.deepStrictEqual(bh.ran, ['2026-08-11'], 'LAW 6: the first attempt still runs');
  assert.ok(!calls.some((c) => /written/.test(c)),
    'LAW 6: a run that exits 0 while the row is STILL MISSING must never be logged as written');
  assert.ok(calls.some((c) => /ROW IS STILL MISSING/.test(c)),
    'LAW 6: and it must say so');

  // ── LAW 7a: runFor REALLY CAPTURES A CHILD'S STDERR. Driven against a
  // two-line child, not read out of the source: `stdio: 'ignore'` is what
  // discarded the diagnosis for five days, and a source-reading assertion
  // cannot tell that line from a comment about that line.
  {
    const tmp = path.join(require('os').tmpdir(), `sbsm_${process.pid}.js`);
    fs.writeFileSync(tmp, 'console.error("CHILD-DIAGNOSIS-LINE"); process.exit(0);\n');
    const rec = await runFor('2026-08-11', { log: quiet, script: tmp });
    fs.unlinkSync(tmp);
    assert.strictEqual(rec.code, 0, 'LAW 7a: the child exited 0 (the production shape)');
    assert.ok(/CHILD-DIAGNOSIS-LINE/.test(rec.stderr),
      "LAW 7a: runFor must CAPTURE the child's stderr — with stdio:'ignore' this is empty "
      + 'and the cause is gone');
  }

  // ── LAW 7: THE CHILD'S OWN DIAGNOSIS REACHES THE LOG.
  assert.ok(calls.some((c) => /PGRST204 agentic_state/.test(c)),
    "LAW 7: the child's stderr tail must be surfaced — it named this exact cause "
    + 'on every run for five days into a discarded stream');

  // ── LAW 8: A RUN THAT LEAVES THE ROW MISSING DOES NOT RETRY IMMEDIATELY.
  calls.length = 0;
  b = { present: false, writeSucceeds: false, exitCode: 0, stderr: '' };
  bh = boxHarness(b, { failBackoffMs: 60 * 60 * 1000, maxAttempts: 3 });
  await bh.sched._tick();            // attempt 1
  await bh.sched._tick();            // same instant — must be suppressed
  await bh.sched._tick();
  assert.strictEqual(bh.ran.length, 1,
    'LAW 8: three ticks inside the backoff window must cost ONE run, not three '
    + '(the production shape was 144 a day)');
  bh.advance(61 * 60 * 1000);
  await bh.sched._tick();            // attempt 2
  assert.strictEqual(bh.ran.length, 2, 'LAW 8: and it does resume after the backoff');

  // ── LAW 9: IT GIVES UP, LOUDLY. A catch-up that cannot succeed must stop.
  bh.advance(61 * 60 * 1000);
  await bh.sched._tick();            // attempt 3 — the last
  bh.advance(61 * 60 * 1000);
  await bh.sched._tick();            // must NOT run
  bh.advance(61 * 60 * 1000);
  await bh.sched._tick();
  bh.sched.stop();
  assert.strictEqual(bh.ran.length, 3,
    `LAW 9: never more than ${MAX_ATTEMPTS_PER_DAY} attempts on one day, however long it loops`);
  assert.ok(calls.some((c) => /GIVING UP/.test(c)),
    'LAW 9: and giving up is LOUD — a silent stop is how the next one hides');

  // ── LAW 10: A REAL SUCCESS CLEARS THE BUDGET AND SAYS SO.
  calls.length = 0;
  b = { present: false, writeSucceeds: true, exitCode: 0, stderr: '' };
  bh = boxHarness(b);
  await bh.sched._tick();
  await bh.sched._tick();
  bh.sched.stop();
  assert.strictEqual(bh.ran.length, 1, 'LAW 10: once the row exists it stops running');
  assert.ok(calls.some((c) => /written \(row read back\)/.test(c)),
    'LAW 10: and the success line names its evidence');

  // ── LAW 11: the constants are the budget. A regression that raises them is
  // a regression, so they are pinned rather than merely present.
  assert.ok(MAX_ATTEMPTS_PER_DAY <= 6,
    'LAW 11: the daily retry budget must stay small — 144/day is what this replaced');
  assert.ok(FAIL_BACKOFF_MS >= 30 * 60 * 1000,
    'LAW 11: and the backoff must be tens of minutes, not the tick interval');

  // ── LAW 12: THE SCOREBOARD MUST NOT SPAWN THE JUDGE ON AN AUTOMATIC PATH.
  // The judge walks the whole completed history of video_jobs. On Render it
  // wrote to an ephemeral JSONL that nothing ever loads — 43 days of full-table
  // walks producing nothing. It is opt-in now and must stay opt-in.
  const sbSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'scoreboard.js'), 'utf8');
  assert.ok(/--judge/.test(sbSrc),
    'LAW 12: the judge spawn must be behind an explicit --judge opt-in');
  const spawnLine = sbSrc.split('\n').findIndex((l) => /fulfillment-judge\.js/.test(l) && /execFileSync/.test(l));
  assert.ok(spawnLine > 0, 'LAW 12: expected exactly one judge spawn site to guard');
  assert.ok(/includes\('--judge'\)/.test(sbSrc.split('\n').slice(Math.max(0, spawnLine - 12), spawnLine).join('\n')),
    'LAW 12: the --judge guard must sit ABOVE the spawn, not merely somewhere in the file');

  // ── LAW 13: NO OFFSET PAGINATION OVER video_jobs. OFFSET re-reads every
  // skipped row, so the walk gets slower forever as history grows.
  const judgeSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'fulfillment-judge.js'), 'utf8');
  assert.ok(!/offset=/.test(judgeSrc),
    'LAW 13: the judge must page by keyset watermark, never OFFSET');
  assert.ok(/created_at\.gt\./.test(judgeSrc) && /id\.gt\./.test(judgeSrc),
    'LAW 13: and the cursor must be the PAIR (created_at, id) — a bare created_at '
    + 'cursor silently drops every row sharing a timestamp with the page boundary');

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
    + 'escapes boot, server.js wiring, written-is-read-from-the-row, child stderr surfaced, '
    + `backoff, gives up after ${MAX_ATTEMPTS_PER_DAY}, success clears, judge opt-in, keyset-not-offset)`);
  process.exit(0);
})().catch((e) => {
  console.error('scoreboard-scheduler smoke FAILED:', e && e.message);
  process.exit(1);
});

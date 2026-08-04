'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  sweepJobReaper, isPastLease, isPastExecutionWall, isQueuedStall, reapReason,
  LEASE_MS, EXEC_WALL_MS, STALLED_COPY,
} = require('../lib/job-reaper');

// Reuse the refund-leg fake pattern: minimal supabase-js chainable over memory.
function makeFake(tables) {
  const state = { video_jobs: [...(tables.video_jobs || [])], usage_events: [...(tables.usage_events || [])] };
  function builder(table) {
    let op = 'select'; let patch = null; const filters = [];
    const b = {
      select() { return b; },
      update(o) { op = 'update'; patch = o; return b; },
      delete() { op = 'delete'; return b; },
      in(col, vals) { filters.push((r) => vals.includes(r[col])); return b; },
      eq(col, val) { filters.push((r) => r[col] === val); return b; },
      gte(col, val) { filters.push((r) => r[col] >= val); return b; },
      lte(col, val) { filters.push((r) => r[col] <= val); return b; },
      is(col, val) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      then(resolve) {
        const rows = state[table].filter((r) => filters.every((f) => f(r)));
        if (op === 'delete') {
          state[table] = state[table].filter((r) => !rows.includes(r));
          return resolve({ data: rows.map((r) => ({ id: r.id })), error: null });
        }
        if (op === 'update') { rows.forEach((r) => Object.assign(r, patch)); return resolve({ data: rows.map((r) => ({ id: r.id })), error: null }); }
        return resolve({ data: rows.map((r) => ({ ...r })), error: null });
      },
    };
    return b;
  }
  return { from: (t) => builder(t), _state: state };
}

const NOW = Date.now();
const iso = (off) => new Date(NOW + off).toISOString();
const vj = (o) => ({ refunded_at: null, parent_job_id: null, reedit_mode: null, result: null, progress: 11, ...o });

test('lease selector: queued 10min, processing 50min; terminal/needs_input never', () => {
  assert.equal(isPastLease({ status: 'queued', updated_at: iso(-11 * 60000) }, NOW), true);
  assert.equal(isPastLease({ status: 'queued', updated_at: iso(-9 * 60000) }, NOW), false);
  assert.equal(isPastLease({ status: 'processing', updated_at: iso(-51 * 60000) }, NOW), true);
  assert.equal(isPastLease({ status: 'processing', updated_at: iso(-49 * 60000) }, NOW), false);
  assert.equal(isPastLease({ status: 'completed', updated_at: iso(-99 * 60000) }, NOW), false);
  assert.equal(isPastLease({ status: 'needs_input', updated_at: iso(-99 * 60000) }, NOW), false);
});

test('zombie test: stalled processing job → terminalized failed + friendly copy + refunded + SSE final', async () => {
  const fake = makeFake({
    video_jobs: [vj({ id: 'z1', user_id: 'u1', status: 'processing', created_at: iso(-56 * 60000), updated_at: iso(-51 * 60000) })],
    usage_events: [{ id: 1, user_id: 'u1', kind: 'render', created_at: iso(-56 * 60000 - 90) }],
  });
  const sse = [];
  const out = await sweepJobReaper(fake, { pushProgressToSSE: (id, ev) => sse.push({ id, ev }) });
  assert.equal(out.reaped, 1);
  const row = fake._state.video_jobs[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.error_message, STALLED_COPY.processing);
  assert.ok(!/stalled_|_stage|error:/i.test(row.error_message), 'copy is user-facing, no technical vocab');
  assert.equal(fake._state.usage_events.length, 0, 'charge refunded');
  assert.ok(row.refunded_at != null, 'refund claim marked (one-shot)');
  assert.equal(sse.length, 1);
  assert.equal(sse[0].ev.status, 'failed');
  assert.equal(sse[0].ev.final, true);
});

test('fresh jobs untouched; second sweep is a no-op (idempotent)', async () => {
  const fake = makeFake({
    video_jobs: [
      vj({ id: 'f1', user_id: 'u2', status: 'processing', created_at: iso(-6 * 60000), updated_at: iso(-30000) }),
      vj({ id: 'z2', user_id: 'u2', status: 'queued', created_at: iso(-20 * 60000), updated_at: iso(-15 * 60000) }),
    ],
    usage_events: [
      { id: 2, user_id: 'u2', kind: 'render', created_at: iso(-6 * 60000 - 80) },   // fresh job's charge
      { id: 3, user_id: 'u2', kind: 'render', created_at: iso(-20 * 60000 - 80) },  // zombie's charge
    ],
  });
  const p1 = await sweepJobReaper(fake, {});
  assert.equal(p1.reaped, 1, 'only the stale queued row');
  assert.equal(fake._state.video_jobs.find((r) => r.id === 'f1').status, 'processing', 'fresh job untouched');
  assert.equal(fake._state.usage_events.some((e) => e.id === 2), true, 'fresh job charge intact');
  assert.equal(fake._state.usage_events.some((e) => e.id === 3), false, 'zombie charge refunded');
  const p2 = await sweepJobReaper(fake, {});
  assert.equal(p2.reaped, 0, 'no double-reap');
});

test('REVIEW regression: late-resumed ask-back job (created_at 9h old) is still reaped', async () => {
  // A needs_input row answered hours later flips back to processing with its
  // ORIGINAL created_at. The old created_at scan horizon hid it forever.
  const fake = makeFake({
    video_jobs: [vj({ id: 'ask1', user_id: 'u9h', status: 'processing', created_at: iso(-9 * 3600000), updated_at: iso(-51 * 60000) })],
    usage_events: [],
  });
  const out = await sweepJobReaper(fake, {});
  assert.equal(out.reaped, 1, 'no created_at horizon — old resumed jobs still covered');
  assert.equal(fake._state.video_jobs[0].status, 'failed');
});

test('REVIEW regression: a heartbeat between sweep-read and write saves the job (CAS staleness)', async () => {
  // Simulate the TOCTOU: the row is stale at SELECT time but a heartbeat
  // lands before the UPDATE. Our fake evaluates filters at write time, so
  // freshening updated_at up-front models exactly the raced state the
  // .lte('updated_at', staleCutoff) guard must reject.
  const fake = makeFake({
    video_jobs: [vj({ id: 'live1', user_id: 'u10', status: 'processing', created_at: iso(-56 * 60000), updated_at: iso(-51 * 60000) })],
    usage_events: [],
  });
  // sweep reads rows lazily in our fake; freshen BEFORE the write executes by
  // hooking the row object the fake mutates in place:
  const row = fake._state.video_jobs[0];
  const origFrom = fake.from.bind(fake);
  let vjCalls = 0;
  fake.from = (t) => {
    if (t === 'video_jobs') {
      vjCalls += 1;
      // call #1 = the sweep's SELECT (row still stale); call #2 = the
      // terminalize UPDATE — the heartbeat lands right before it.
      if (vjCalls === 2) row.updated_at = iso(-1000);
    }
    return origFrom(t);
  };
  const out = await sweepJobReaper(fake, {});
  assert.equal(out.reaped, 0, 'heartbeat-refreshed row is NOT killed');
  assert.equal(row.status, 'processing', 'job stays alive');
});

test('first-terminal-wins: a worker terminal landing between read and write beats the reaper', async () => {
  const fake = makeFake({
    video_jobs: [vj({ id: 'r1', user_id: 'u3', status: 'processing', created_at: iso(-56 * 60000), updated_at: iso(-51 * 60000) })],
    usage_events: [],
  });
  // Simulate the race: flip to completed right before the sweep's write by
  // pre-completing the row (the .eq('status','processing') guard must no-op).
  fake._state.video_jobs[0].status = 'completed';
  const out = await sweepJobReaper(fake, {});
  assert.equal(out.reaped, 0);
  assert.equal(fake._state.video_jobs[0].status, 'completed', 'worker terminal stands');
});

// ─── W4 #1: the 900s SIGKILL execution wall ──────────────────────────────────

test('execution-wall selector: processing past started_at wall; needs started_at; not for queued', () => {
  assert.equal(isPastExecutionWall({ status: 'processing', started_at: iso(-56 * 60000) }, NOW), true);
  assert.equal(isPastExecutionWall({ status: 'processing', started_at: iso(-54 * 60000) }, NOW), false);
  assert.equal(isPastExecutionWall({ status: 'processing', started_at: null }, NOW), false, 'no anchor -> stall lease only');
  assert.equal(isPastExecutionWall({ status: 'processing' }, NOW), false, 'legacy null started_at');
  assert.equal(isPastExecutionWall({ status: 'queued', started_at: iso(-99 * 60000) }, NOW), false, 'queued never executes');
  assert.equal(EXEC_WALL_MS, 55 * 60 * 1000);
});

test('reapReason: timeout (execution wall) takes priority over stall (heartbeat lease)', () => {
  // SIGKILL shape: started 56min ago, last heartbeat only 5min ago (under the 50min lease)
  assert.equal(reapReason({ status: 'processing', started_at: iso(-56 * 60000), updated_at: iso(-5 * 60000) }, NOW), 'timeout');
  // pure stall: no started_at, heartbeat 51min silent
  assert.equal(reapReason({ status: 'processing', started_at: null, updated_at: iso(-51 * 60000) }, NOW), 'stall');
  // healthy long render: started 15min ago, heartbeating -> neither
  assert.equal(reapReason({ status: 'processing', started_at: iso(-15 * 60000), updated_at: iso(-10000) }, NOW), null);
});

test('W4 #1 REGRESSION: a 900s SIGKILL the heartbeat lease MISSES is caught by the execution wall', async () => {
  // The exact silent death: worker heartbeated updated_at right up to the kill
  // (so it's only ~5min stale — UNDER the 50min lease, isPastLease=false),
  // but started_at is 56min old (past the 55min wall). Reaps now, not ~45min later.
  const fake = makeFake({
    video_jobs: [vj({ id: 'kill1', user_id: 'uk', status: 'processing',
      created_at: iso(-57 * 60000), started_at: iso(-56 * 60000), updated_at: iso(-5 * 60000) })],
    usage_events: [{ id: 1, user_id: 'uk', kind: 'render', created_at: iso(-57 * 60000 - 90) }],
  });
  assert.equal(isPastLease(fake._state.video_jobs[0], NOW), false, 'heartbeat lease would NOT catch it yet');
  const sse = [];
  const out = await sweepJobReaper(fake, { pushProgressToSSE: (id, ev) => sse.push({ id, ev }) });
  assert.equal(out.reaped, 1, 'execution wall catches the SIGKILL the lease missed');
  const row = fake._state.video_jobs[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.error_message, STALLED_COPY.timeout, 'honest time-limit copy, not stall copy');
  assert.ok(/time limit/i.test(row.error_message) && !/error:|stalled_/i.test(row.error_message));
  assert.equal(fake._state.usage_events.length, 0, 'charge refunded');
  assert.ok(row.refunded_at != null);
  assert.equal(sse[0].ev.final, true);
  assert.equal(sse[0].ev.error, STALLED_COPY.timeout);
});

test('execution wall respects first-terminal-wins (worker terminal between read and write)', async () => {
  const fake = makeFake({
    video_jobs: [vj({ id: 'kill2', user_id: 'uk2', status: 'processing',
      created_at: iso(-57 * 60000), started_at: iso(-56 * 60000), updated_at: iso(-2 * 60000) })],
    usage_events: [],
  });
  fake._state.video_jobs[0].status = 'completed'; // worker landed a terminal first
  const out = await sweepJobReaper(fake, {});
  assert.equal(out.reaped, 0, 'wall does not resurrect/clobber a completed row');
  assert.equal(fake._state.video_jobs[0].status, 'completed');
});

test('re-entered processing (started_at just reset) is NOT wall-reaped despite old created_at', async () => {
  // Ask-back resume: created_at 9h old, but started_at freshly stamped this run.
  const fake = makeFake({
    video_jobs: [vj({ id: 'resume1', user_id: 'ur', status: 'processing',
      created_at: iso(-9 * 3600000), started_at: iso(-2 * 60000), updated_at: iso(-15000) })],
    usage_events: [],
  });
  const out = await sweepJobReaper(fake, {});
  assert.equal(out.reaped, 0, 'wall tracks the CURRENT execution, not the original creation');
  assert.equal(fake._state.video_jobs[0].status, 'processing');
});

// ─── QUEUED-STALL notify (Zac 2026-08-03): the 43-min "Getting started…" case ──

test('queued-stall selector: current_step=queued past 5min; not before; not other steps', () => {
  assert.equal(isQueuedStall({ current_step: 'queued', updated_at: iso(-6 * 60000) }, NOW), true, 'queued 6min = never picked up');
  assert.equal(isQueuedStall({ current_step: 'queued', updated_at: iso(-96 * 1000) }, NOW), false, 'queued 96s = healthy cold-start, protected');
  assert.equal(isQueuedStall({ current_step: 'queued', updated_at: iso(-4 * 60000) }, NOW), false, 'under 5min');
  assert.equal(isQueuedStall({ current_step: 'downloading', updated_at: iso(-30 * 60000) }, NOW), false, 'download can legit run minutes — OUT of scope');
  assert.equal(isQueuedStall({ current_step: 'rendering', updated_at: iso(-30 * 60000) }, NOW), false, 'render OUT of scope (heartbeat masks; needs frame signal)');
  assert.equal(isQueuedStall({ current_step: undefined, updated_at: iso(-30 * 60000) }, NOW), false, 'no current_step');
  assert.equal(isQueuedStall({ current_step: 'queued', updated_at: 'not-a-date' }, NOW), false, 'unparseable ts never reaps');
});

test('queued-stall reap: status=processing but current_step=queued 6min → JOB_NEVER_STARTED, honest "didn\'t start" copy, refunded, retry-able', async () => {
  // The exact 43-min "Getting started…" case: dispatch flipped status→processing
  // and set current_step=queued, but the worker never wrote a first step. The
  // 50-min processing lease sits on it; queued_stall reaps it at 5min.
  const fake = makeFake({
    video_jobs: [vj({ id: 'q1', user_id: 'uq', status: 'processing', current_step: 'queued',
      created_at: iso(-7 * 60000), started_at: iso(-7 * 60000), updated_at: iso(-6 * 60000) })],
    usage_events: [{ id: 1, user_id: 'uq', kind: 'render', created_at: iso(-7 * 60000 - 90) }],
  });
  const sse = [];
  const out = await sweepJobReaper(fake, { pushProgressToSSE: (id, ev) => sse.push({ id, ev }) });
  assert.equal(out.reaped, 1, 'queued-stuck job reaped at 5min, not 50');
  const row = fake._state.video_jobs[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.error_message, STALLED_COPY.queued, 'honest "didn\'t get started" copy, not the "stalled" processing copy');
  assert.ok(/try again/i.test(row.error_message), 'offers the retry');
  assert.ok(/weren.t charged/i.test(row.error_message), 'tells them they were not charged');
  assert.equal(row.result.error_code, 'JOB_NEVER_STARTED', 'distinct code, countable vs stall/timeout');
  assert.equal(fake._state.usage_events.length, 0, 'charge refunded');
  assert.ok(row.refunded_at != null, 'refund one-shot claimed');
  assert.equal(sse[0].ev.final, true);
  assert.equal(sse[0].ev.error, STALLED_COPY.queued);
});

test('queued-stall PROTECTS a healthy cold-starting job (96s at queued, under threshold)', async () => {
  const fake = makeFake({
    video_jobs: [vj({ id: 'q2', user_id: 'uq2', status: 'processing', current_step: 'queued',
      created_at: iso(-96 * 1000), started_at: iso(-96 * 1000), updated_at: iso(-96 * 1000) })],
    usage_events: [],
  });
  const out = await sweepJobReaper(fake, {});
  assert.equal(out.reaped, 0, 'a healthy cold-start is never false-terminalised');
  assert.equal(fake._state.video_jobs[0].status, 'processing');
});

test('queued-stall CAS: worker writes first step (current_step off queued) between read and write → NOT killed', async () => {
  const fake = makeFake({
    video_jobs: [vj({ id: 'q3', user_id: 'uq3', status: 'processing', current_step: 'queued',
      created_at: iso(-7 * 60000), started_at: iso(-7 * 60000), updated_at: iso(-6 * 60000) })],
    usage_events: [],
  });
  const row = fake._state.video_jobs[0];
  const origFrom = fake.from.bind(fake);
  let vjCalls = 0;
  fake.from = (t) => {
    if (t === 'video_jobs') { vjCalls += 1; if (vjCalls === 2) { row.current_step = 'transcribing'; row.updated_at = iso(-1000); } }
    return origFrom(t);
  };
  const out = await sweepJobReaper(fake, {});
  assert.equal(out.reaped, 0, 'job that just came alive is not killed (current_step re-checked at UPDATE)');
  assert.equal(row.status, 'processing');
});

test('queued-stall MASS GUARD: >8 queued-stale in one sweep = systemic → 0 reaped (no false mass-terminalise)', async () => {
  const jobs = [];
  for (let i = 0; i < 9; i += 1) {
    jobs.push(vj({ id: `m${i}`, user_id: `um${i}`, status: 'processing', current_step: 'queued',
      created_at: iso(-7 * 60000), started_at: iso(-7 * 60000), updated_at: iso(-6 * 60000) }));
  }
  const fake = makeFake({ video_jobs: jobs, usage_events: [] });
  const out = await sweepJobReaper(fake, {});
  assert.equal(out.reaped, 0, 'a systemic container-queue is NOT nine deaths — alert, do not mass-reap');
  assert.ok(fake._state.video_jobs.every((r) => r.status === 'processing'), 'all live-but-waiting jobs preserved');
});

test('queued-stall mass guard boundary: exactly 8 still reap (guard is > not >=)', async () => {
  const jobs = [];
  for (let i = 0; i < 8; i += 1) {
    jobs.push(vj({ id: `b${i}`, user_id: `ub${i}`, status: 'processing', current_step: 'queued',
      created_at: iso(-7 * 60000), started_at: iso(-7 * 60000), updated_at: iso(-6 * 60000) }));
  }
  const fake = makeFake({ video_jobs: jobs, usage_events: [] });
  const out = await sweepJobReaper(fake, {});
  assert.equal(out.reaped, 8, 'at/under the guard, individual deaths are still reaped');
});

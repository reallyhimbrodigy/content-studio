'use strict';
// SMOKE — a frozen render is reaped in minutes, not in 55.
//
// THE DEFECT. The worker writes `progress_at` on every frame advance and writes
// NOTHING when frames freeze, so a stale progress_at is an unambiguous
// zero-movement signal. NOTHING IN content-studio READ IT — a producer with no
// consumer, which looks exactly like instrumentation and is dead weight.
//
// The consequence is the "stuck" experience: a frozen render keeps heartbeating
// updated_at through _async_job_status, so the 50-min lease stays fresh and the
// job only dies at the 55-min execution wall — regardless of when frames
// actually stopped.
const { isRenderStalled, reapReason, RENDER_STALL_MS,
        STALLED_COPY } = require('./job-reaper');

const fail = [];
const ok = (c, m) => { if (!c) fail.push(m); };
const NOW = Date.parse('2026-09-05T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

// ── the wall is DERIVED from the worker's own timings ──────────────────────
ok(RENDER_STALL_MS === (30 * 1000 + 4 * 1000) * 4,
   `RENDER_STALL_MS is ${RENDER_STALL_MS}, not (30s startup + 4s poll) x 4. A `
   + `round number here is a guess; this one is anchored on the worker's `
   + `pre-frame guard and its poll interval.`);
ok(RENDER_STALL_MS < 55 * 60 * 1000,
   'the render wall must fire BEFORE the execution wall or it changes nothing');

// ── RED: a frozen render IS reaped ─────────────────────────────────────────
const frozen = { status: 'processing', current_step: 'render',
                 progress_at: ago(RENDER_STALL_MS + 60 * 1000),
                 updated_at: ago(1000),          // heartbeat still FRESH
                 started_at: ago(5 * 60 * 1000) };
ok(isRenderStalled(frozen, NOW) === true, 'a frozen render is not detected');
ok(reapReason(frozen, NOW) === 'render_stall',
   `reapReason gave ${reapReason(frozen, NOW)} — a fresh heartbeat must not hide `
   + `stopped frames; that is the whole bug`);

// ── GREEN: a LIVE render is not reaped ─────────────────────────────────────
const live = { ...frozen, progress_at: ago(10 * 1000) };
ok(isRenderStalled(live, NOW) === false, 'a live render was reaped — false kill');
ok(reapReason(live, NOW) === null, 'a live render got a reap reason');

// ── absence is never death ─────────────────────────────────────────────────
ok(isRenderStalled({ ...frozen, progress_at: null }, NOW) === false,
   'a row with NO progress_at was reaped — a job that never rendered has none, '
   + 'and absence must not read as a stall');
ok(isRenderStalled({ ...frozen, progress_at: 'not-a-date' }, NOW) === false,
   'an unparseable progress_at was treated as death');

// ── only during the render stage ───────────────────────────────────────────
ok(isRenderStalled({ ...frozen, current_step: 'transcribe' }, NOW) === false,
   'a stale progress_at outside the render stage was reaped — outside render it '
   + 'means "not rendering", not "dead"');
ok(isRenderStalled({ ...frozen, status: 'completed' }, NOW) === false,
   'a completed job was reaped');

// ── it must OUTRANK the later walls, or it never fires ─────────────────────
const alsoPastExec = { ...frozen, started_at: ago(60 * 60 * 1000) };
ok(reapReason(alsoPastExec, NOW) === 'render_stall',
   'a job past BOTH walls reported the execution wall — render_stall is the '
   + 'truer cause and ~50 minutes earlier');

// ── the user is told something honest ──────────────────────────────────────
ok(typeof (STALLED_COPY.render || STALLED_COPY.processing) === 'string',
   'no copy exists for a render stall');

if (fail.length) {
  console.error('render-stall wall smoke: FAIL');
  for (const f of fail) console.error(`   ✗ ${f}`);
  process.exit(1);
}
console.log(`render-stall wall smoke: PASS (wall ${RENDER_STALL_MS / 1000}s derived, `
  + 'frozen reaped despite a fresh heartbeat, live spared, absence never death, '
  + 'render-stage only, outranks the execution wall)');

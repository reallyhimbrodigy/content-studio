'use strict';
// Gate for the completion_delivery instrumentation + the durable-row early
// poller (lane/delivery 2026-08-10).
//
// WHY: 41 completed jobs settled at the 15-min fallback wall in the Aug-2..9
// window and NOTHING distinguished them from normal completions — the p99
// pinned to ~900s and the mechanism was unmeasurable. Every settle path now
// stamps HOW the completion arrived, and the poller settles a missed callback
// from the worker's durable row in ≤75s instead of 900s. This gate asserts:
//   1. settlePendingModalJob stamps `via` on COMPLETED outputs, first-stamp-wins
//   2. the 15-min timer's fallback resolution stamps 'fallback_timer'
//   3. the poller settles a pending job from a terminal 'completed' row with
//      via='durable_poll', carrying the worker envelope + a video URL
//   4. the poller does NOT settle a needs_input row (ask-back stays callback-owned)
//   5. the poller settles a CODED failed row RESOLVED with the envelope (so the
//      tail's result.error branch — honest copy + refund — runs, not the
//      generic outer catch), and leaves uncoded failed rows to the timer.

const assert = require('assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test';

let row = null;
require.cache[require.resolve('../services/supabase-admin')] = {
  id: require.resolve('../services/supabase-admin'),
  filename: require.resolve('../services/supabase-admin'),
  loaded: true,
  exports: {
    supabaseAdmin: {
      from() {
        const b = {
          select: () => b, eq: () => b, order: () => b, limit: () => b,
          update: () => b, is: () => b, not: () => b, in: () => b, or: () => b,
          maybeSingle: () => Promise.resolve({ data: row, error: null }),
          insert: () => Promise.resolve({ error: null }),
          then: (fn) => Promise.resolve({ data: [], error: null }).then(fn),
        };
        return b;
      },
    },
  },
};

const { registerPendingModalJob, settlePendingModalJob, stampDelivery } = require('./video-processor/modal-webhook');
const { startDurableCompletionPoll } = require('./video-processor/dispatch-to-modal');

(async () => {
  // 1) via stamping + first-stamp-wins
  const out = {};
  stampDelivery(out, 'callback');
  assert.strictEqual(out.completion_delivery, 'callback', 'stampDelivery must stamp');
  stampDelivery(out, 'webhook');
  assert.strictEqual(out.completion_delivery, 'callback', 'first stamp must win');

  const p1 = registerPendingModalJob('call-1', { timeoutMs: 60_000 });
  settlePendingModalJob({ id: 'call-1', status: 'COMPLETED', output: { video_url: 'v' }, via: 'callback' });
  const r1 = await p1;
  assert.strictEqual(r1.completion_delivery, 'callback', 'settle must stamp via');

  // 2) timer fallback stamps 'fallback_timer'
  const p2 = registerPendingModalJob('call-2', {
    timeoutMs: 20,
    onTimeoutCheck: async () => ({ status: 'COMPLETED', output: { video_url: 'v2' } }),
  });
  const r2 = await p2;
  assert.strictEqual(r2.completion_delivery, 'fallback_timer', 'timer fallback must stamp fallback_timer');

  // 3) poller settles from a terminal completed row
  row = {
    status: 'completed',
    result: { public_url: 'https://cdn/x.mp4', hls_manifest_url: 'https://cdn/x.m3u8', stage_timings: { total: 42 }, novel_key: 1 },
    rendered_video_url: null, result_url: null, error_message: null,
  };
  const p3 = registerPendingModalJob('call-3', { timeoutMs: 60_000 });
  const stop3 = startDurableCompletionPoll({ jobId: 'job-3', callId: 'call-3', intervalMs: 25 });
  const r3 = await p3;
  stop3();
  assert.strictEqual(r3.completion_delivery, 'durable_poll', 'poller settle must stamp durable_poll');
  assert.strictEqual(r3.video_url, 'https://cdn/x.mp4', 'poller must surface a playable URL');
  assert.strictEqual(r3.novel_key, 1, 'poller must carry the WHOLE worker envelope (pass-through)');
  assert.strictEqual(r3.hls_manifest_url, 'https://cdn/x.m3u8');

  // 4) needs_input must NOT be settled by the poller
  row = { status: 'needs_input', result: {}, rendered_video_url: null, result_url: null };
  let settled4 = false;
  const p4 = registerPendingModalJob('call-4', { timeoutMs: 250 })
    .then(() => { settled4 = true; }, () => {});
  const stop4 = startDurableCompletionPoll({ jobId: 'job-4', callId: 'call-4', intervalMs: 25 });
  await p4; // the 250ms timer rejects it — the poller must not have resolved it first
  stop4();
  assert.strictEqual(settled4, false, 'poller must NOT settle a needs_input row');

  // 5a) coded failed row → RESOLVED with the envelope (result.error branch shape)
  row = {
    status: 'failed',
    result: { error: 'CLIP_TOO_LONG', error_code: 'CLIP_TOO_LONG', user_message: 'Trim it.' },
    rendered_video_url: null, result_url: null, error_message: 'Trim it.',
  };
  const p5 = registerPendingModalJob('call-5', { timeoutMs: 60_000 });
  const stop5 = startDurableCompletionPoll({ jobId: 'job-5', callId: 'call-5', intervalMs: 25 });
  const r5 = await p5;
  stop5();
  assert.strictEqual(r5.error, 'CLIP_TOO_LONG', 'coded failure must resolve with the envelope');
  assert.strictEqual(r5.completion_delivery, 'durable_poll');

  // 5b) UNCODED failed row (drained/reaper shape) → poller must leave it alone
  row = { status: 'failed', result: {}, rendered_video_url: null, result_url: null, error_message: null };
  let settled6 = false;
  const p6 = registerPendingModalJob('call-6', { timeoutMs: 250 })
    .then(() => { settled6 = true; }, () => {});
  const stop6 = startDurableCompletionPoll({ jobId: 'job-6', callId: 'call-6', intervalMs: 25 });
  await p6;
  stop6();
  assert.strictEqual(settled6, false, 'poller must NOT preempt respawnDecision on an uncoded failed row');

  console.log('completion-delivery smoke: PASS (stamp, first-wins, timer, poller settle/skip, coded-failure shape)');
  process.exit(0);
})().catch((e) => {
  console.error('completion-delivery smoke FAILED:', e && e.message);
  process.exit(1);
});

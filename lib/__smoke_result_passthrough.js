'use strict';
// Real-path smoke for the double-loss completion recovery: drives the ACTUAL
// resolveSpawnedCompletionFallback through a mock supabaseAdmin and asserts it
// carries the worker's WHOLE result envelope forward.
//
// WHY: recovery used to rebuild `output` from a hand-listed set of 13 keys, so
// the 10 other keys the completion tail actually reads were dropped in silence
// — public_url, rendered_video_url, cover_frame_b64/_mime,
// clarification_question, user_message, error, retryable, requires_new_video,
// requires_vibe_change — plus every diagnostic the worker writes. Concretely: a
// job whose worker-side thumbnail upload failed lost its cover_frame_b64 too
// and recovered with NO thumbnail; a job that wrote public_url but not
// video_url read as "never completed" and went to the reaper as a dead job.
//
// The deeper defect was structural: an allowlist can only describe what the
// worker wrote on the day it was written, so every NEW top-level result key is
// dropped by default with no error and no log line. THE KEY ASSERTION HERE IS
// THE UNKNOWN ONE — a key this file's author never heard of must survive.

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
          maybeSingle: () => Promise.resolve({ data: row, error: null }),
          insert: () => Promise.resolve({ error: null }),
        };
        return b;
      },
    },
  },
};

const d = require('./video-processor/dispatch-to-modal');
const { resolveSpawnedCompletionFallback, carryWorkerResult, DISPATCH_TRANSPORT_KEYS } = d;

(async () => {
  // ── 1. COMPLETED: the whole envelope rides, unknown keys included ─────────
  row = {
    status: 'completed',
    result: {
      status: 'success',
      video_url: 'https://cdn/v.mp4',
      hls_manifest_url: 'https://cdn/m.m3u8',
      edit_recipe: { cuts: [] },
      thumbnail_url: null,
      // read by the tail, dropped by the old allowlist:
      cover_frame_b64: 'AAAA',
      cover_frame_mime: 'image/jpeg',
      public_url: 'https://cdn/public.mp4',
      // diagnostics, dropped by the old allowlist:
      error_code: null,
      stage_timings: { total: 101.2, render: 52.6 },
      stage_manifest: { planning: { run: true } },
      floor: null,
      // THE POINT: a key nobody has written yet.
      some_future_key_2027: { nested: true },
    },
  };
  let out = await resolveSpawnedCompletionFallback({ jobId: 'j1', callId: 'c1' });
  assert.strictEqual(out.status, 'COMPLETED');

  assert.strictEqual(out.output.cover_frame_b64, 'AAAA',
    'cover_frame_b64 must survive — without it a failed worker-side thumbnail upload recovers with NO thumbnail');
  assert.strictEqual(out.output.cover_frame_mime, 'image/jpeg');
  assert.strictEqual(out.output.public_url, 'https://cdn/public.mp4');
  assert.deepStrictEqual(out.output.stage_timings, { total: 101.2, render: 52.6 },
    'diagnostics must survive recovery');
  assert.deepStrictEqual(out.output.some_future_key_2027, { nested: true },
    'AN UNKNOWN TOP-LEVEL KEY MUST SURVIVE — this is the whole point of pass-through');

  // normalised fields still correct
  assert.strictEqual(out.output.status, 'success');
  assert.strictEqual(out.output.job_id, 'j1');
  assert.strictEqual(out.output.video_url, 'https://cdn/v.mp4');

  // ── 2. transport keys are the ONLY thing stripped ─────────────────────────
  const carried = carryWorkerResult({ spawned: true, call_id: 'x', video_url: 'v', anything: 1 });
  for (const k of DISPATCH_TRANSPORT_KEYS) {
    assert.ok(!(k in carried), `${k} is a dispatch transport key and must NOT be replayed`);
  }
  assert.strictEqual(carried.anything, 1, 'everything else rides');
  assert.strictEqual(carried.video_url, 'v');

  // ── 3. a worker that wrote public_url but NOT video_url still completes ──
  row = { status: 'processing', result: { public_url: 'https://cdn/only-public.mp4' } };
  out = await resolveSpawnedCompletionFallback({ jobId: 'j2', callId: 'c2' });
  assert.strictEqual(out.status, 'COMPLETED',
    'a result with public_url but no video_url used to read as "never completed" and go to the reaper');
  assert.strictEqual(out.output.video_url, 'https://cdn/only-public.mp4');

  // ── 4. FAILED keeps the worker's honest envelope ──────────────────────────
  row = {
    status: 'failed',
    error_message: 'row level message',
    result: {
      status: 'failed',
      error: 'RENDER_FATAL',
      error_code: 'RENDER_FATAL',
      user_message: 'Rendering failed even after a simplified retry.',
      retryable: true,
      error_detail: '[micro-00] Remotion render TIMEOUT after 612.4s ... reached 41%',
    },
  };
  out = await resolveSpawnedCompletionFallback({ jobId: 'j3', callId: 'c3' });
  assert.strictEqual(out.status, 'FAILED');
  assert.strictEqual(out.output.error_code, 'RENDER_FATAL',
    'the coded error must survive a double-loss on a FAILED job');
  assert.strictEqual(out.output.user_message, 'Rendering failed even after a simplified retry.');
  assert.strictEqual(out.output.retryable, true);
  assert.ok(String(out.output.error_detail).includes('reached 41%'),
    'the render forensics must survive recovery');
  assert.strictEqual(out.error, 'RENDER_FATAL');

  // ── 5. empty/missing result must not throw ────────────────────────────────
  row = { status: 'processing', result: null };
  out = await resolveSpawnedCompletionFallback({ jobId: 'j4', callId: 'c4' });
  assert.strictEqual(out.status, 'FAILED');

  console.log('[smoke] result pass-through: ALL PASS (unknown key survives; transport keys stripped)');
})().catch((e) => { console.error('[smoke] FAILED:', e && e.message); process.exit(1); });

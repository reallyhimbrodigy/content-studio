'use strict';
// The stamp has to REACH the row. Minting provenance that dies in memory is the
// state this replaces: analysis_data NULL on all 4,728 jobs in 30 days, so
// after re-pinning the analyze model there was no way to tell which model
// produced any analysis, or which jobs predate the pin.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stripComments } = require('./__gate_strip');

const SRC = fs.readFileSync(
  path.join(__dirname, 'video-processor', 'dispatch-to-modal.js'), 'utf8');
const CODE = stripComments(SRC);

// ── it is written, from the server's own analysis, to its own column ────────
assert.ok(/analysis_producer:\s*cachedAnalysis\.producer/.test(CODE),
  'the producer stamp must be persisted from the analysis the SERVER produced — '
  + 'the worker never returns one, which is why analysis_data has been NULL on '
  + 'every job since the column existed');
assert.ok(/\.update\(\{ analysis_producer[\s\S]{0,120}?\.eq\('id', jobId\)/.test(CODE),
  'the write must be scoped to this job');

// ── NOT into analysis_data ──────────────────────────────────────────────────
// server.js feeds analysis_data straight back into a re-edit as the parent's
// analysis, so a stamp-only object there would be handed to the worker AS an
// analysis. Presence where shape was needed.
const stampBlock = (CODE.match(/if \(cachedAnalysis && typeof cachedAnalysis[\s\S]{0,600}?\n  \}/) || [''])[0];
assert.ok(stampBlock.length > 0, 'positive control: the stamp block was not found');
assert.ok(!/analysis_data/.test(stampBlock),
  'THE TRAP: the stamp must not be written into analysis_data — that column is '
  + 'replayed into a re-edit as a real analysis, and a stamp-only blob there is '
  + 'worse than leaving it null');

// ── provenance must never gate a render ─────────────────────────────────────
assert.ok(!/await\s+supabaseAdmin\s*\n?\s*\.from\('video_jobs'\)\s*\n?\s*\.update\(\{ analysis_producer/.test(CODE),
  'the stamp write must be fire-and-forget — a provenance write that can throw '
  + 'or hang would gate a render on bookkeeping');

// ── and the stamp it writes actually carries the model ──────────────────────
const AV = fs.readFileSync(path.join(__dirname, 'video-processor', 'analyze-video.js'), 'utf8');
assert.ok(/producer:\s*\{[\s\S]{0,200}?model:\s*GEMINI_MODEL/.test(AV),
  'the minted stamp must carry the model, or persisting it answers nothing');
assert.ok(/measured_at:/.test(AV), 'and when it was measured');

console.log('[smoke] analyze stamp persist: ALL PASS (written from the server\'s own '
  + 'analysis, scoped to the job, never into analysis_data, never gating a render)');

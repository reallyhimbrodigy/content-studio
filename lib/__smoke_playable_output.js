'use strict';
// The .mp4 match, three times in one day. This is the class fix.
//
//   1. recover-hls-orphans.js renderKeyFor — matched /\.mp4$/i, sorted NEWEST,
//      picked `<job>-hls/stream_1080p/init.mp4` (0 bytes) over the real
//      `-edited.mp4`, and WROTE THAT URL INTO THE JOB ROW. A user would have
//      received a 0-byte file as their video.
//   2. a verification probe ffprobe'd a private S3 URL, 403'd, read zeros, and
//      reported seven matrix cells broken when they were fine.
//   3. the corrected probe then matched `.endswith('.mp4')` — init.mp4 again.
//
// POSITIVE AND NEGATIVE CONTROLS ON EVERY MEASUREMENT (standing rule): without
// the positive control, a helper that returns nothing passes every negative
// assertion. Without the negative, one that returns anything ending in .mp4
// passes every positive one.

const assert = require('assert');
const { pickPlayableOutput, isPlayableOutput } = require('./playable-output');

// The REAL listing shape, verbatim from matrix-20260804 / renders/<job>/.
const LISTING = [
  { Key: 'renders/j1/j1-hls/master.m3u8', Size: 0 },
  { Key: 'renders/j1/j1-hls/stream_1080p/init.mp4', Size: 0 },
  { Key: 'renders/j1/j1-hls/stream_1080p/playlist.m3u8', Size: 0 },
  { Key: 'renders/j1/j1-hls/stream_1080p/seg_0.m4s', Size: 6190000 },
  { Key: 'renders/j1/j1-hls/stream_1080p/seg_5.m4s', Size: 314000 },
  { Key: 'renders/j1/j1-edited.mp4', Size: 35127296 },
];

// ── POSITIVE CONTROL ────────────────────────────────────────────────────────
const got = pickPlayableOutput(LISTING);
assert.ok(got, 'POSITIVE CONTROL FAILED — found nothing in a listing that HAS a '
  + 'deliverable; every negative assertion below would be meaningless');
assert.strictEqual(got.key, 'renders/j1/j1-edited.mp4');
assert.strictEqual(got.size, 35127296);

// ── NEGATIVE CONTROL: the exact object all three sites picked ───────────────
assert.strictEqual(isPlayableOutput('renders/j1/j1-hls/stream_1080p/init.mp4', 0), false);
assert.strictEqual(
  isPlayableOutput('renders/j1/j1-hls/stream_1080p/init.mp4', 99000000), false,
  'an HLS artifact is never the deliverable, whatever its size');
assert.strictEqual(isPlayableOutput('renders/j1/j1-hls/s/seg_0.m4s', 6000000), false);
assert.strictEqual(isPlayableOutput('renders/j1/j1.mp4', 900), false, 'a stub is not playable');
assert.strictEqual(isPlayableOutput('renders/j1/j1.mp4', 35000000), true);

// ── NEWEST IS WRONG BY CONSTRUCTION ────────────────────────────────────────
// HLS artifacts are written AFTER the deliverable, so any order-dependent
// selection picks wrong. Reversing the listing must not change the answer.
assert.strictEqual(pickPlayableOutput([...LISTING].reverse()).key, got.key,
  'selection must be order-independent — sorting by LastModified is the original bug');

// ── -edited wins over a raw render, which was renderKeyFor's stated intent ──
const both = [
  { Key: 'renders/j2/j2.mp4', Size: 90000000 },          // bigger, but raw
  { Key: 'renders/j2/j2-edited.mp4', Size: 35000000 },   // the deliverable
];
assert.strictEqual(pickPlayableOutput(both).key, 'renders/j2/j2-edited.mp4',
  'the EDITED render is the deliverable even when a larger raw render exists');

// ── nothing playable -> null, never a segment ──────────────────────────────
assert.strictEqual(pickPlayableOutput(LISTING.filter((o) => o.Key.includes('-hls/'))), null,
  'a job with only streaming artifacts has no deliverable — say null');
assert.strictEqual(pickPlayableOutput([]), null);
assert.strictEqual(pickPlayableOutput(null), null);

// ── the caller that wrote a bad URL into the DB must use the helper ────────
const rec = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'scripts', 'recover-hls-orphans.js'), 'utf8');
assert.ok(rec.includes('pickPlayableOutput'),
  'recover-hls-orphans must resolve through the shared helper');
assert.ok(!/mp4s\.sort\(/.test(rec), 'the newest-first sort must be gone');
assert.ok(!/\(o\) => \/\\\.mp4\$\/i\.test/.test(rec), 'the bare .mp4 match must be gone');

console.log('[smoke] playable output: ALL PASS (finds the deliverable; rejects init.mp4 at any '
  + 'size; order-independent; -edited wins; recover-hls-orphans repointed)');

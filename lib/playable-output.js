'use strict';
// ONE way to resolve a job's playable render. Import this; never re-match .mp4.
//
// THIS BUG HAS NOW BEEN WRITTEN THREE TIMES IN ONE DAY:
//   1. recover-hls-orphans.js renderKeyFor — matched /\.mp4$/i and sorted by
//      NEWEST, so it picked `<job>-hls/stream_1080p/init.mp4` over the real
//      `-edited.mp4`. This one WROTE THE WRONG URL INTO THE JOB ROW, so a user
//      would have received a 0-byte file as their video.
//   2. a verification probe ffprobe'd a private S3 URL, got 403, read zeros,
//      and reported seven matrix cells as broken when they were fine.
//   3. the same probe, corrected, then matched `.endswith('.mp4')` and picked
//      init.mp4 again — all seven cells read 0.0MB a second time.
//
// A render emits several objects per job: the deliverable mp4, an HLS master
// playlist, per-variant playlists, `init.mp4`, and `seg_N.m4s`. Exactly one is
// the thing a user watches, and every caller that guesses gets it wrong
// eventually. Sorting by NEWEST is wrong BY CONSTRUCTION — the HLS artifacts are
// written after the deliverable.
//
// Mirrors promptly_output.py on the worker side; keep the two in step.

// Anything under an `-hls/` (or `/hls/`) prefix is a streaming artifact, never
// the deliverable — including init.mp4, which ends in .mp4 and is 0 bytes.
const HLS_MARKERS = ['-hls/', '/hls/'];

// A real render is megabytes. This only excludes stubs and header-only files.
const MIN_PLAYABLE_BYTES = 100000;

function isPlayableOutput(key, size) {
  const k = String(key || '');
  if (!/\.mp4$/i.test(k)) return false;
  if (HLS_MARKERS.some((m) => k.includes(m))) return false;
  if (size !== undefined && size !== null && Number(size) < MIN_PLAYABLE_BYTES) return false;
  return true;
}

/**
 * Choose the deliverable from an S3 listing.
 *
 * PREFERENCE ORDER, and the order matters:
 *   1. an `-edited.mp4` that is playable — the edited render is the deliverable
 *      when both it and a raw render exist (this was renderKeyFor's stated
 *      intent, which its code did not implement)
 *   2. otherwise the LARGEST playable mp4
 *
 * Never "newest". Returns { key, size } or null.
 */
function pickPlayableOutput(contents) {
  const objs = (Array.isArray(contents) ? contents : [])
    .map((o) => ({ key: o.Key || o.key, size: Number(o.Size ?? o.size ?? 0) }))
    .filter((o) => isPlayableOutput(o.key, o.size));
  if (!objs.length) return null;
  const edited = objs.filter((o) => /-edited\.mp4$/i.test(o.key));
  const pool = edited.length ? edited : objs;
  return pool.reduce((best, o) => (best === null || o.size > best.size ? o : best), null);
}

module.exports = {
  isPlayableOutput, pickPlayableOutput, HLS_MARKERS, MIN_PLAYABLE_BYTES,
};

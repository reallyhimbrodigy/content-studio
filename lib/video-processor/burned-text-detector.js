'use strict';

// W3 — Server-side DETERMINISTIC burned-text / caption detector (Phase 1: classical CV).
//
// Replaces Gemini's unreliable boolean (it missed job 8004e7e6's burned-in
// captions three times) with a REAL measurement: sample frames → per-frame
// candidate text bands via a sharp edge-density + horizontal row-projection
// proposer → temporal aggregation into persistent bands with NUMERIC normalized
// coordinates. The output merges into frame_layout.existing_overlays and rides to
// the worker's belt via the producer-stamp convention.
//
// DESIGN (from the adversarial design panel, phased-hybrid synthesis):
//   - Gemini's failure was a RECALL miss (false negative on real captions), so
//     Phase 1 maximizes recall cheaply + deterministically. Its honest ceiling is
//     PRECISION (a static high-contrast stripe — striped shirt / blinds — can pass
//     edge density); a false positive is SAFE for the consumer (avoid the caption
//     zone), a false negative is not. Phase 2 (OCR crop-verify) is deferred behind
//     the SAME schema + decision core, added only if FP rate proves unacceptable.
//   - Everything below the sampling boundary is PURE + unit-testable: the LLM-
//     impossible determinism guarantee.
//
// COORDINATES: normalized floats [0,1], TOP-LEFT origin. x,y = band top-left;
// w = fraction of frame WIDTH, h = fraction of frame HEIGHT; y_center = y + h/2.
// Normalized against the ACTUAL extracted dims, so letterboxed proxies are correct.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
let sharp = null;
try { sharp = require('sharp'); } catch { /* absent in some envs — detectBurnedText fails open */ }

const DETECTOR_NAME = 'promptly.app-server.burned-text-detector';
const DETECTOR_VERSION = '2026-07-11';
const DETECTOR_METHOD = 'sharp-edgedensity-hproject-temporal';

// ── tuning (deterministic thresholds) ─────────────────────────────────────
const FRAME_COUNT = 12;            // uniformly-spaced samples across duration
const MIN_OK_FRAMES_FRAC = 0.5;    // need ≥50% of frames to actually decode, else fail-open
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024; // hard cap: never buffer an unbounded source
const OVERALL_DEADLINE_MS = 14000; // internal wall-clock budget; aborts in-flight ffmpeg/axios
const FRAME_FFMPEG_TIMEOUT_MS = 8000;
const SAMPLE_WIDTH = 480;          // downscale width for the proposer (speed + stable)
const EDGE_THRESH = 36;            // gradient magnitude (0..255) → binary edge
const ROW_DENSITY_FLOOR = 0.10;    // a text row: ≥10% of columns are edges
const ROW_DENSITY_K = 0.8;         // adaptive: mean + k·std of the row profile
const MIN_BAND_WIDTH = 0.25;       // captions span ≥25% of frame width
const MIN_BAND_H = 0.012;          // ignore 1-row specks
const MAX_BAND_H = 0.30;           // a text line is short; a tall block isn't a caption
const PERSISTENCE_MIN = 0.5;       // persistent band: present in ≥50% of frames
const COVERAGE_MIN = 0.5;          // caption-zone-coverage OR-term (catches karaoke)
const Y_OVERLAP_MERGE = 0.3;       // temporal clustering: vertical overlap ratio
const CAPTION_Y_MIN = 0.55;        // caption zone (center-y) — where burned captions live
const CAPTION_Y_MAX = 0.985;

function zoneOf(yc) {
  if (yc < 0.20) return 'top';
  if (yc < 0.40) return 'upper';
  if (yc < 0.60) return 'middle';
  if (yc < 0.88) return 'lower-third';
  return 'bottom';
}
function inCaptionZone(yc) { return yc >= CAPTION_Y_MIN && yc <= CAPTION_Y_MAX; }
function kindOf(box) {
  if (inCaptionZone(box.y_center) && box.w >= MIN_BAND_WIDTH) return 'caption';
  if (box.y_center < 0.20 && box.w < 0.5) return 'logo';
  return 'graphic';
}
function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function round4(n) { return Math.round(n * 1e4) / 1e4; }

// ── PURE: per-frame proposer ───────────────────────────────────────────────
// gray = Uint8 luma buffer (length W*H), row-major. Returns candidate text
// bands as normalized boxes. Deterministic. No IO — testable on hand-built buffers.
function detectFrameBands(gray, W, H) {
  if (!gray || !W || !H || gray.length < W * H) return [];
  // 1) row edge-density profile: central-difference gradient magnitude, thresholded
  const rowDensity = new Float64Array(H);
  for (let y = 1; y < H - 1; y++) {
    let edges = 0;
    const row = y * W;
    for (let x = 1; x < W - 1; x++) {
      const i = row + x;
      const gx = Math.abs(gray[i + 1] - gray[i - 1]);
      const gy = Math.abs(gray[i + W] - gray[i - W]);
      if (gx + gy >= EDGE_THRESH) edges++;
    }
    rowDensity[y] = edges / W;
  }
  // 2) adaptive row threshold (mean + k·std, floored)
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < H - 1; y++) { sum += rowDensity[y]; sum2 += rowDensity[y] * rowDensity[y]; n++; }
  const mean = n ? sum / n : 0;
  const varr = n ? Math.max(0, sum2 / n - mean * mean) : 0;
  const std = Math.sqrt(varr);
  const rowThresh = Math.max(ROW_DENSITY_FLOOR, mean + ROW_DENSITY_K * std);
  // 3) group contiguous high-density rows → horizontal bands
  const bands = [];
  let yStart = -1;
  for (let y = 1; y < H - 1; y++) {
    const hot = rowDensity[y] >= rowThresh;
    if (hot && yStart < 0) yStart = y;
    if ((!hot || y === H - 2) && yStart >= 0) {
      const yEnd = hot ? y : y - 1;
      bands.push({ yStart, yEnd });
      yStart = -1;
    }
  }
  // 4) for each band, measure x-extent (columns with edges in those rows) + emit
  const out = [];
  for (const b of bands) {
    const hBand = (b.yEnd - b.yStart + 1) / H;
    if (hBand < MIN_BAND_H || hBand > MAX_BAND_H) continue;
    // column edge counts within the band rows
    const colHit = new Uint32Array(W);
    let bandEdges = 0;
    for (let y = b.yStart; y <= b.yEnd; y++) {
      const row = y * W;
      for (let x = 1; x < W - 1; x++) {
        const i = row + x;
        if (Math.abs(gray[i + 1] - gray[i - 1]) + Math.abs(gray[i + W] - gray[i - W]) >= EDGE_THRESH) {
          colHit[x]++; bandEdges++;
        }
      }
    }
    // x-extent: first/last column whose hit-count clears a small floor
    const colFloor = Math.max(1, Math.floor((b.yEnd - b.yStart + 1) * 0.15));
    let xMin = -1, xMax = -1;
    for (let x = 0; x < W; x++) { if (colHit[x] >= colFloor) { if (xMin < 0) xMin = x; xMax = x; } }
    if (xMin < 0) continue;
    const wBand = (xMax - xMin + 1) / W;
    const bandRows = (b.yEnd - b.yStart + 1);
    const density = bandEdges / (bandRows * W);
    const y = b.yStart / H;
    const box = {
      x: round4(xMin / W), y: round4(y), w: round4(wBand), h: round4(hBand),
      y_center: round4(y + hBand / 2), edge_density: round4(density),
    };
    out.push(box);
  }
  return out;
}

// ── PURE: temporal aggregation ─────────────────────────────────────────────
// perFrameBoxes: array (one entry per sampled frame) of box arrays. Returns the
// measured detection: persistent numeric bands + caption_zone_coverage + the real
// has_burned_captions. Deterministic. Clusters boxes across frames by vertical
// overlap; a cluster present in ≥PERSISTENCE_MIN of frames is a persistent band.
function aggregateBands(perFrameBoxes, opts = {}) {
  // A FAILED frame extraction is pushed as null and must NOT be counted as a
  // clean sample — otherwise failures dilute persistence + coverage toward a
  // falsely-confident has_burned_captions=false. Only actually-decoded frames
  // (arrays, incl. the empty [] of a genuinely text-free frame) count.
  const frames = (Array.isArray(perFrameBoxes) ? perFrameBoxes : []).filter((f) => Array.isArray(f));
  const framesSampled = frames.length;
  const persistenceMin = opts.persistenceMin ?? PERSISTENCE_MIN;
  const coverageMin = opts.coverageMin ?? COVERAGE_MIN;

  // caption-zone coverage: fraction of frames with ≥1 box centered in the caption zone
  let capFrames = 0;
  for (const boxes of frames) {
    if ((boxes || []).some((b) => inCaptionZone(b.y_center))) capFrames++;
  }
  const captionZoneCoverage = framesSampled ? round4(capFrames / framesSampled) : 0;

  // cluster all boxes by vertical overlap; track which FRAME each came from
  const flat = [];
  frames.forEach((boxes, fi) => (boxes || []).forEach((b) => flat.push({ ...b, _f: fi })));
  flat.sort((a, b) => a.y_center - b.y_center);
  const clusters = [];
  for (const b of flat) {
    let placed = null;
    for (const c of clusters) {
      // vertical overlap ratio vs the cluster's current y-range
      const top = Math.max(b.y, c.yTop), bot = Math.min(b.y + b.h, c.yBot);
      const inter = Math.max(0, bot - top);
      const denom = Math.min(b.h, c.yBot - c.yTop) || 1e-6;
      if (inter / denom >= Y_OVERLAP_MERGE) { placed = c; break; }
    }
    if (!placed) { placed = { yTop: b.y, yBot: b.y + b.h, boxes: [], frameSet: new Set() }; clusters.push(placed); }
    placed.boxes.push(b);
    placed.frameSet.add(b._f);
    placed.yTop = Math.min(placed.yTop, b.y);
    placed.yBot = Math.max(placed.yBot, b.y + b.h);
  }

  const textBands = [];
  for (const c of clusters) {
    const framesPresent = c.frameSet.size;
    const persistence = framesSampled ? framesPresent / framesSampled : 0;
    if (persistence < persistenceMin) continue;
    const box = {
      x: round4(median(c.boxes.map((b) => b.x))),
      y: round4(median(c.boxes.map((b) => b.y))),
      w: round4(median(c.boxes.map((b) => b.w))),
      h: round4(median(c.boxes.map((b) => b.h))),
      edge_density: round4(median(c.boxes.map((b) => b.edge_density))),
    };
    box.y_center = round4(box.y + box.h / 2);
    box.zone = zoneOf(box.y_center);
    box.kind = kindOf(box);
    box.persistence = round4(persistence);
    box.frames_present = framesPresent;
    box.frames_sampled = framesSampled;
    box.ocr_confidence = null; // Phase 2
    box.sample_text = null;    // Phase 2
    textBands.push(box);
  }
  textBands.sort((a, b) => a.y_center - b.y_center);

  const persistentCaption = textBands.some((b) => inCaptionZone(b.y_center) && b.w >= MIN_BAND_WIDTH);
  const hasBurnedCaptions = persistentCaption || captionZoneCoverage >= coverageMin;
  const hasTextGraphics = textBands.length > 0;

  return {
    has_burned_captions: hasBurnedCaptions,
    has_text_graphics: hasTextGraphics,
    text_bands: textBands,
    caption_zone_coverage: captionZoneCoverage,
    overlay_locations: overlayProse(textBands),
    frames_sampled: framesSampled,
  };
}

function overlayProse(bands) {
  if (!bands.length) return 'none detected';
  const parts = bands.map((b) => `${b.kind} in ${b.zone}`);
  return `measured: ${[...new Set(parts)].join(', ')}`;
}

// ── PURE: merge detection into an analysis blob (non-destructive + stamped) ──
function mergeBandsIntoAnalysis(analysis, detection, meta = {}) {
  const a = analysis && typeof analysis === 'object' ? analysis : {};
  const fl = (a.frame_layout && typeof a.frame_layout === 'object') ? a.frame_layout : {};
  const prevOverlays = (fl.existing_overlays && typeof fl.existing_overlays === 'object') ? fl.existing_overlays : {};
  const stamp = {
    name: DETECTOR_NAME,
    version: DETECTOR_VERSION,
    method: DETECTOR_METHOD,
    source: meta.source || 'unknown',
    frames_sampled: detection.frames_sampled,
    frame_dims: meta.frame_dims || null,
    measured_at: meta.measured_at || new Date().toISOString(),
  };
  const existing_overlays = {
    ...prevOverlays,
    has_burned_captions: detection.has_burned_captions,
    has_text_graphics: detection.has_text_graphics,
    overlay_locations: detection.overlay_locations,
    text_bands: detection.text_bands,
    caption_zone_coverage: detection.caption_zone_coverage,
    detector: stamp,
  };
  return { ...a, frame_layout: { ...fl, existing_overlays } };
}

/** Already carries THIS detector version? (idempotency for the dispatch/cache path) */
function hasCurrentDetection(analysis) {
  const v = analysis?.frame_layout?.existing_overlays?.detector?.version;
  return v === DETECTOR_VERSION;
}

// ── IO: sample frames with ffmpeg, decode to gray via sharp ─────────────────
function ffmpegBin() { return process.env.FFMPEG_PATH || 'ffmpeg'; }

function runFfmpeg(args, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegBin(), args, { timeout: timeoutMs, maxBuffer: 1 << 24, signal }, (err) => (err ? reject(err) : resolve()));
  });
}

async function extractFramePng(videoPath, tsSec, outPath, signal) {
  await runFfmpeg([
    '-y', '-loglevel', 'error',
    '-ss', String(tsSec), '-i', videoPath,
    '-frames:v', '1',
    '-vf', `scale=${SAMPLE_WIDTH}:-2`,
    '-pix_fmt', 'gray',
    outPath,
  ], FRAME_FFMPEG_TIMEOUT_MS, signal);
}

async function decodeGray(pngPath) {
  const { data, info } = await sharp(pngPath).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { gray: data, W: info.width, H: info.height };
}

// sharp takes no AbortSignal; bound each decode so a pathological/hung decode
// surfaces as a caught frame failure (→ null → fail-open) and never leaves the
// loop pending past the deadline (which would leak the temp dir).
function withTimeout(promise, ms, label) {
  let t;
  const timer = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out`)), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

/**
 * Detect burned text on a local file or URL. Returns { detection, meta } or null
 * (fail-open: any error → null so the caller keeps the Gemini boolean).
 */
async function detectBurnedText(pathOrUrl, opts = {}) {
  if (!sharp) { console.warn('[burned-text] sharp unavailable — skipping detection'); return null; }
  let localPath = pathOrUrl;
  let cleanupVideo = null;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btd-'));
  // Internal wall-clock budget + cancellation: aborts the in-flight download and
  // ffmpeg execs when the deadline passes, so a slow/hung source can never leave
  // detached work (ffmpeg processes, a growing temp dir) running for minutes past
  // the caller's timeout. Self-bounded → the caller's outer race is just a backstop.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), opts.deadlineMs || OVERALL_DEADLINE_MS);
  try {
    if (/^https?:\/\//.test(pathOrUrl)) {
      // HARD size cap — never buffer an unbounded source into memory on the
      // render-critical web process (axios defaults are uncapped).
      const res = await axios.get(pathOrUrl, {
        responseType: 'arraybuffer', timeout: 12000, signal: controller.signal,
        maxContentLength: MAX_DOWNLOAD_BYTES, maxBodyLength: MAX_DOWNLOAD_BYTES,
      });
      localPath = path.join(tmpDir, 'src.mp4');
      fs.writeFileSync(localPath, Buffer.from(res.data));
      cleanupVideo = localPath;
    }
    // Prefer a caller-supplied duration (the dispatch passes analysis.duration) so
    // probeDuration is skipped on the critical path; else probe, bounded + abortable.
    const duration = Number(opts.duration) || await probeDuration(localPath, controller.signal);
    if (!duration || !Number.isFinite(duration) || duration <= 0) {
      console.warn('[burned-text] no usable duration — skipping'); return null;
    }
    const count = opts.frameCount || FRAME_COUNT;
    // uniformly-spaced timestamps, avoiding the exact first/last frame
    const stamps = [];
    for (let i = 0; i < count; i++) stamps.push(round4(((i + 0.5) / count) * duration));

    const perFrameBoxes = [];
    let dims = null, okFrames = 0;
    for (let i = 0; i < stamps.length; i++) {
      if (controller.signal.aborted) { perFrameBoxes.push(null); continue; }
      const png = path.join(tmpDir, `f${i}.png`);
      try {
        await extractFramePng(localPath, stamps[i], png, controller.signal);
        const { gray, W, H } = await withTimeout(decodeGray(png), FRAME_FFMPEG_TIMEOUT_MS, 'sharp decode');
        if (!dims) dims = [W, H];
        perFrameBoxes.push(detectFrameBands(gray, W, H));
        okFrames++;
      } catch (e) {
        console.warn(`[burned-text] frame ${i}@${stamps[i]}s failed: ${e.message}`);
        perFrameBoxes.push(null); // FAILED — not a clean sample; excluded from the denominator
      } finally {
        try { fs.unlinkSync(png); } catch {}
      }
    }
    // Too many frames failed → we can't trust a has_burned_captions=false that
    // would overwrite Gemini. Fail-open (null) rather than assert a diluted result.
    if (okFrames < Math.ceil(count * MIN_OK_FRAMES_FRAC)) {
      console.warn(`[burned-text] only ${okFrames}/${count} frames decoded — failing open`);
      return null;
    }
    const detection = aggregateBands(perFrameBoxes, opts);
    const meta = { source: opts.source || (cleanupVideo ? 'source' : 'local'), frame_dims: dims, measured_at: opts.measured_at };
    return { detection, meta };
  } catch (e) {
    console.error(`[burned-text] detection failed (fail-open): ${e.message}`);
    return null;
  } finally {
    clearTimeout(deadline);
    try { if (cleanupVideo) fs.unlinkSync(cleanupVideo); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function probeDuration(videoPath, signal) {
  return new Promise((resolve) => {
    const bin = process.env.FFPROBE_PATH || 'ffprobe';
    execFile(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', videoPath],
      { timeout: FRAME_FFMPEG_TIMEOUT_MS, signal }, (err, stdout) => resolve(err ? 0 : parseFloat(String(stdout).trim()) || 0));
  });
}

module.exports = {
  detectBurnedText, detectFrameBands, aggregateBands, mergeBandsIntoAnalysis, hasCurrentDetection,
  zoneOf, inCaptionZone,
  DETECTOR_NAME, DETECTOR_VERSION, DETECTOR_METHOD,
  CAPTION_Y_MIN, CAPTION_Y_MAX, MIN_BAND_WIDTH, PERSISTENCE_MIN, COVERAGE_MIN, FRAME_COUNT,
};

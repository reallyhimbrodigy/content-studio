'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  detectFrameBands, aggregateBands, mergeBandsIntoAnalysis, hasCurrentDetection,
  inCaptionZone, DETECTOR_VERSION, DETECTOR_NAME, MIN_BAND_WIDTH,
} = require('../lib/video-processor/burned-text-detector');

// ── PURE aggregateBands: the LLM-impossible deterministic decision core ──────
const capBox = (o = {}) => ({ x: 0.06, y: 0.74, w: 0.85, h: 0.10, y_center: 0.79, edge_density: 0.4, ...o });

test('stable lower-third band in 10/12 frames → one caption band, has_burned_captions=true', () => {
  const frames = Array.from({ length: 12 }, (_, i) => (i < 10 ? [capBox()] : []));
  const d = aggregateBands(frames);
  assert.equal(d.text_bands.length, 1);
  const b = d.text_bands[0];
  assert.equal(b.kind, 'caption');
  assert.equal(b.zone, 'lower-third');
  assert.ok(inCaptionZone(b.y_center));
  assert.ok(Math.abs(b.persistence - 10 / 12) < 0.01);
  assert.equal(b.frames_present, 10);
  assert.equal(d.has_burned_captions, true);
  assert.equal(d.has_text_graphics, true);
});

test('OR-term: caption-zone boxes that jitter (no persistent cluster) still fire via coverage', () => {
  // every frame has a caption-zone box, but y rotates so no single cluster hits ≥50%
  const ys = [0.60, 0.70, 0.80];
  const frames = Array.from({ length: 12 }, (_, i) => [capBox({ y: ys[i % 3] - 0.05, y_center: ys[i % 3] })]);
  const d = aggregateBands(frames);
  assert.ok(d.caption_zone_coverage >= 0.99, 'every frame has a caption-zone box');
  assert.equal(d.has_burned_captions, true, 'coverage OR-term catches karaoke/word-by-word captions');
});

test('transient band (2/12 frames) → not persistent, has_burned_captions=false', () => {
  const frames = Array.from({ length: 12 }, (_, i) => (i < 2 ? [capBox()] : []));
  const d = aggregateBands(frames);
  assert.equal(d.text_bands.length, 0, 'below persistence floor');
  assert.equal(d.has_burned_captions, false);
  assert.ok(d.caption_zone_coverage < 0.5);
});

test('top-corner logo (all frames) → kind=logo, has_text_graphics=true, has_burned_captions=false', () => {
  const logo = { x: 0.02, y: 0.02, w: 0.18, h: 0.05, y_center: 0.045, edge_density: 0.3 };
  const frames = Array.from({ length: 12 }, () => [logo]);
  const d = aggregateBands(frames);
  assert.equal(d.text_bands.length, 1);
  assert.equal(d.text_bands[0].kind, 'logo');
  assert.equal(d.text_bands[0].zone, 'top');
  assert.equal(d.has_text_graphics, true);
  assert.equal(d.has_burned_captions, false, 'a logo is not a burned caption');
});

test('FAILED frames (null) do not dilute persistence/coverage toward a false negative', () => {
  // 6 frames caught the caption; 6 frames FAILED to decode (null). A failed frame
  // must NOT count as a clean sample — denominator is the 6 decoded frames, so the
  // caption is 6/6 persistent, not 6/12.
  const C = () => [capBox()]; // a frame that caught the caption
  const frames = [C(), C(), C(), null, null, C(), null, C(), null, C(), null, null];
  const d = aggregateBands(frames);
  assert.equal(d.text_bands.length, 1, 'the caption survives despite half the frames failing');
  assert.ok(d.text_bands[0].persistence >= 0.99, 'persistence over DECODED frames, not attempted');
  assert.equal(d.text_bands[0].frames_sampled, 6, 'nulls excluded from the denominator');
  assert.equal(d.has_burned_captions, true);
});

test('empty frames → clean result, no bands', () => {
  const d = aggregateBands(Array.from({ length: 8 }, () => []));
  assert.deepEqual(d.text_bands, []);
  assert.equal(d.has_burned_captions, false);
  assert.equal(d.has_text_graphics, false);
  assert.equal(d.caption_zone_coverage, 0);
  assert.equal(d.overlay_locations, 'none detected');
});

// ── PURE detectFrameBands on hand-built luma buffers (no ffmpeg) ─────────────
function buf(W, H, fill) { const b = Buffer.alloc(W * H, fill); return b; }

test('proposer: a painted caption-like stripe in the lower third → one band in the caption zone', () => {
  const W = 480, H = 854;
  const g = buf(W, H, 128);
  // 2px-wide bars (realistic caption stroke width; a 1px pattern would be invisible
  // to a central-difference gradient since I(x+1)===I(x-1)) in rows 680..716, x 48..432
  for (let y = 680; y <= 716; y++) for (let x = 48; x <= 432; x++) g[y * W + x] = (Math.floor(x / 2) % 2 ? 235 : 20);
  const bands = detectFrameBands(g, W, H);
  assert.ok(bands.length >= 1, 'stripe detected');
  const b = bands.find((bb) => inCaptionZone(bb.y_center));
  assert.ok(b, 'a band lands in the caption zone');
  assert.ok(b.y_center > 0.75 && b.y_center < 0.88, `y_center ${b.y_center} in lower third`);
  assert.ok(b.w >= MIN_BAND_WIDTH, `width ${b.w} spans the caption`);
});

test('proposer: a flat frame → no bands (no edges)', () => {
  assert.deepEqual(detectFrameBands(buf(480, 854, 128), 480, 854), []);
});

test('proposer: a smooth horizontal gradient → no bands (sub-threshold edges)', () => {
  const W = 480, H = 854; const g = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = Math.floor((x / W) * 255);
  assert.deepEqual(detectFrameBands(g, W, H), [], 'gradient is not text');
});

test('proposer: guards — bad input returns []', () => {
  assert.deepEqual(detectFrameBands(null, 10, 10), []);
  assert.deepEqual(detectFrameBands(Buffer.alloc(4), 100, 100), []);
});

// ── PURE mergeBandsIntoAnalysis: non-destructive + stamped + idempotent ──────
test('merge: stamps + preserves prior analysis (non-destructive) + null-safe', () => {
  const detection = aggregateBands(Array.from({ length: 12 }, (_, i) => (i < 10 ? [capBox()] : [])));
  const analysis = {
    duration: 12.5, shots: [{ start: 0, end: 12.5 }],
    frame_layout: { subject_position: 'centered', free_zones: 'top', existing_overlays: { has_text_graphics: false } },
  };
  const merged = mergeBandsIntoAnalysis(analysis, detection, { source: 'proxy', frame_dims: [480, 854], measured_at: '2026-07-11T00:00:00.000Z' });
  const eo = merged.frame_layout.existing_overlays;
  assert.equal(eo.has_burned_captions, true);
  assert.equal(eo.text_bands.length, 1);
  assert.equal(typeof eo.caption_zone_coverage, 'number');
  assert.equal(eo.detector.name, DETECTOR_NAME);
  assert.equal(eo.detector.version, DETECTOR_VERSION);
  assert.deepEqual(eo.detector.frame_dims, [480, 854]);
  // non-destructive
  assert.equal(merged.frame_layout.subject_position, 'centered');
  assert.equal(merged.frame_layout.free_zones, 'top');
  assert.equal(merged.duration, 12.5);
  // idempotency signal
  assert.equal(hasCurrentDetection(merged), true);
  assert.equal(hasCurrentDetection(analysis), false);
  // null-safe
  const fromNull = mergeBandsIntoAnalysis(null, detection, {});
  assert.equal(fromNull.frame_layout.existing_overlays.detector.version, DETECTOR_VERSION);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { detectBurnedText, inCaptionZone } = require('../lib/video-processor/burned-text-detector');

// Golden e2e through the REAL ffmpeg+sharp pipeline. Fixtures are generated at
// test time (no committed binaries, no font dependency): a sharp-painted frame
// looped into a short video. Proves (a) the pipeline catches a real caption-like
// band and (b) it is DETERMINISTIC — the headline property an LLM call can't have.

let sharp = null; try { sharp = require('sharp'); } catch {}
function have(bin) { try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } }
const READY = sharp && have('ffmpeg') && have('ffprobe');

const W = 480, H = 854;
function paintFrame(withCaption) {
  const g = Buffer.alloc(W * H, 128);
  if (withCaption) {
    // 2px bars (realistic stroke width) in the lower third → caption-like edges
    for (let y = 680; y <= 720; y++) for (let x = 48; x <= 432; x++) g[y * W + x] = (Math.floor(x / 2) % 2 ? 235 : 20);
  }
  return g;
}
async function makeVideo(dir, name, withCaption) {
  const png = path.join(dir, `${name}.png`);
  await sharp(paintFrame(withCaption), { raw: { width: W, height: H, channels: 1 } }).png().toFile(png);
  const mp4 = path.join(dir, `${name}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', png, '-t', '2', '-r', '5', '-pix_fmt', 'yuv420p', mp4], { stdio: 'ignore' });
  return mp4;
}
const stripVolatile = (det) => ({ ...det, /* detection has no volatile field; meta.measured_at excluded separately */ });

test('e2e: a captioned video → has_burned_captions=true with a lower-third caption band', { skip: !READY }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btd-e2e-'));
  try {
    const mp4 = await makeVideo(dir, 'cap', true);
    const r = await detectBurnedText(mp4, { duration: 2, source: 'local' });
    assert.ok(r && r.detection, 'detector ran');
    assert.equal(r.detection.has_burned_captions, true, 'catches the burned caption');
    const cap = r.detection.text_bands.find((b) => b.kind === 'caption' && inCaptionZone(b.y_center));
    assert.ok(cap, 'a caption band in the caption zone');
    assert.ok(cap.w >= 0.25 && cap.x >= 0 && cap.x <= 1 && cap.y >= 0 && cap.y <= 1, 'normalized coordinates');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('e2e: DETERMINISM — two runs on the same video produce identical detection', { skip: !READY }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btd-e2e-'));
  try {
    const mp4 = await makeVideo(dir, 'cap', true);
    const a = await detectBurnedText(mp4, { duration: 2, source: 'local' });
    const b = await detectBurnedText(mp4, { duration: 2, source: 'local' });
    // detection is fully deterministic; meta.measured_at is the only volatile field and lives outside detection
    assert.deepEqual(stripVolatile(a.detection), stripVolatile(b.detection), 'byte-identical detection across runs');
    assert.deepEqual(a.meta.frame_dims, b.meta.frame_dims);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('e2e: a clean (flat) video → no caption bands, has_burned_captions=false', { skip: !READY }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btd-e2e-'));
  try {
    const mp4 = await makeVideo(dir, 'clean', false);
    const r = await detectBurnedText(mp4, { duration: 2, source: 'local' });
    assert.ok(r && r.detection);
    assert.equal(r.detection.has_burned_captions, false, 'no false positive on flat footage');
    assert.equal(r.detection.text_bands.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

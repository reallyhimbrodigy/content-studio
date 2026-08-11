'use strict';
// WATERMARK-AT-EXPORT v1 (lane/delivery 2026-08-11, built DARK).
//
// A LOCAL ffmpeg pass on this container — no Gemini, no Modal. The free-tier
// export gets the brand watermark; Pro gets the clean master. The asset is the
// repo's existing src/assets/watermark.png (200x40 RGBA, the same one
// render-ffmpeg has always shipped), overlaid bottom-right at ~22% of video
// width with a safe margin, semi-transparent. Video re-encodes once (x264
// veryfast, crf 20 — an export copy, not the render master; the single-lossy-
// pass law governs RENDERS, this is a derivative export the user chose);
// audio is stream-copied.
//
// S3 CONTRACT: watermarked copy lives at exports/{job_id}/watermarked.mp4
// beside the ERRORS-owned clean master exports/{job_id}/clean.mp4. Idempotent:
// if the object already exists we presign it without re-rendering, so repeat
// exports cost one HEAD.
//
// DARK: nothing calls this until EXPORT_WATERMARK_ENABLED=1 (see the /api/export
// handler). The smoke (lib/__smoke_export_watermark.js) exercises the ffmpeg
// pass on a generated clip at BUILD time, so "does the watermark pass run in
// this container?" is proven by the gate, not discovered by the first customer.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WATERMARK_PATH = path.join(__dirname, '..', 'src', 'assets', 'watermark.png');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '').slice(-2000);
        return reject(err);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * Overlay the brand watermark onto a local video file. Pure-local ffmpeg.
 * Watermark scales to ~22% of the video width (min 120px), bottom-right,
 * 2.5% safe margin, 60% opacity. Audio copied; +faststart for streaming.
 */
async function watermarkFile(inPath, outPath, { watermarkPath = WATERMARK_PATH, timeoutMs = 10 * 60 * 1000 } = {}) {
  if (!fs.existsSync(inPath)) throw new Error(`watermark input missing: ${inPath}`);
  if (!fs.existsSync(watermarkPath)) throw new Error(`watermark asset missing: ${watermarkPath}`);
  const filter =
    // scale the mark relative to the MAIN video width; keep the mark's own
    // aspect (`a` = the scaled input's w/h in scale2ref expressions)
    '[1][0]scale2ref=w=\'max(120,main_w*0.22)\':h=\'ow/a\'[wm][base];' +
    '[wm]format=rgba,colorchannelmixer=aa=0.6[wmt];' +
    '[base][wmt]overlay=x=main_w-overlay_w-main_w*0.025:y=main_h-overlay_h-main_h*0.025';
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', inPath,
    '-i', watermarkPath,
    '-filter_complex', filter,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outPath,
  ];
  await run(FFMPEG, args, timeoutMs);
  const st = fs.statSync(outPath);
  if (!st.size) throw new Error('watermark output is empty');
  return outPath;
}

/**
 * Idempotently materialize the watermarked export for a job in S3.
 * Returns the S3 key of the watermarked copy. Downloads the clean master via
 * a short-TTL signed URL, watermarks locally, uploads. One HEAD short-circuit.
 */
async function ensureWatermarkedExport({ s3, jobId, cleanKey, fetchImpl = fetch }) {
  const wmKey = `exports/${jobId}/watermarked.mp4`;
  if (await s3.objectExists(wmKey)) return wmKey;

  const srcUrl = await s3.createPresignedGetUrl(cleanKey, 300);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wm-${String(jobId).slice(0, 8)}-`));
  const inPath = path.join(dir, 'clean.mp4');
  const outPath = path.join(dir, 'watermarked.mp4');
  try {
    const resp = await fetchImpl(srcUrl);
    if (!resp.ok) throw new Error(`clean master fetch ${resp.status}`);
    fs.writeFileSync(inPath, Buffer.from(await resp.arrayBuffer()));
    await watermarkFile(inPath, outPath);
    await s3.upload(wmKey, fs.readFileSync(outPath), 'video/mp4');
    return wmKey;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* tmp cleanup best-effort */ }
  }
}

module.exports = { watermarkFile, ensureWatermarkedExport, WATERMARK_PATH };

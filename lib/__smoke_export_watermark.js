'use strict';
// IN-CONTAINER proof for watermark-at-export v1 (lane/delivery 2026-08-11).
// Runs at build time via validate_deploy, so "does the ffmpeg watermark pass
// work in THIS container, with THIS ffmpeg, with the shipped watermark.png?"
// is answered by the gate on every deploy — never by the first paying customer.
//
// Laws: (1) the pass produces a non-empty, probe-decodable mp4; (2) duration is
// preserved (±0.25s on a 1s clip); (3) output pixels differ from input in the
// overlay corner (the watermark is actually ON the video — signalstats YAVG on
// the bottom-right region); (4) a missing watermark asset fails loudly, never
// silently exports clean.
//
// NO-FFMPEG DEGRADES TO SKIP, NEVER TO FAIL (TRUTH's BLOCKER_C2 filing,
// 2026-08-11). Render's standard Node runtime does not ship the ffmpeg binary
// (fluent-ffmpeg is a JS wrapper only; render.yaml installs nothing), and this
// gate runs in render.yaml's buildCommand — so a hard failure here does not
// block THIS deploy, it blocks EVERY future content-studio deploy. The honest
// answer when the binary is absent is "the watermark pass cannot be verified
// here", which must block the FLIP, not the BUILD. The skip is recorded by
// name in .gate_receipt.json (validate_deploy.js) and surfaced on /api/health,
// so a skip can never read as a pass at flip time.

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { watermarkFile, WATERMARK_PATH } = require('./export-watermark');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// Presence probe. `-version` is the cheapest call that proves the binary is
// executable, not merely named on PATH.
function missingBinary(bin) {
  try {
    execFileSync(bin, ['-version'], { stdio: 'pipe', timeout: 15000 });
    return null;
  } catch (e) {
    return `${bin} (${e && e.code ? e.code : (e && e.message) || 'unavailable'})`;
  }
}

function probeDuration(p) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', p], { timeout: 30000 }).toString().trim();
  return parseFloat(out);
}

// Mean luma of the bottom-right corner region (where the mark lands). The
// metadata printer writes to stderr; run through sh to merge streams.
function cornerY(p) {
  const text = execFileSync('sh', ['-c',
    `${FFMPEG} -hide_banner -i ${JSON.stringify(p)} ` +
    '-vf "crop=iw/3:ih/6:iw-iw/3:ih-ih/6,signalstats,metadata=print:key=lavfi.signalstats.YAVG" ' +
    '-frames:v 1 -f null - 2>&1'], { timeout: 30000 }).toString();
  const m = text.match(/YAVG=([0-9.]+)/);
  return m ? parseFloat(m[1]) : NaN;
}

(async () => {
  // Law (4): the asset must exist in the repo. Asserted BEFORE the ffmpeg
  // probe — a missing asset is our defect and fails on any container, with or
  // without ffmpeg. Only the binary's absence is skippable.
  assert.ok(fs.existsSync(WATERMARK_PATH), `watermark asset missing at ${WATERMARK_PATH}`);

  const absent = [missingBinary(FFMPEG), missingBinary(FFPROBE)].filter(Boolean);
  if (absent.length) {
    // The `SKIP(` prefix is the gate's machine contract (validate_deploy.js).
    console.log(`SKIP(no-ffmpeg) export-watermark: ${absent.join(', ')} not executable on this container.`);
    console.log('  NOT VERIFIED HERE: watermark composites, duration preserved, corner pixels change.');
    console.log('  ⇒ EXPORT_WATERMARK_ENABLED=1 must NOT be flipped on this build (see /api/health .gate.skipped).');
    process.exit(0);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-smoke-'));
  const inPath = path.join(dir, 'in.mp4');
  const outPath = path.join(dir, 'out.mp4');

  // 1s 320x568 flat-color clip with audio (the aac stream proves -c:a copy works).
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x224466:s=320x568:d=1:r=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', inPath],
    { timeout: 60000 });

  await watermarkFile(inPath, outPath);

  const dIn = probeDuration(inPath);
  const dOut = probeDuration(outPath);
  assert.ok(dOut > 0, 'output not probe-decodable');
  assert.ok(Math.abs(dOut - dIn) < 0.25, `duration drifted ${dIn} -> ${dOut}`);

  const yIn = cornerY(inPath);
  const yOut = cornerY(outPath);
  assert.ok(Number.isFinite(yIn) && Number.isFinite(yOut), `corner luma unreadable (in=${yIn} out=${yOut})`);
  assert.ok(Math.abs(yOut - yIn) > 1.0,
    `corner unchanged (YAVG ${yIn} -> ${yOut}) — watermark not visibly composited`);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`export-watermark smoke: PASS (decodable, duration ${dIn}->${dOut}s, corner YAVG ${yIn}->${yOut})`);
  process.exit(0);
})().catch((e) => {
  console.error('export-watermark smoke FAILED:', e && e.message, e && e.stderr ? `\nffmpeg: ${e.stderr}` : '');
  process.exit(1);
});

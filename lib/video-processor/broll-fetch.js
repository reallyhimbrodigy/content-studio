const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execFile } = require('child_process');

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PEXELS_BASE = 'https://api.pexels.com/videos/search';
const BROLL_MIN_WIDTH = 1080;

async function fetchBrollClip(keyword) {
  if (!PEXELS_API_KEY) {
    console.log('[broll] PEXELS_API_KEY not set, skipping b-roll');
    return null;
  }

  try {
    const url = `${PEXELS_BASE}?query=${encodeURIComponent(keyword)}&per_page=1&size=small&orientation=portrait`;
    const { data, status } = await axios.get(url, {
      headers: { Authorization: PEXELS_API_KEY },
      timeout: 12000,
      validateStatus: () => true,
    });

    if (status < 200 || status >= 300) {
      console.log(`[broll] Pexels API error (${status}) for "${keyword}"`);
      return null;
    }

    const video = data?.videos?.[0];
    if (!video) {
      console.log(`[broll] No results for "${keyword}"`);
      return null;
    }

    const file = (video.video_files || [])
      .filter((f) => f?.width >= BROLL_MIN_WIDTH)
      .sort((a, b) => a.width - b.width)[0];

    if (!file?.link) {
      console.log(`[broll] No ${BROLL_MIN_WIDTH}+ resolution available for "${keyword}", skipping`);
      return null;
    }

    return {
      keyword,
      url: file.link,
      width: file.width,
      height: file.height,
      duration: Number(video.duration || 0),
    };
  } catch (err) {
    console.log(`[broll] Fetch error for "${keyword}": ${err.message}`);
    return null;
  }
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = execFile('ffmpeg', args, { maxBuffer: 20 * 1024 * 1024, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        console.error('[ffmpeg] PROCESS FAILED:');
        console.error(`[ffmpeg]   Exit code: ${error.code}`);
        console.error(`[ffmpeg]   Signal: ${error.signal}`);
        console.error(`[ffmpeg]   Killed: ${error.killed}`);
        console.error(`[ffmpeg]   stderr (last 500 chars): ${stderr ? stderr.slice(-500) : 'none'}`);
        reject(new Error(`FFmpeg failed: ${error.message}; ${String(stderr || '').slice(-300)}`));
        return;
      }
      resolve(stdout);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`[ffmpeg] Process received signal: ${signal} (code: ${code})`);
      }
    });
  });
}

async function downloadBrollClip(clipInfo, outputPath, neededDurationSeconds = null) {
  const resp = await axios.get(clipInfo.url, {
    responseType: 'arraybuffer',
    timeout: 25000,
  });
  let clipBuffer = Buffer.from(resp.data);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, clipBuffer);
  // Release b-roll buffer immediately after persisting to disk.
  clipBuffer = null;
  const sizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log(`[broll] Downloaded "${clipInfo.keyword}": ${sizeMB}MB`);

  const requestedDuration = Number(neededDurationSeconds || 0);
  if (requestedDuration > 0) {
    const trimTo = Math.max(0.5, requestedDuration + 0.5);
    const trimmedPath = outputPath.replace(/\.mp4$/i, '_trimmed.mp4');
    await runFFmpeg([
      '-y',
      '-t', trimTo.toFixed(3),
      '-i', outputPath,
      '-c', 'copy',
      trimmedPath,
    ]);
    fs.unlinkSync(outputPath);
    fs.renameSync(trimmedPath, outputPath);
    const trimmedSizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
    console.log(`[broll] Trimmed "${clipInfo.keyword}" to ${trimTo.toFixed(2)}s (${trimmedSizeMB}MB)`);
  }

  return outputPath;
}

module.exports = { fetchBrollClip, downloadBrollClip };

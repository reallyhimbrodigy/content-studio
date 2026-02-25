const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { supabaseAdmin } = require('../../services/supabase-admin');
const { TEMPERATURE_FILTERS } = require('./vibe-presets');

/**
 * Renders an edited video using FFmpeg in a SINGLE PASS.
 *
 * Old approach: trim+encode each clip separately -> concat/xfade -> re-encode.
 *   Result: 6 clips = 7 FFmpeg processes, every frame encoded twice. ~3 minutes.
 *
 * New approach: one FFmpeg call reads the source N times (one -i per clip region),
 *   applies color grade + transitions + encode in a single filter_complex.
 *   Result: 1 FFmpeg process, every frame encoded once. ~30-60 seconds.
 */
async function renderVideo(editPlan, videoUrl, jobId, onProgress, transcript, preDownloadedPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `promptly-${jobId}-`));
  let heartbeat = null;
  let heartbeatStep = 'Rendering...';

  try {
    console.log('🎬 Starting single-pass FFmpeg render...');
    heartbeat = setInterval(() => {
      onProgress?.(null, heartbeatStep);
    }, 30_000);

    const cuts = editPlan.cuts;

    // Build word-level timeline from Deepgram for precise cut snapping
    let wordTimeline = [];
    if (transcript?.words && Array.isArray(transcript.words)) {
      wordTimeline = transcript.words.map((w) => ({
        start: w.start,
        end: w.end,
        word: w.word || w.punctuated_word || '',
      }));
      console.log(`[ffmpeg] Word timeline: ${wordTimeline.length} words for cut snapping`);
    } else if (transcript?.results?.channels?.[0]?.alternatives?.[0]?.words) {
      wordTimeline = transcript.results.channels[0].alternatives[0].words.map((w) => ({
        start: w.start,
        end: w.end,
        word: w.word || w.punctuated_word || '',
      }));
      console.log(`[ffmpeg] Word timeline: ${wordTimeline.length} words for cut snapping`);
    }

    // Close small gaps between clips to prevent audio dropouts
    for (let i = 0; i < cuts.length - 1; i++) {
      const gap = cuts[i + 1].source_start - cuts[i].source_end;
      if (gap > 0 && gap < 1.0) {
        console.log(`[ffmpeg] Closing ${gap.toFixed(2)}s gap between clip ${i} and ${i + 1}`);
        cuts[i].source_end = cuts[i + 1].source_start;
      }
    }

    // Snap cut points to word boundaries to avoid mid-word cuts
    if (wordTimeline.length > 0) {
      for (let i = 0; i < cuts.length; i++) {
        if (cuts[i].source_start > 0) {
          const snapStart = findNearestSilence(wordTimeline, cuts[i].source_start);
          if (snapStart !== null && Math.abs(snapStart - cuts[i].source_start) < 0.5) {
            console.log(`[ffmpeg] Snap clip ${i} start: ${cuts[i].source_start.toFixed(3)} -> ${snapStart.toFixed(3)}`);
            cuts[i].source_start = snapStart;
          }
        }
        if (i < cuts.length - 1) {
          const snapEnd = findNearestSilence(wordTimeline, cuts[i].source_end);
          if (snapEnd !== null && Math.abs(snapEnd - cuts[i].source_end) < 0.5) {
            console.log(`[ffmpeg] Snap clip ${i} end: ${cuts[i].source_end.toFixed(3)} -> ${snapEnd.toFixed(3)}`);
            cuts[i].source_end = snapEnd;
          }
        }
      }
      // Re-close gaps after snapping
      for (let i = 0; i < cuts.length - 1; i++) {
        const gap = cuts[i + 1].source_start - cuts[i].source_end;
        if (gap > 0 && gap < 0.5) {
          cuts[i].source_end = cuts[i + 1].source_start;
        }
      }
    }

    const colorGrade = editPlan.color_grade || {};

    // Use pre-downloaded source if available, otherwise download now
    let sourcePath;
    if (preDownloadedPath && fs.existsSync(preDownloadedPath)) {
      sourcePath = preDownloadedPath;
      const sourceSizeMB = (fs.statSync(sourcePath).size / 1024 / 1024).toFixed(1);
      console.log(`[ffmpeg] Using pre-downloaded source: ${sourceSizeMB}MB`);
    } else {
      onProgress?.(63, 'Downloading source video...');
      sourcePath = path.join(tmpDir, 'source.mp4');
      await downloadToFile(videoUrl, sourcePath);
      const sourceSizeMB = (fs.statSync(sourcePath).size / 1024 / 1024).toFixed(1);
      console.log(`[ffmpeg] Downloaded source: ${sourceSizeMB}MB`);
    }

    // Probe source resolution to decide if we need to scale
    const sourceRes = await probeResolution(sourcePath);
    console.log(`[ffmpeg] Source resolution: ${sourceRes.width}x${sourceRes.height}`);

    // Render
    heartbeatStep = 'Rendering video...';
    onProgress?.(68, 'Rendering video...');

    const outputPath = path.join(tmpDir, 'output.mp4');

    if (cuts.length === 1) {
      await renderSingleClip(sourcePath, cuts[0], colorGrade, editPlan.strategy || '', sourceRes, outputPath);
    } else {
      await renderMultiClip(sourcePath, cuts, colorGrade, editPlan.strategy || '', sourceRes, outputPath);
    }

    const outputSize = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
    console.log(`[ffmpeg] Output rendered: ${outputSize}MB`);

    // Upload
    heartbeatStep = 'Uploading to storage...';
    onProgress?.(90, 'Uploading...');
    const publicUrl = await uploadToSupabase(outputPath, jobId);
    console.log(`[ffmpeg] Uploaded: ${publicUrl}`);

    onProgress?.(95, 'Done!');
    return publicUrl;

  } finally {
    clearInterval(heartbeat);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      console.log('[ffmpeg] Cleaned up temp files');
    } catch (e) {
      console.warn('[ffmpeg] Cleanup warning:', e.message);
    }
  }
}

/**
 * Render a single clip (no transitions needed).
 * One FFmpeg call: seek -> trim -> color grade -> encode.
 */
async function renderSingleClip(sourcePath, cut, colorGrade, strategy, sourceRes, outputPath) {
  const duration = cut.source_end - cut.source_start;
  const vfFilters = buildVideoFilterChain(colorGrade, strategy, sourceRes);

  const args = [
    '-y',
    '-ss', String(cut.source_start),
    '-i', sourcePath,
    '-t', String(duration),
    '-vf', vfFilters,
    ...encodeArgs(),
    outputPath,
  ];

  console.log(`[ffmpeg] Single clip: ${cut.source_start.toFixed(1)}s -> ${cut.source_end.toFixed(1)}s (${duration.toFixed(1)}s)`);
  await runFFmpeg(args);
}

/**
 * Render multiple clips with transitions in a SINGLE FFmpeg call.
 *
 * Strategy: feed the source file as N separate inputs (one -ss/-t/-i per clip),
 * then use filter_complex to apply color grade to each stream, chain xfade transitions,
 * and output one encoded file.
 *
 * This avoids: (a) encoding each clip separately, (b) decoding encoded clips for concat,
 * (c) spawning N+1 FFmpeg processes.
 */
async function renderMultiClip(sourcePath, cuts, colorGrade, strategy, sourceRes, outputPath) {
  const TRANSITION_DURATION = 0.3;
  const n = cuts.length;

  // === Build input args: one -ss/-t/-i per clip, all from same source ===
  const inputArgs = [];
  const durations = [];

  for (let i = 0; i < n; i++) {
    const cut = cuts[i];
    const duration = cut.source_end - cut.source_start;
    durations.push(duration);
    inputArgs.push(
      '-ss', String(cut.source_start),
      '-t', String(duration),
      '-i', sourcePath
    );
    console.log(`[ffmpeg] Input ${i}: ${cut.source_start.toFixed(1)}s -> ${cut.source_end.toFixed(1)}s (${duration.toFixed(1)}s)`);
  }

  // === Build filter_complex ===
  const colorFilterStr = buildVideoFilterChain(colorGrade, strategy, sourceRes);
  const videoFilters = [];
  const audioFilters = [];

  // Step 1: Normalize each input and apply color grade
  for (let i = 0; i < n; i++) {
    videoFilters.push(`[${i}:v]settb=AVTB,fps=30,format=yuv420p,${colorFilterStr}[v${i}]`);
    audioFilters.push(`[${i}:a]asetpts=PTS-STARTPTS[a${i}]`);
  }

  // Step 2: Chain xfade transitions for video
  let prevVideoLabel = 'v0';
  let runningDuration = durations[0];

  for (let i = 1; i < n; i++) {
    const transition = cuts[i - 1]?.transition_out || 'fade';
    const outLabel = (i === n - 1) ? 'vout' : `vx${i}`;

    if (transition === 'clean_cut') {
      const offset = Math.max(0, runningDuration - 0.05);
      videoFilters.push(`[${prevVideoLabel}][v${i}]xfade=transition=fade:duration=0.05:offset=${offset.toFixed(3)}[${outLabel}]`);
      runningDuration = runningDuration + durations[i] - 0.05;
    } else {
      const xfadeType = ['fade', 'dissolve', 'wipeleft', 'wiperight', 'smoothleft', 'smoothright'].includes(transition) ? transition : 'fade';
      const offset = Math.max(0, runningDuration - TRANSITION_DURATION);
      videoFilters.push(`[${prevVideoLabel}][v${i}]xfade=transition=${xfadeType}:duration=${TRANSITION_DURATION}:offset=${offset.toFixed(3)}[${outLabel}]`);
      runningDuration = runningDuration + durations[i] - TRANSITION_DURATION;
    }
    prevVideoLabel = outLabel;
  }

  // Step 3: Chain acrossfade for audio
  let prevAudioLabel = 'a0';
  for (let i = 1; i < n; i++) {
    const transition = cuts[i - 1]?.transition_out || 'fade';
    const outLabel = (i === n - 1) ? 'aout' : `ax${i}`;
    const dur = (transition === 'clean_cut') ? 0.05 : TRANSITION_DURATION;
    audioFilters.push(`[${prevAudioLabel}][a${i}]acrossfade=d=${dur}:c1=tri:c2=tri[${outLabel}]`);
    prevAudioLabel = outLabel;
  }

  const filterComplex = [...videoFilters, ...audioFilters].join(';');

  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[vout]', '-map', '[aout]',
    ...encodeArgs(),
    outputPath,
  ];

  console.log(`[ffmpeg] Single-pass render: ${n} clips, ~${runningDuration.toFixed(1)}s output`);
  await runFFmpeg(args);
}

/**
 * Shared encode arguments. Single source of truth for output quality.
 *
 * Key decisions:
 * - CRF 26: Visually transparent for social media. Platforms re-encode anyway.
 *   Half the file size of CRF 20, faster to encode, faster to upload.
 * - veryfast preset: Better size/speed balance on shared CPU.
 * - 1080p cap applied in filter chain (see buildVideoFilterChain).
 */
function encodeArgs() {
  return [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '26',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-r', '30',
    '-movflags', '+faststart',
    '-threads', '0',
  ];
}

/**
 * Build the complete video filter chain string.
 * Includes: 1080p cap -> color grade -> denoise -> sharpen.
 * Returns a comma-separated filter string (not an array).
 */
function buildVideoFilterChain(colorGrade, strategy, sourceRes) {
  const filters = [];

  // 1080p cap — only scale if the SHORT dimension exceeds 1080
  // This correctly handles both landscape (1920x1080) and portrait (1080x1920)
  if (sourceRes) {
    const shortSide = Math.min(sourceRes.width, sourceRes.height);
    if (shortSide > 1080) {
      // Scale so the short side becomes 1080, maintain aspect ratio, ensure even dims
      if (sourceRes.width < sourceRes.height) {
        // Portrait: width is short side
        filters.push('scale=1080:-2');
      } else {
        // Landscape: height is short side
        filters.push('scale=-2:1080');
      }
      console.log(`[ffmpeg] Scaling down: ${sourceRes.width}x${sourceRes.height} (short side ${shortSide}px > 1080px)`);
    } else {
      console.log(`[ffmpeg] No scaling needed: ${sourceRes.width}x${sourceRes.height} (short side ${shortSide}px <= 1080px)`);
    }
  }

  // Color grade (eq filter)
  const rawB = Number.isFinite(colorGrade.brightness) ? colorGrade.brightness : 0;
  const rawC = Number.isFinite(colorGrade.contrast) ? colorGrade.contrast : 1;
  const rawS = Number.isFinite(colorGrade.saturation) ? colorGrade.saturation : 1;
  const rawG = Number.isFinite(colorGrade.gamma) ? colorGrade.gamma : 1;

  const b = Math.max(-0.3, Math.min(0.3, rawB));
  const c = Math.max(0.5, Math.min(2, rawC));
  const s = Math.max(0.5, Math.min(2, rawS));
  const g = Math.max(0.5, Math.min(2, rawG));

  if (rawB !== b || rawC !== c || rawS !== s || rawG !== g) {
    console.warn(
      `[ffmpeg] Color values clamped: brightness ${rawB}→${b}, contrast ${rawC}→${c}, saturation ${rawS}→${s}, gamma ${rawG}→${g}`
    );
  }

  const eqParts = [];
  if (b !== 0) eqParts.push(`brightness=${b}`);
  if (c !== 1) eqParts.push(`contrast=${c}`);
  if (s !== 1) eqParts.push(`saturation=${s}`);
  if (g !== 1) eqParts.push(`gamma=${g}`);
  if (eqParts.length > 0) {
    filters.push(`eq=${eqParts.join(':')}`);
  }

  // Color temperature
  const temp = colorGrade.color_temperature || 'neutral';
  const tempFilter = TEMPERATURE_FILTERS[temp];
  if (tempFilter) {
    filters.push(tempFilter);
  }

  // Sharpening — adaptive based on user request
  const wantsEnhancement = /enhance|quality|sharp|crisp|vivid|polish/i.test(strategy);
  if (wantsEnhancement) {
    filters.push('unsharp=5:5:1.2:5:5:0.0');
    console.log('[ffmpeg] Enhanced quality filters applied');
  } else {
    filters.push('unsharp=5:5:0.7:5:5:0.0');
  }

  const chain = filters.join(',');
  console.log(`[ffmpeg] Filter chain: ${chain}`);
  return chain;
}

/**
 * Find the nearest silence gap (between words) to the target timestamp.
 */
function findNearestSilence(wordTimeline, targetTime) {
  let bestTime = null;
  let bestDistance = Infinity;

  for (let i = 0; i < wordTimeline.length - 1; i++) {
    const currentWordEnd = wordTimeline[i].end;
    const nextWordStart = wordTimeline[i + 1].start;
    const gapDuration = nextWordStart - currentWordEnd;

    // Require at least 150ms of true silence — 30ms is just a micro-pause
    if (gapDuration < 0.15) continue;

    const cutPoint = currentWordEnd + (gapDuration * 0.6);
    const distance = Math.abs(cutPoint - targetTime);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestTime = cutPoint;
    }
  }

  // Also consider cutting right after a word ends, but ONLY if followed by real silence
  for (let i = 0; i < wordTimeline.length - 1; i++) {
    const word = wordTimeline[i];
    const nextWord = wordTimeline[i + 1];
    const gap = nextWord.start - word.end;

    // Only use word-end cuts when there's substantial silence after
    if (gap < 0.15) continue;

    const cutPoint = word.end + 0.08;
    const distance = Math.abs(cutPoint - targetTime);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestTime = cutPoint;
    }
  }

  return bestTime;
}

/**
 * Probe video resolution using ffprobe.
 */
function probeResolution(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'json',
      filePath,
    ], (error, stdout) => {
      if (error) {
        console.warn(`[ffprobe] Resolution probe failed, assuming 1080p: ${error.message}`);
        resolve({ width: 1920, height: 1080 });
        return;
      }
      try {
        const data = JSON.parse(stdout);
        const stream = data.streams?.[0];
        resolve({
          width: stream?.width || 1920,
          height: stream?.height || 1080,
        });
      } catch (e) {
        resolve({ width: 1920, height: 1080 });
      }
    });
  });
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`[ffmpeg] Running: ffmpeg ${args.slice(0, 12).join(' ')}...`);
    const startTime = Date.now();
    execFile('ffmpeg', args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 300_000,
    }, (error, stdout, stderr) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (error) {
        console.error(`[ffmpeg] FAILED after ${elapsed}s`);
        console.error('[ffmpeg] stderr:', stderr?.slice(-800));
        reject(new Error(`FFmpeg failed: ${error.message}`));
      } else {
        console.log(`[ffmpeg] Completed in ${elapsed}s`);
        resolve(stdout);
      }
    });
  });
}

function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const axios = require('axios');
    axios({ method: 'GET', url, responseType: 'stream', timeout: 120_000 })
      .then(response => {
        const writer = fs.createWriteStream(destPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      })
      .catch(reject);
  });
}

async function uploadToSupabase(filePath, userId) {
  const fileSize = fs.statSync(filePath).size;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
  const fileName = `${userId}/${Date.now()}-edited.mp4`;
  const bucket = 'videos';

  console.log(`[upload] Starting upload: ${sizeMB}MB -> ${bucket}/${fileName}`);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error('[upload] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  const uploadUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${fileName}`;
  const fileStream = fs.createReadStream(filePath);

  const startTime = Date.now();

  const response = await axios({
    method: 'POST',
    url: uploadUrl,
    data: fileStream,
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'video/mp4',
      'Content-Length': fileSize,
      'x-upsert': 'true',
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120_000,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[upload] Complete in ${elapsed}s — status ${response.status}`);

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`[upload] Failed with status ${response.status}: ${JSON.stringify(response.data)}`);
  }

  const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${fileName}`;
  console.log(`[upload] Public URL: ${publicUrl}`);
  return publicUrl;
}

module.exports = { renderVideo };

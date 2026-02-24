const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { supabaseAdmin } = require('../../services/supabase-admin');
const { TEMPERATURE_FILTERS } = require('./vibe-presets');

/**
 * Renders an edited video using FFmpeg with color grading and transitions.
 */
async function renderVideo(editPlan, videoUrl, jobId, onProgress, transcript) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `promptly-${jobId}-`));
  let heartbeat = null;
  let heartbeatStep = 'Rendering...';

  try {
    console.log('🎬 Starting FFmpeg render...');
    // Heartbeat to keep job alive during long FFmpeg operations
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
      // Deepgram nested format
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
        // Snap source_start: find the nearest word boundary
        if (cuts[i].source_start > 0) {
          const snapStart = findNearestSilence(wordTimeline, cuts[i].source_start);
          if (snapStart !== null && Math.abs(snapStart - cuts[i].source_start) < 0.5) {
            console.log(`[ffmpeg] Snap clip ${i} start: ${cuts[i].source_start.toFixed(3)} → ${snapStart.toFixed(3)}`);
            cuts[i].source_start = snapStart;
          }
        }

        // Snap source_end: find the nearest word boundary
        if (i < cuts.length - 1) {
          const snapEnd = findNearestSilence(wordTimeline, cuts[i].source_end);
          if (snapEnd !== null && Math.abs(snapEnd - cuts[i].source_end) < 0.5) {
            console.log(`[ffmpeg] Snap clip ${i} end: ${cuts[i].source_end.toFixed(3)} → ${snapEnd.toFixed(3)}`);
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
    
    // Download source video once to local disk
    onProgress?.(63, 'Downloading source video...');
    const sourcePath = path.join(tmpDir, 'source.mp4');
    await downloadToFile(videoUrl, sourcePath);
    console.log(`[ffmpeg] Downloaded source: ${(fs.statSync(sourcePath).size / 1024 / 1024).toFixed(1)}MB`);
    heartbeatStep = 'Trimming and color grading...';

    // === PASS 1: Trim + color grade each clip ===
    onProgress?.(65, 'Trimming and color grading clips...');
    const clipPaths = [];

    // Build the video filter chain for color grading
    const vfFilters = buildColorFilters(colorGrade, editPlan.strategy || '');

    for (let i = 0; i < cuts.length; i++) {
      const cut = cuts[i];
      const clipPath = path.join(tmpDir, `clip_${i}.mp4`);
      const duration = cut.source_end - cut.source_start;

      const args = [
        '-y',
        '-ss', String(cut.source_start),
        '-i', sourcePath,
        '-t', String(duration),
      ];

      // Apply video filters (color grade)
      if (vfFilters.length > 0) {
        args.push('-vf', vfFilters.join(','));
      }

      args.push(
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-r', '30',
        '-movflags', '+faststart',
        '-threads', '2',
        clipPath
      );

      await runFFmpeg(args);
      clipPaths.push(clipPath);
      console.log(`[ffmpeg] Clip ${i + 1}/${cuts.length}: ${cut.source_start.toFixed(1)}s-${cut.source_end.toFixed(1)}s (${duration.toFixed(1)}s)`);
    }
    heartbeatStep = 'Adding transitions...';

    // === PASS 2: Concatenate with transitions ===
    onProgress?.(80, 'Adding transitions...');
    let outputPath;

    if (clipPaths.length === 1) {
      // Single clip — no transitions needed
      outputPath = clipPaths[0];
    } else {
      outputPath = path.join(tmpDir, 'output.mp4');

      // Check if ANY transition is not clean_cut
      const hasTransitions = cuts.some((cut, i) => i < cuts.length - 1 && cut.transition_out && cut.transition_out !== 'clean_cut');

      if (hasTransitions) {
        await concatWithXfade(clipPaths, cuts, outputPath);
      } else {
        // All clean cuts — use simple concat demuxer (faster)
        await concatSimple(clipPaths, tmpDir, outputPath);
      }
    }

    const outputSize = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
    console.log(`[ffmpeg] Output rendered: ${outputSize}MB`);
    heartbeatStep = 'Uploading to storage...';

    // === PASS 3: Upload to Supabase ===
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
 * Build FFmpeg video filter string for color grading.
 */
function buildColorFilters(colorGrade, strategy = '') {
  const filters = [];

  // Clamp to FFmpeg valid ranges
  const b = Math.max(-1, Math.min(1, colorGrade.brightness || 0));
  const c = Math.max(0, Math.min(2, colorGrade.contrast || 1));
  const s = Math.max(0, Math.min(3, colorGrade.saturation || 1));
  const g = Math.max(0.1, Math.min(3, colorGrade.gamma || 1));

  const eqParts = [];
  if (b !== 0) eqParts.push(`brightness=${b}`);
  if (c !== 1) eqParts.push(`contrast=${c}`);
  if (s !== 1) eqParts.push(`saturation=${s}`);
  if (g !== 1) eqParts.push(`gamma=${g}`);
  if (eqParts.length > 0) {
    filters.push(`eq=${eqParts.join(':')}`);
  }

  const temp = colorGrade.color_temperature || 'neutral';
  const tempFilter = TEMPERATURE_FILTERS[temp];
  if (tempFilter) {
    filters.push(tempFilter);
  }

  const wantsEnhancement = /enhance|quality|sharp|crisp|vivid|polish/i.test(strategy);

  // Always denoise — cleans up source, never hurts
  filters.push('hqdn3d=2:1.5:2:3');

  // Sharpening — stronger when client asks for quality enhancement
  if (wantsEnhancement) {
    filters.push('unsharp=5:5:1.2:5:5:0.0');
    console.log('[ffmpeg] Enhanced quality filters applied');
  } else {
    filters.push('unsharp=5:5:0.7:5:5:0.0');
  }

  return filters;
}

/**
 * Find the nearest silence gap (between words) to the target timestamp.
 * Returns the timestamp of the best cut point, or null if no good option.
 */
function findNearestSilence(wordTimeline, targetTime) {
  let bestTime = null;
  let bestDistance = Infinity;

  for (let i = 0; i < wordTimeline.length - 1; i++) {
    const currentWordEnd = wordTimeline[i].end;
    const nextWordStart = wordTimeline[i + 1].start;
    const gapDuration = nextWordStart - currentWordEnd;

    // Only consider gaps that are actual silences (at least 30ms)
    if (gapDuration < 0.03) continue;

    // The ideal cut point is in the middle of the silence gap
    const cutPoint = currentWordEnd + (gapDuration / 2);
    const distance = Math.abs(cutPoint - targetTime);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestTime = cutPoint;
    }
  }

  // Also consider cutting right after the last word ends (for end-of-sentence cuts)
  for (const word of wordTimeline) {
    const distance = Math.abs(word.end - targetTime);
    if (distance < bestDistance) {
      // Only prefer word.end if there's a gap after it
      const wordIndex = wordTimeline.indexOf(word);
      if (wordIndex < wordTimeline.length - 1) {
        const gap = wordTimeline[wordIndex + 1].start - word.end;
        if (gap >= 0.03) {
          bestDistance = distance;
          bestTime = word.end + 0.02; // 20ms after the word ends — safe margin
        }
      }
    }
  }

  return bestTime;
}

/**
 * Concatenate clips with xfade transitions in a SINGLE FFmpeg call.
 * Chains xfade filters: [0][1]xfade→[v01], [v01][2]xfade→[v012], etc.
 * Audio uses acrossfade in parallel.
 */
async function concatWithXfade(clipPaths, cuts, outputPath) {
  const TRANSITION_DURATION = 0.3;

  // Get durations of each clip
  const durations = [];
  for (const clipPath of clipPaths) {
    const dur = await getVideoDuration(clipPath);
    durations.push(dur);
  }

  // Build input args
  const inputArgs = [];
  for (const clipPath of clipPaths) {
    inputArgs.push('-i', clipPath);
  }

  // Build filter_complex string
  const videoFilters = [];
  const audioFilters = [];
  const n = clipPaths.length;

  // Normalize all inputs to same timebase and framerate
  for (let i = 0; i < n; i++) {
    videoFilters.push(`[${i}:v]settb=AVTB,fps=30,format=yuv420p[v${i}]`);
    audioFilters.push(`[${i}:a]asetpts=PTS-STARTPTS[a${i}]`);
  }

  // Chain xfade for video
  let prevVideoLabel = 'v0';
  let runningDuration = durations[0];

  for (let i = 1; i < n; i++) {
    const transition = cuts[i - 1]?.transition_out || 'clean_cut';
    const outLabel = (i === n - 1) ? 'vout' : `vx${i}`;

    if (transition === 'clean_cut') {
      // No xfade, just concat with a null transition (use 0-duration xfade=fade)
      // Actually simpler: chain them with xfade duration=0 acts weird.
      // Instead, use a very short fade (0.05s) which is effectively invisible
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

  // Chain acrossfade for audio
  let prevAudioLabel = 'a0';
  for (let i = 1; i < n; i++) {
    const transition = cuts[i - 1]?.transition_out || 'clean_cut';
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
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    '-threads', '2',
    outputPath
  ];

  await runFFmpeg(args);
}

/**
 * Simple concat using concat demuxer (for all clean_cut transitions).
 */
async function concatSimple(clipPaths, tmpDir, outputPath) {
  const concatListPath = path.join(tmpDir, 'concat.txt');
  const concatContent = clipPaths.map(p => `file '${p}'`).join('\n');
  fs.writeFileSync(concatListPath, concatContent);

  await runFFmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', concatListPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    outputPath
  ]);
}

/**
 * Get video duration using ffprobe.
 */
function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], (error, stdout) => {
      if (error) {
        console.warn(`[ffprobe] Warning: ${error.message}, defaulting to 5s`);
        resolve(5);
      } else {
        resolve(parseFloat(stdout.trim()) || 5);
      }
    });
  });
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`[ffmpeg] Running: ffmpeg ${args.slice(0, 10).join(' ')}...`);
    execFile('ffmpeg', args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 300_000,
    }, (error, stdout, stderr) => {
      if (error) {
        console.error('[ffmpeg] stderr:', stderr?.slice(-500));
        reject(new Error(`FFmpeg failed: ${error.message}`));
      } else {
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

  console.log(`[upload] Starting upload: ${sizeMB}MB → ${bucket}/${fileName}`);

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

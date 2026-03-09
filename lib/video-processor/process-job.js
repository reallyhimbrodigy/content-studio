const { analyzeVideo } = require('./analyze-video');
const { transcribeIfNeeded } = require('./transcribe');
const { generateEdit, expandVibeIntent } = require('./generate-edit');
const { renderVideo, preSplitSourceClips, createKeyframedSource } = require('./render-ffmpeg');
const { supabaseAdmin } = require('../../services/supabase-admin');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { isUserPro } = require('../entitlement');
const { tightenTranscript } = require('./tighten');
const { extractBrollKeywords } = require('./broll-keywords');
const { fetchBrollClip, downloadBrollClip } = require('./broll-fetch');

function gcHint(stage) {
  if (typeof global.gc === 'function') {
    global.gc();
    console.log(`[memory] Forced GC after ${stage}`);
  }
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build speech segments, sentence boundaries, and cut points from Deepgram's
 * word-level timestamps. This replaces Gemini's unreliable speech data with
 * frame-accurate data from the audio transcription.
 */
function buildSpeechFromDeepgram(transcript, duration) {
  const words = transcript?.words || [];
  console.log('[deepgram] Word gaps > 0.1s:',
    words.filter((w, i) => i > 0 && w.start - words[i - 1].end > 0.1)
      .map((w, _, arr) => {
        const i = words.indexOf(w);
        return {
          gap: (w.start - words[i - 1].end).toFixed(3),
          at: w.start.toFixed(3),
          before: words[i - 1].punctuated_word,
          after: w.punctuated_word
        };
      })
  );
  if (!words.length) {
    return {
      speech: { has_speech: false, speaker_style: '', segments: [], sentence_boundaries: [] },
      safeCutPoints: [],
    };
  }

  // Build segments by splitting on sentence-ending punctuation.
  const segments = [];
  const boundaries = [];
  let segStart = words[0].start;
  let segWords = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    segWords.push(w);
    const pw = w.punctuated_word || w.word;
    const isSentenceEnd = /[.!?]$/.test(pw);
    const hasLongPause = (i < words.length - 1) && (words[i + 1].start - w.end > 0.3);
    const isLastWord = i === words.length - 1;

    if (isSentenceEnd || hasLongPause || isLastWord) {
      const segText = segWords.map((sw) => sw.punctuated_word || sw.word).join(' ');
      const segEnd = round3(w.end);

      segments.push({
        start: round3(segStart),
        end: segEnd,
        text: segText,
        emotion: 'informative',
        energy_level: 0.7,
        notes: '',
      });

      if (i < words.length - 1) {
        const nextWord = words[i + 1];
        const pauseAfter = round3(nextWord.start - w.end);
        boundaries.push({
          time: segEnd,
          pause_after: Math.max(0, pauseAfter),
          context: '',
        });
        segStart = nextWord.start;
        segWords = [];
      }
    }
  }

  // Build safe cut points from sentence boundaries.
  const safeCutPoints = [
    { time: 0, quality: 1, why: 'Video start' },
  ];

  for (const b of boundaries) {
    safeCutPoints.push({
      time: b.time,
      quality: b.pause_after > 0.3 ? 0.9 : 0.8,
      why: b.pause_after > 0.3 ? 'sentence end, breath gap' : 'sentence end',
    });
  }

  if (duration) {
    safeCutPoints.push({ time: round3(duration), quality: 1, why: 'Video end' });
  }

  return {
    speech: {
      has_speech: true,
      speaker_style: '',
      segments,
      sentence_boundaries: boundaries,
    },
    safeCutPoints,
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

async function detectSceneCuts(videoPath, threshold = 3) {
  // Run FFmpeg scdet filter — outputs scene change scores per frame.
  // threshold: lower = more sensitive (default 3 catches subtle jump cuts)
  const ffmpegArgs = ['-i', videoPath, '-vf', `scdet=threshold=${threshold}`, '-f', 'null', '-'];
  const output = await new Promise((resolve, reject) => {
    const child = execFile('ffmpeg', ffmpegArgs, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }, (error, _stdout, stderr) => {
      // FFmpeg exits non-zero for null muxer runs in some builds, but stderr still has scdet output.
      if (error && !stderr) {
        console.error('[ffmpeg] PROCESS FAILED:');
        console.error(`[ffmpeg]   Exit code: ${error.code}`);
        console.error(`[ffmpeg]   Signal: ${error.signal}`);
        console.error(`[ffmpeg]   Killed: ${error.killed}`);
        console.error(`[ffmpeg]   stderr (last 500 chars): ${stderr ? stderr.slice(-500) : 'none'}`);
        reject(error);
        return;
      }
      if (error && stderr) {
        console.error('[ffmpeg] PROCESS FAILED (non-fatal for scdet null muxer run):');
        console.error(`[ffmpeg]   Exit code: ${error.code}`);
        console.error(`[ffmpeg]   Signal: ${error.signal}`);
        console.error(`[ffmpeg]   Killed: ${error.killed}`);
        console.error(`[ffmpeg]   stderr (last 500 chars): ${stderr ? stderr.slice(-500) : 'none'}`);
      }
      resolve(stderr || '');
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`[ffmpeg] Process received signal: ${signal} (code: ${code})`);
      }
    });
  });

  const cuts = [];
  const regex = /lavfi\.scd\.time:\s*([\d.]+)/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const time = parseFloat(match[1]);
    if (time > 0.5) { // Ignore cuts in the first 0.5s (often false positives)
      cuts.push(Math.round(time * 1000) / 1000); // Round to 3 decimal places
    }
  }

  console.log(`[scdet] Detected ${cuts.length} visual cuts:`, cuts);
  return cuts;
}

function runFFmpegArgs(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { encoding: 'utf-8', maxBuffer: 25 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve();
    });
  });
}

function parseFps(value) {
  const str = String(value || '').trim();
  if (!str || str === '0/0') return 0;
  if (str.includes('/')) {
    const [n, d] = str.split('/').map(Number);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
    return n / d;
  }
  const n = Number(str);
  return Number.isFinite(n) ? n : 0;
}

async function probeVideo(sourcePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        sourcePath,
      ],
      { encoding: 'utf-8', maxBuffer: 25 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        try {
          const parsed = JSON.parse(stdout || '{}');
          const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
          const video = streams.find((s) => s?.codec_type === 'video');
          const audio = streams.find((s) => s?.codec_type === 'audio');
          if (!video) {
            reject(new Error('No video stream found in uploaded file'));
            return;
          }
          const fps = parseFps(video.avg_frame_rate || video.r_frame_rate);
          const rFps = parseFps(video.r_frame_rate);
          const avgFps = parseFps(video.avg_frame_rate);
          const isVariableFramerate = avgFps > 0 && rFps > 0 && Math.abs(avgFps - rFps) > 0.5;
          resolve({
            width: Number(video.width || 0),
            height: Number(video.height || 0),
            fps,
            codec: String(video.codec_name || ''),
            hasAudio: Boolean(audio),
            isVariableFramerate,
            duration: toNum(parsed?.format?.duration, 0),
          });
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

async function normalizeSourceVideo(sourcePath) {
  const sourceInfo = await probeVideo(sourcePath);
  if (sourceInfo.width > sourceInfo.height) {
    throw new Error('Landscape video reached normalization — this should have been rejected earlier');
  }
  const inputDuration = toNum(sourceInfo.duration, 0);
  console.log(`[normalize] Input duration: ${inputDuration.toFixed(2)}s`);
  const targetWidth = 1080;
  const targetHeight = 1920;
  const targetFps = 30;
  const fpsDelta = Math.abs(toNum(sourceInfo.fps, 0) - targetFps);
  const needsNormalize = (
    sourceInfo.width !== targetWidth
    || sourceInfo.height !== targetHeight
    || fpsDelta > 1
    || sourceInfo.isVariableFramerate
  );

  if (sourceInfo.duration > 0 && sourceInfo.duration < 3) {
    console.warn(`[normalize] Short source (${sourceInfo.duration.toFixed(2)}s) — edit quality may vary`);
  }
  if (sourceInfo.duration > 180) {
    console.warn(`[normalize] Long source (${sourceInfo.duration.toFixed(1)}s) — processing may be slower`);
  }

  if (!needsNormalize) {
    console.log(
      `[normalize] Source is already ${sourceInfo.width}x${sourceInfo.height} @ ${sourceInfo.fps.toFixed(2)}fps — skipping`
    );
    return sourcePath;
  }

  const normalizedPath = path.join(path.dirname(sourcePath), 'normalized_source.mp4');
  console.log(
    `[normalize] Source is ${sourceInfo.width}x${sourceInfo.height} @ ${sourceInfo.fps.toFixed(2)}fps `
    + `(vfr=${sourceInfo.isVariableFramerate}) — converting to 1080x1920 @ 30fps`
  );

  const normalizeArgs = [
    '-y',
    '-i', sourcePath,
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1',
    '-r', '30',
    '-vsync', 'cfr',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '1',
    '-threads', '1',
    '-map', '0:v:0',
  ];

  if (sourceInfo.hasAudio) {
    normalizeArgs.push('-map', '0:a:0');
  } else {
    const silentDuration = Math.max(0.1, inputDuration || 0.1);
    normalizeArgs.splice(2, 0, '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${silentDuration.toFixed(3)}`);
    normalizeArgs.push('-map', '1:a:0');
  }

  normalizeArgs.push(normalizedPath);
  try {
    await runFFmpegArgs(normalizeArgs);
  } catch (err) {
    console.error('[normalize] FFmpeg normalization failed');
    console.error(`[normalize] Args: ffmpeg ${normalizeArgs.join(' ')}`);
    console.error(`[normalize] Error: ${err.message}`);
    throw err;
  }

  const outputInfo = await probeVideo(normalizedPath);
  const outputDuration = toNum(outputInfo.duration, 0);
  console.log(`[normalize] Output duration: ${outputDuration.toFixed(2)}s`);
  if (inputDuration > 0 && outputDuration > 0 && Math.abs(outputDuration - inputDuration) > 1.0) {
    const delta = inputDuration - outputDuration;
    console.error(
      `[normalize] ERROR: Duration changed by ${delta.toFixed(2)}s during normalization! `
      + `Input: ${inputDuration.toFixed(2)}s, Output: ${outputDuration.toFixed(2)}s`
    );
    throw new Error(
      `Normalization truncated video from ${inputDuration.toFixed(1)}s to ${outputDuration.toFixed(1)}s`
    );
  }

  try {
    if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
  } catch (e) {
    console.warn(`[normalize] Failed to remove original source: ${e.message}`);
  }
  fs.renameSync(normalizedPath, sourcePath);
  console.log('[normalize] Done');
  return sourcePath;
}

async function extractSceneFrames(sourcePath, timestamps, tmpDir) {
  const frames = [];
  const seen = new Set();
  const orderedTimestamps = [0.1, ...(Array.isArray(timestamps) ? timestamps : [])]
    .map((t) => round3(Math.max(0, Number(t) || 0)))
    .filter((t) => Number.isFinite(t));

  for (const timestamp of orderedTimestamps) {
    const key = timestamp.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);

    const framePath = path.join(tmpDir, `scene_frame_${key.replace('.', '_')}.jpg`);
    const args = [
      '-y',
      '-ss', String(timestamp),
      '-i', sourcePath,
      '-frames:v', '1',
      '-vf', 'scale=512:-1',
      '-q:v', '8',
      framePath,
    ];

    try {
      await runFFmpegArgs(args);
      const buffer = fs.readFileSync(framePath);
      frames.push({
        timestamp,
        base64: buffer.toString('base64'),
        mediaType: 'image/jpeg',
      });
    } catch (e) {
      console.warn(`[frames] Failed extracting frame at ${timestamp.toFixed(3)}s: ${e.message}`);
    } finally {
      try {
        if (fs.existsSync(framePath)) fs.unlinkSync(framePath);
      } catch (_) {
        // ignore cleanup errors
      }
    }
  }

  console.log(`[frames] Extracted ${frames.length} scene frame thumbnails`);
  return frames;
}

async function preDownloadVideoToDir(videoUrl, targetDir) {
  const sourcePath = path.join(targetDir, 'source.mp4');

  let response = await axios({
    method: 'GET',
    url: videoUrl,
    responseType: 'stream',
    timeout: 120_000,
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(sourcePath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  const sizeMB = (fs.statSync(sourcePath).size / 1024 / 1024).toFixed(1);
  console.log(`[process-job] Pre-downloaded source: ${sizeMB}MB -> ${sourcePath}`);
  response.data = null;
  response = null;

  return sourcePath;
}

function cleanupTmpDir(tmpDir) {
  if (!tmpDir) return;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`[cleanup] Removed ${tmpDir}`);
  } catch (e) {
    console.warn(`[cleanup] Failed to remove ${tmpDir}: ${e.message}`);
  }
}

async function processVideoJob({ videoUrl, vibeInput, jobId, userId, onProgress }) {
  console.log('\n' + '='.repeat(80));
  console.log(`🚀 JOB ${jobId}: "${vibeInput}"`);
  console.log('='.repeat(80));

  let preDownloadedPath = null;
  let brollTmpDir = null;
  let sceneFramesPromise = null;
  const jobTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `promptly-job-${jobId}-`));

  try {
    console.log('[pipeline] Starting source pre-download...');
    const downloadedSourcePath = await withTimeout(
      preDownloadVideoToDir(videoUrl, jobTmpDir),
      180_000,
      'Source pre-download'
    );
    console.log('[pipeline] Source pre-download complete');
    preDownloadedPath = downloadedSourcePath;
    const sourceInfo = await probeVideo(downloadedSourcePath);
    if (sourceInfo.width > sourceInfo.height) {
      throw new Error(
        `This video is in landscape format (${sourceInfo.width}x${sourceInfo.height}). `
        + 'Promptly currently supports vertical (9:16) and square (1:1) videos for TikTok, Reels, and Shorts. '
        + 'Please upload a vertical video or re-record in portrait mode.'
      );
    }
    const downloadPromise = Promise.resolve(downloadedSourcePath);

    const normalizedSourcePromise = (async () => {
      const localPath = await downloadPromise;
      return normalizeSourceVideo(localPath);
    })();
    const audioExtractionPromise = (async () => {
      const localPath = await downloadPromise;
      const audioPath = path.join(path.dirname(localPath), 'audio.wav');
      await runFFmpegArgs([
        '-y',
        '-i', localPath,
        '-vn',
        '-acodec', 'pcm_s16le',
        '-ar', '16000',
        '-ac', '1',
        '-threads', '1',
        audioPath,
      ]);
      console.log(`[audio] Extracted audio: ${(fs.statSync(audioPath).size / 1024 / 1024).toFixed(1)}MB WAV`);
      return audioPath;
    })();

    const scdetPromise = (async () => {
      console.log('[pipeline] Starting scene detection...');
      try {
        const localPath = await downloadPromise;
        const cuts = await withTimeout(
          detectSceneCuts(localPath),
          120_000,
          'Scene detection'
        );
        console.log(`[pipeline] Scene detection complete (${cuts.length} cuts)`);
        return cuts;
      } catch (err) {
        console.error('[pipeline] FAILED at scene detection:', err.message, err.stack);
        throw err;
      }
    })();
    sceneFramesPromise = (async () => {
      const [localPath, cuts] = await Promise.all([downloadPromise, scdetPromise]);
      return extractSceneFrames(localPath, cuts, path.dirname(localPath));
    })();

    const analysisPromise = (async () => {
      console.log('[pipeline] Starting Gemini analysis call...');
      try {
        const analysisResult = await withTimeout(
          analyzeVideo(videoUrl, onProgress),
          240_000,
          'Gemini analysis'
        );
        console.log(
          '[pipeline] Gemini analysis complete, response size:',
          JSON.stringify(analysisResult || {}).length
        );
        return analysisResult;
      } catch (err) {
        console.error('[pipeline] FAILED at Gemini analysis:', err.message, err.stack);
        throw err;
      }
    })();

    const transcriptPromise = (async () => {
      console.log('[pipeline] Starting transcription...');
      let audioPath = null;
      try {
        audioPath = await audioExtractionPromise;
        const transcriptResult = await withTimeout(
          transcribeIfNeeded(audioPath, null, onProgress),
          240_000,
          'Transcription'
        );
        console.log(
          `[pipeline] Transcription complete (${transcriptResult?.words?.length || 0} words)`
        );
        return transcriptResult;
      } catch (err) {
        console.error('[pipeline] FAILED at transcription:', err.message, err.stack);
        throw err;
      } finally {
        if (audioPath) {
          try {
            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
          } catch (_) {
            // ignore audio cleanup errors
          }
        }
      }
    })();

    const expandedVibePromise = (async () => {
      console.log('[pipeline] Starting vibe expansion...');
      try {
        const expanded = await withTimeout(
          expandVibeIntent(vibeInput),
          120_000,
          'Vibe expansion'
        );
        console.log('[pipeline] Vibe expansion complete');
        return expanded;
      } catch (err) {
        console.error('[pipeline] FAILED at vibe expansion:', err.message, err.stack);
        throw err;
      }
    })();

    // Stage 1 + 2: Run Gemini, Deepgram, source download, scdet, and vibe expansion in parallel.
    const [analysis, transcript, downloadedPath, visualCuts, expandedVibe] = await Promise.all([
      analysisPromise,
      transcriptPromise,
      normalizedSourcePromise,
      scdetPromise,
      expandedVibePromise,
    ]);
    preDownloadedPath = downloadedPath;
    console.log(`[process-job] FFmpeg detected ${visualCuts.length} visual cuts`);
    analysis.visual_cuts = Array.isArray(visualCuts) ? visualCuts : [];
    gcHint('transcription and analysis');

    // Build speech data from Deepgram (accurate) instead of Gemini (unreliable).
    console.log('[pipeline] Starting tighten step...');
    let { speech, safeCutPoints } = buildSpeechFromDeepgram(transcript, analysis.duration);
    analysis.speech = speech;
    const deepgramWords = Array.isArray(transcript?.words) ? transcript.words : [];
    const tightenResult = tightenTranscript(deepgramWords, {
      sceneCuts: visualCuts,
      shots: Array.isArray(analysis?.shots) ? analysis.shots : [],
      originalDuration: toNum(analysis?.duration, 0),
    });
    console.log('[pipeline] Tighten step complete');
    analysis.tightened_timeline = tightenResult;
    if (Array.isArray(tightenResult.timeline_map) && tightenResult.timeline_map.length > 0) {
      analysis.tightened_duration = tightenResult.tightened_duration;
      analysis.safe_cut_points_tightened = [
        { time: 0, quality: 1, why: 'Tightened start' },
        ...tightenResult.timeline_map.map((m) => ({
          time: round3(m.tightened_end),
          quality: 0.95,
          why: 'tightened segment end',
        })),
      ];
    }
    let tightenApplied = false;
    if (tightenResult.removedSeconds >= 0.1 && Array.isArray(tightenResult.segments) && tightenResult.segments.length > 0) {
      const tightenCutPoints = [{ time: 0, quality: 1, why: 'Video start' }];
      for (const seg of tightenResult.segments) {
        tightenCutPoints.push({ time: round3(seg.end), quality: 0.95, why: 'tightened segment end (source)' });
      }
      if (analysis.duration) {
        tightenCutPoints.push({ time: round3(analysis.duration), quality: 1, why: 'Video end' });
      }
      safeCutPoints = tightenCutPoints;
      tightenApplied = true;
      console.log(`[tighten] Applying tightened timeline (${tightenResult.removedSeconds.toFixed(1)}s removed)`);
    } else {
      console.log('[tighten] Video is already tight, using original timeline');
    }

    // Add visual cut points from FFmpeg scdet (frame-accurate)
    if (!tightenApplied) {
      for (const cutTime of visualCuts) {
        const alreadyExists = safeCutPoints.some((cp) => Math.abs(cp.time - cutTime) < 0.5);
        if (!alreadyExists) {
          safeCutPoints.push({
            time: cutTime,
            quality: 1.0,
            why: 'scene change',
          });
        }
      }
    }

    // Deduplicate cut points that are within 1 second of each other.
    // Keep the Deepgram sentence boundary over the Gemini scene change
    // because Deepgram has more precise timing from word-level audio.
    safeCutPoints.sort((a, b) => a.time - b.time);
    const deduped = [];
    for (const cp of safeCutPoints) {
      if (deduped.length === 0) {
        deduped.push(cp);
        continue;
      }
      const prev = deduped[deduped.length - 1];
      if (cp.time - prev.time < 1.0) {
        // Prefer speech-based cut points (more precise) over visual scene changes
        const prevIsSpeech = prev.why.includes('sentence') || prev.why.includes('breath');
        const cpIsSpeech = cp.why.includes('sentence') || cp.why.includes('breath');
        if (cpIsSpeech && !prevIsSpeech) {
          deduped[deduped.length - 1] = cp;
        }
        // Otherwise keep prev
      } else {
        deduped.push(cp);
      }
    }
    safeCutPoints = deduped;
    if (safeCutPoints.length === 0 || toNum(safeCutPoints[0]?.time, 999) > 0.5) {
      safeCutPoints.unshift({ time: 0, quality: 1, why: 'Video start' });
    }
    const videoDuration = toNum(analysis?.duration, 0);
    if (videoDuration > 0) {
      const lastTime = safeCutPoints.length > 0 ? toNum(safeCutPoints[safeCutPoints.length - 1]?.time, 0) : 0;
      if (lastTime < videoDuration - 0.5) {
        safeCutPoints.push({ time: round3(videoDuration), quality: 1, why: 'Video end' });
      }
    }
    analysis.safe_cut_points = safeCutPoints;

    // Map Gemini shot descriptions to scdet-detected cuts
    // scdet gives us exact boundaries, Gemini gives us descriptions
    const shotBoundaries = [0, ...visualCuts, analysis.duration];
    const mappedShots = [];

    for (let i = 0; i < shotBoundaries.length - 1; i++) {
      const start = round3(shotBoundaries[i]);
      const end = round3(shotBoundaries[i + 1]);

      // Find the Gemini shot description that best matches this segment
      // Use the one whose description index is closest to this segment's position
      const geminiShot = analysis.shots && analysis.shots[Math.min(i, analysis.shots.length - 1)];

      mappedShots.push({
        start: start,
        end: end,
        visual: geminiShot?.visual || '',
        action: geminiShot?.action || '',
        energy: geminiShot?.energy || 0.5,
        editing_value: geminiShot?.editing_value || 'usable',
        description: geminiShot?.description || '',
        score: geminiShot?.score || 0.5,
      });
    }

    analysis.shots = mappedShots;

    // Remove recommended_duration if Gemini included it.
    if (analysis.video_profile?.recommended_duration) {
      delete analysis.video_profile.recommended_duration;
    }
    if (analysis.footage_assessment?.recommended_duration) {
      delete analysis.footage_assessment.recommended_duration;
    }

    console.log(`[process-job] Gemini analysis:\n${JSON.stringify(analysis, null, 2)}`);
    console.log('[pipeline] Persisting analysis_data to Supabase (non-blocking)...');
    supabaseAdmin
      .from('video_jobs')
      .update({ analysis_data: analysis })
      .eq('id', jobId)
      .then(() => console.log('[pipeline] analysis_data persisted'))
      .catch(err => console.error('[pipeline] analysis_data persist failed:', err.message));
    gcHint('analysis persistence');

    // Stage 3: AI creative direction (Claude)
    const brollCandidates = extractBrollKeywords(deepgramWords, 8);
    if (Array.isArray(brollCandidates) && brollCandidates.length > 0) {
      analysis.broll_candidates = brollCandidates.map((a) => ({
        keyword: a.keyword,
        timestamp: a.timestamp,
      }));
      console.log(`[broll] Candidates for Claude context: ${analysis.broll_candidates.map((a) => a.keyword).join(', ')}`);
    }

    console.log('[pipeline] Starting Claude edit recipe call...');
    const sceneFrames = await sceneFramesPromise.catch((err) => {
      console.warn(`[frames] Scene frame extraction failed: ${err.message}`);
      return [];
    });
    const editPlan = await withTimeout(
      generateEdit(analysis, transcript, vibeInput, onProgress, expandedVibe, sceneFrames),
      240_000,
      'Claude edit recipe generation'
    );
    console.log('[pipeline] Claude edit recipe complete');
    gcHint('edit generation');

    // Run b-roll download and clip pre-split in parallel. They are independent
    // and both depend only on Claude's edit output + the source on disk.
    const brollRequests = Array.isArray(editPlan.broll) ? editPlan.broll.slice(0, 3) : [];
    const brollDownloadPromise = (async () => {
      const brollAssets = [];
      if (brollRequests.length > 0) {
        brollTmpDir = path.join(jobTmpDir, 'broll');
        fs.mkdirSync(brollTmpDir, { recursive: true });
        for (let i = 0; i < brollRequests.length; i++) {
          const req = brollRequests[i] || {};
          const keyword = String(req.keyword || '').trim();
          if (!keyword) continue;
          try {
            const clipInfo = await fetchBrollClip(keyword);
            if (!clipInfo) continue;
            const localPath = path.join(brollTmpDir, `broll_${i}.mp4`);
            await downloadBrollClip(clipInfo, localPath, Number(req.duration || 1.5));
            brollAssets.push({
              keyword,
              timestamp: Number(req.timestamp || 0),
              duration: Math.max(1, Math.min(3, Number(req.duration || 1.5))),
              localPath,
              width: clipInfo.width,
              height: clipInfo.height,
            });
          } catch (e) {
            console.log(`[broll] Failed to fetch "${keyword}": ${e.message}`);
          }
        }
        console.log(`[broll] Downloaded from Claude keywords: ${brollAssets.map((a) => a.keyword).join(', ') || 'none'}`);
      }
      return brollAssets;
    })();
    const preSplitPromise = (async () => {
      const cutList = Array.isArray(editPlan.cuts) ? editPlan.cuts : [];
      const keyframeTimestamps = cutList
        .flatMap((cut) => [Number(cut?.source_start || 0), Number(cut?.source_end || 0)])
        .filter((t) => Number.isFinite(t) && t >= 0);
      console.log(`[pipeline] Forcing keyframes at ${keyframeTimestamps.length} cut boundary timestamps from Claude cuts`);
      const keyframedPath = await createKeyframedSource(
        preDownloadedPath,
        keyframeTimestamps,
        path.dirname(preDownloadedPath)
      );
      return preSplitSourceClips(
        keyframedPath,
        cutList,
        path.dirname(preDownloadedPath)
      );
    })();
    const [brollAssets, preSplitClipFiles] = await Promise.all([brollDownloadPromise, preSplitPromise]);
    if (preDownloadedPath && fs.existsSync(preDownloadedPath)) {
      fs.unlinkSync(preDownloadedPath);
      console.log('[memory] Deleted source file after pre-split');
    }
    editPlan.broll_assets = brollAssets;
    gcHint('b-roll download');

    // Stage 4 + 5: Render with FFmpeg and upload to Supabase
    // Pass the pre-downloaded source path so renderVideo skips its own download
    let addWatermark = true;
    const hasBurnedCaptions = analysis?.frame_layout?.existing_overlays?.has_burned_captions === true;
    if (userId) {
      const { data: profile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
      if (profileError) {
        console.error('[watermark] Profile lookup failed:', profileError.message);
      }
      const isPro = isUserPro(profile);
      addWatermark = !isPro;
      console.log(`[watermark] user=${userId} isPro=${isPro} addWatermark=${addWatermark}`);
    }

    const finalVideoUrl = await renderVideo(
      editPlan,
      videoUrl,
      jobId,
      onProgress,
      transcript,
      preDownloadedPath,
      analysis.speech?.segments || [],
      addWatermark,
      hasBurnedCaptions,
      preSplitClipFiles
    );

    console.log('='.repeat(80));
    console.log(`✅ JOB ${jobId} COMPLETE`);
    console.log(`📹 Output: ${finalVideoUrl}`);
    console.log('='.repeat(80) + '\n');

    return {
      rendered_video_url: finalVideoUrl,
      edit_recipe: editPlan,
      metadata: {
        duration: analysis.duration,
        shots_analyzed: analysis.shots.length,
        has_speech: transcript.text.length > 0
      }
    };

  } catch (error) {
    console.error('='.repeat(80));
    console.error(`❌ JOB ${jobId} FAILED`);
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('='.repeat(80) + '\n');
    throw error;
  } finally {
    cleanupTmpDir(jobTmpDir);
  }
}

module.exports = { processVideoJob };

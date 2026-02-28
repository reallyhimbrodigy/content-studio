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
async function renderVideo(editPlan, videoUrl, jobId, onProgress, transcript, preDownloadedPath, speechSegments = [], addWatermark = false, hasBurnedCaptions = false) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `promptly-${jobId}-`));
  let heartbeat = null;
  let heartbeatStep = 'Rendering...';

  try {
    console.log('🎬 Starting single-pass FFmpeg render...');
    heartbeat = setInterval(() => {
      onProgress?.(null, heartbeatStep);
    }, 30_000);

    const cuts = editPlan.cuts;

    // Close small gaps between clips to prevent audio dropouts
    for (let i = 0; i < cuts.length - 1; i++) {
      const gap = cuts[i + 1].source_start - cuts[i].source_end;
      if (gap > 0 && gap < 1.0) {
        console.log(`[ffmpeg] Closing ${gap.toFixed(2)}s gap between clip ${i} and ${i + 1}`);
        cuts[i].source_end = cuts[i + 1].source_start;
      }
    }

    // Round all cut boundaries to millisecond precision for stable ffmpeg args
    for (let i = 0; i < cuts.length; i++) {
      if (typeof cuts[i].source_start === 'number') cuts[i].source_start = roundMs(cuts[i].source_start);
      if (typeof cuts[i].source_end === 'number') cuts[i].source_end = roundMs(cuts[i].source_end);
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

    const outputRes = getOutputDimensions(editPlan.aspect_ratio || 'original', sourceRes);

    // Render
    heartbeatStep = 'Rendering video...';
    onProgress?.(68, 'Rendering video...');

    const finalOutputPath = path.join(tmpDir, 'output.mp4');
    await renderMultiClip(
      sourcePath,
      cuts,
      colorGrade,
      editPlan.strategy || '',
      sourceRes,
      outputRes,
      editPlan,
      finalOutputPath,
      transcript,
      speechSegments,
      tmpDir,
      addWatermark,
      hasBurnedCaptions
    );

    const outputSize = (fs.statSync(finalOutputPath).size / 1024 / 1024).toFixed(1);
    console.log(`[ffmpeg] Output rendered: ${outputSize}MB`);

    // Upload
    heartbeatStep = 'Uploading to storage...';
    onProgress?.(90, 'Uploading...');
    const publicUrl = await uploadToSupabase(finalOutputPath, jobId);
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
async function renderSingleClip(sourcePath, cut, colorGrade, strategy, sourceRes, outputRes, editPlan, outputPath, hasBurnedCaptionsOverride = null) {
  const start = roundMs(cut.source_start);
  const sourceDuration = roundMs(cut.source_end - cut.source_start);
  const speed = Number.isFinite(cut.speed) ? cut.speed : 1.0;
  const effectiveDuration = roundMs(sourceDuration / speed);
  const vfFilters = buildVideoFilterChain(colorGrade, strategy, sourceRes);
  const aspectFilter = getAspectRatioFilter(editPlan.aspect_ratio || 'original', sourceRes.width, sourceRes.height);
  const speedFilters = getSpeedFilters(speed);
  const hasBurnedCaptions = hasBurnedCaptionsOverride != null
    ? hasBurnedCaptionsOverride
    : editPlan.analysis_data?.frame_layout?.existing_overlays?.has_burned_captions === true;
  const effectiveZoom = hasBurnedCaptions ? 'none' : (cut.zoom || 'none');
  if (hasBurnedCaptions && cut.zoom && cut.zoom !== 'none') {
    console.log(`[ffmpeg] Skipping zoom "${cut.zoom}" on clip 0 — video has burned-in captions`);
  }
  const zoomFilter = getZoomFilter(effectiveZoom, effectiveDuration, outputRes.width || sourceRes.width || 1080, outputRes.height || sourceRes.height || 1920);
  const vignetteFilter = getVignetteFilter(editPlan.vignette || 'none');
  const videoChain = [];
  if (aspectFilter) videoChain.push(aspectFilter);
  if (speedFilters.video) videoChain.push(speedFilters.video);
  if (zoomFilter) videoChain.push(zoomFilter);
  videoChain.push('format=yuv420p');
  videoChain.push(vfFilters);
  if (vignetteFilter) videoChain.push(vignetteFilter);
  if (editPlan.outro && editPlan.outro !== 'none') {
    const fadeColor = editPlan.outro === 'fade_white' ? 'white' : 'black';
    const fadeDuration = 1.0;
    const fadeStart = Math.max(0, effectiveDuration - fadeDuration);
    videoChain.push(`fade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeDuration}:color=${fadeColor}`);
  }
  const fullVf = videoChain.join(',');
  const afilters = [];
  // Always apply noise reduction to source audio
  afilters.push('afftdn=nr=10:nf=-25');
  if (speedFilters.audio) afilters.push(speedFilters.audio);
  if (editPlan.outro && editPlan.outro !== 'none') {
    const fadeDuration = 1.0;
    const fadeStart = Math.max(0, effectiveDuration - fadeDuration);
    afilters.push(`afade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeDuration}`);
  }

  const args = [
    '-y',
    '-analyzeduration', '5000000',
    '-probesize', '5000000',
    '-ss', String(start),
    '-i', sourcePath,
    '-t', String(sourceDuration),
    '-vf', fullVf,
    ...(afilters.length > 0 ? ['-af', afilters.join(',')] : []),
    ...encodeArgs(),
    outputPath,
  ];

  console.log(`[ffmpeg] Single clip: ${start.toFixed(1)}s -> ${cut.source_end.toFixed(1)}s (${effectiveDuration.toFixed(1)}s @ ${speed}x)`);
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
async function renderMultiClip(sourcePath, cuts, colorGrade, strategy, sourceRes, outputRes, editPlan, outputPath, transcript, speechSegments, tmpDir, addWatermark = false, hasBurnedCaptionsOverride = null) {
  const TRANSITION_DURATION = 0.3;
  const n = cuts.length;
  const inputArgs = [];
  const sourceDurations = [];
  const effectiveDurations = [];

  for (let i = 0; i < n; i++) {
    const cut = cuts[i];
    const start = roundMs(cut.source_start);
    const sourceDuration = roundMs(cut.source_end - cut.source_start);
    const speed = Number.isFinite(cut.speed) ? cut.speed : 1.0;
    const effectiveDuration = roundMs(sourceDuration / speed);
    inputArgs.push(
      '-analyzeduration', '5000000',
      '-probesize', '5000000',
      '-ss', String(start),
      '-t', String(sourceDuration),
      '-i', sourcePath
    );
    sourceDurations.push(sourceDuration);
    effectiveDurations.push(effectiveDuration);
    console.log(`[ffmpeg] Input ${i}: ${start.toFixed(1)}s -> ${cut.source_end.toFixed(1)}s (${effectiveDuration.toFixed(1)}s @ ${speed}x)`);
  }

  // Extra media inputs (music/sfx) for same-pass enhancements
  const enhancementInputArgs = [];
  const enhancementFilters = [];
  let extraInputIndex = n;
  let bgMusicLabel = null;
  const sfxAudioLabels = [];

  const bgMusic = editPlan.background_music || 'none';
  if (bgMusic !== 'none') {
    const musicPath = path.join(process.cwd(), 'assets', 'music', `${bgMusic}.mp3`);
    if (fs.existsSync(musicPath)) {
      enhancementInputArgs.push('-stream_loop', '-1', '-i', musicPath);
      enhancementFilters.push(`[${extraInputIndex}:a]volume=0.30[bgm]`);
      bgMusicLabel = '[bgm]';
      extraInputIndex++;
    } else {
      console.log(`[ffmpeg] Background music missing, skipping: ${musicPath}`);
    }
  }

  const transitionTimes = getTransitionTimes(cuts);
  const speechSegmentsForVolume = editPlan.analysis_data?.speech?.segments || speechSegments || [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const sound = cuts[i]?.transition_sound;
    if (!sound || sound === 'none') continue;
    const soundsDir = path.join(process.cwd(), 'src', 'assets', 'sounds');
    const soundPath = getSoundPath(sound, soundsDir);
    if (!soundPath) continue;
    enhancementInputArgs.push('-i', soundPath);
    const offsetMs = Math.max(0, Math.round((transitionTimes[i] || 0) * 1000));
    const transitionTime = cuts[i].source_end;
    const vol = getTransitionVolume(sound, transitionTime, speechSegmentsForVolume);
    const label = `[snd${i}]`;
    enhancementFilters.push(`[${extraInputIndex}:a]volume=${vol.toFixed(3)},adelay=${offsetMs}|${offsetMs}${label}`);
    sfxAudioLabels.push(label);
    extraInputIndex++;
  }

  // === Build filter_complex ===
  const colorFilterStr = buildVideoFilterChain(colorGrade, strategy, sourceRes);
  const videoFilters = [];
  const audioFilters = [];
  // Step 1: Per-input filters (multi-input mode: [N:v]/[N:a])
  for (let i = 0; i < n; i++) {
    const aspectFilter = getAspectRatioFilter(editPlan.aspect_ratio || 'original', sourceRes.width, sourceRes.height);
    const speed = Number.isFinite(cuts[i]?.speed) ? cuts[i].speed : 1.0;
    const speedFilters = getSpeedFilters(speed);
    const hasBurnedCaptions = hasBurnedCaptionsOverride != null
      ? hasBurnedCaptionsOverride
      : editPlan.analysis_data?.frame_layout?.existing_overlays?.has_burned_captions === true;
    const effectiveZoom = hasBurnedCaptions ? 'none' : (cuts[i]?.zoom || 'none');
    if (hasBurnedCaptions && cuts[i]?.zoom && cuts[i].zoom !== 'none') {
      console.log(`[ffmpeg] Skipping zoom "${cuts[i].zoom}" on clip ${i} — video has burned-in captions`);
    }
    const zoomFilter = getZoomFilter(
      effectiveZoom,
      effectiveDurations[i],
      outputRes.width || sourceRes.width || 1080,
      outputRes.height || sourceRes.height || 1920
    );
    const vignetteFilter = getVignetteFilter(editPlan.vignette || 'none');
    const vChain = ['settb=AVTB'];
    if (aspectFilter) vChain.push(aspectFilter);
    if (speedFilters.video) vChain.push(speedFilters.video);
    if (zoomFilter) vChain.push(zoomFilter);
    vChain.push('fps=30', 'format=yuv420p', colorFilterStr);
    if (vignetteFilter) vChain.push(vignetteFilter);
    if (i === n - 1 && editPlan.outro && editPlan.outro !== 'none') {
      const fadeDuration = 1.0;
      const fadeStart = Math.max(0, effectiveDurations[i] - fadeDuration);
      const fadeColor = editPlan.outro === 'fade_white' ? 'white' : 'black';
      vChain.push(`fade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeDuration}:color=${fadeColor}`);
    }
    videoFilters.push(`[${i}:v]${vChain.join(',')}[v${i}]`);

    const aChain = [
      'asetpts=PTS-STARTPTS',
      'afftdn=nr=10:nf=-25',
    ];
    if (speedFilters.audio) aChain.push(speedFilters.audio);
    if (i === n - 1 && editPlan.outro && editPlan.outro !== 'none') {
      const fadeDuration = 1.0;
      const fadeStart = Math.max(0, effectiveDurations[i] - fadeDuration);
      aChain.push(`afade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeDuration}`);
    }
    audioFilters.push(`[${i}:a]${aChain.join(',')}[a${i}]`);
  }

  // Step 2: Chain transitions
  // - clean_cut uses true hard concat (no blend)
  // - all other transition types are passed through directly to xfade
  let timelineVideoLabel = 'v0';
  let timelineAudioLabel = 'a0';
  let runningDuration = effectiveDurations[0];
  const transitionFilters = [];

  for (let i = 1; i < n; i++) {
    const transition = cuts[i - 1]?.transition_out || 'clean_cut';
    const outVideoLabel = (i === n - 1) ? 'vout' : `vx${i}`;
    const outAudioLabel = (i === n - 1) ? 'aout' : `ax${i}`;

    if (transition !== 'clean_cut') {
      const offset = Math.max(0, runningDuration - TRANSITION_DURATION);
      transitionFilters.push(
        `[${timelineVideoLabel}][v${i}]xfade=transition=${transition}:duration=${TRANSITION_DURATION}:offset=${offset.toFixed(3)}[${outVideoLabel}]`
      );
      transitionFilters.push(
        `[${timelineAudioLabel}][a${i}]acrossfade=d=${TRANSITION_DURATION}:c1=tri:c2=tri[${outAudioLabel}]`
      );
      runningDuration = runningDuration + effectiveDurations[i] - TRANSITION_DURATION;
    } else {
      // True hard cut: direct concat with no blend
      const concatVideoLabel = `${outVideoLabel}_raw`;
      transitionFilters.push(
        `[${timelineVideoLabel}][${timelineAudioLabel}][v${i}][a${i}]concat=n=2:v=1:a=1[${concatVideoLabel}][${outAudioLabel}]`
      );
      // Concat resets timebase to container-native values (e.g., 1/1000000).
      // Normalize back to AVTB/fps=30 so subsequent xfade inputs match.
      transitionFilters.push(
        `[${concatVideoLabel}]settb=AVTB,fps=30,format=yuv420p[${outVideoLabel}]`
      );
      runningDuration = runningDuration + effectiveDurations[i];
    }

    timelineVideoLabel = outVideoLabel;
    timelineAudioLabel = outAudioLabel;
  }

  // For n=1 there are no transition filters; use normalized stream labels directly
  if (n === 1) {
    timelineVideoLabel = 'v0';
    timelineAudioLabel = 'a0';
  }

  // Step 3: Post enhancements in the same filter graph (captions/overlays/music/sfx/loudnorm)
  const postFilters = [];
  let videoOut = '[video_base]';
  postFilters.push(`[${timelineVideoLabel}]null${videoOut}`);

  const captionStyle = editPlan.caption_style || 'none';
  if (captionStyle !== 'none') {
    const assPath = path.join(tmpDir, 'captions.ass');
    const generated = generateSubtitleFile(
      transcript,
      captionStyle,
      cuts,
      outputRes,
      assPath,
      editPlan.caption_position || 'lower-third',
      editPlan.aspect_ratio || '9:16',
      editPlan.caption_keywords || []
    );
    if (generated) {
      const escaped = escapeFilterPath(generated);
      postFilters.push(`${videoOut}subtitles='${escaped}'[video_captioned]`);
      videoOut = '[video_captioned]';
    } else {
      console.log('[ffmpeg] No transcript words for captions; skipping caption burn-in');
    }
  }

  const hasTextOverlays = Array.isArray(editPlan.text_overlays) && editPlan.text_overlays.length > 0;
  if (hasTextOverlays) {
    const overlayAssPath = path.join(tmpDir, 'text-overlays.ass');
    const generatedOverlay = generateTextOverlays(editPlan.text_overlays, cuts, outputRes, overlayAssPath);
    if (generatedOverlay) {
      const escaped = escapeFilterPath(generatedOverlay);
      postFilters.push(`${videoOut}subtitles='${escaped}'[video_overlayed]`);
      videoOut = '[video_overlayed]';
    } else {
      console.log('[ffmpeg] No valid text overlays found; skipping overlay burn-in');
    }
  }

  if (addWatermark) {
    // PNG overlay watermark — bottom-right, always visible above platform UI
    const watermarkPath = path.join(process.cwd(), 'src', 'assets', 'watermark.png');
    if (fs.existsSync(watermarkPath)) {
      const escapedPath = watermarkPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      postFilters.push(`movie='${escapedPath}',colorchannelmixer=aa=0.6[wm_img]`);
      postFilters.push(`${videoOut}[wm_img]overlay=x=(W-w-20):y=(H-340)[video_watermarked]`);
      videoOut = '[video_watermarked]';
      console.log('[ffmpeg] Watermark PNG overlay applied (bottom-right, above platform UI)');
    } else {
      console.log(`[ffmpeg] Watermark PNG missing, skipping overlay: ${watermarkPath}`);
    }
  }

  let audioOut = '[audio_main]';
  postFilters.push(`[${timelineAudioLabel}]volume=1${audioOut}`);

  if (bgMusicLabel) {
    if (editPlan.audio_ducking) {
      const enableExpr = buildDuckingVolumeEnable(speechSegments, 0.2);
      if (enableExpr) {
        postFilters.push(`${bgMusicLabel}volume=0.10:enable='${enableExpr}'[bgm_ducked]`);
        postFilters.push(`${audioOut}[bgm_ducked]amix=inputs=2:duration=first:dropout_transition=2[audio_mixed]`);
      } else {
        postFilters.push(`${audioOut}${bgMusicLabel}amix=inputs=2:duration=first:dropout_transition=2[audio_mixed]`);
      }
      audioOut = '[audio_mixed]';
    } else {
      postFilters.push(`${audioOut}${bgMusicLabel}amix=inputs=2:duration=first:dropout_transition=2[audio_mixed]`);
      audioOut = '[audio_mixed]';
    }
  }

  if (sfxAudioLabels.length > 0) {
    const inputs = `${audioOut}${sfxAudioLabels.join('')}`;
    postFilters.push(`${inputs}amix=inputs=${sfxAudioLabels.length + 1}:duration=first:dropout_transition=2[audio_sfx_mixed]`);
    audioOut = '[audio_sfx_mixed]';
  }

  postFilters.push(`${audioOut}loudnorm=I=-14:LRA=11:TP=-1.5[final_audio]`);
  audioOut = '[final_audio]';

  const filterComplex = [
    ...videoFilters,
    ...audioFilters,
    ...transitionFilters,
    ...enhancementFilters,
    ...postFilters,
  ].join(';');

  const args = [
    '-y',
    '-threads', '4',
    ...inputArgs,
    ...enhancementInputArgs,
    '-filter_complex', filterComplex,
    '-map', videoOut, '-map', audioOut,
    ...encodeArgs(),
    outputPath,
  ];

  const captionStyleForLog = editPlan.caption_style || 'none';
  const overlayCount = Array.isArray(editPlan.text_overlays) ? editPlan.text_overlays.length : 0;
  const loudnormStatus = 'on';
  console.log(
    `[ffmpeg] Rendering: ${n} clips, ~${runningDuration.toFixed(1)}s output (captions=${captionStyleForLog}, overlays=${overlayCount}, loudnorm=${loudnormStatus})`
  );
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
    '-b:v', '4M',
    '-maxrate', '5M',
    '-bufsize', '10M',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-r', '30',
    '-movflags', '+faststart',
    '-threads', '2',
    '-max_muxing_queue_size', '1024',
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

function roundMs(val) {
  return Math.round(val * 1000) / 1000;
}

function getOutputDimensions(aspectRatio, sourceRes) {
  const dims = {
    '9:16': { width: 1080, height: 1920 },
    '16:9': { width: 1920, height: 1080 },
    '1:1': { width: 1080, height: 1080 },
    '4:5': { width: 1080, height: 1350 },
  };
  if (!aspectRatio || aspectRatio === 'original' || !dims[aspectRatio]) {
    return { width: sourceRes.width, height: sourceRes.height };
  }
  return dims[aspectRatio];
}

function getAspectRatioFilter(targetRatio, inputWidth, inputHeight) {
  if (!targetRatio || targetRatio === 'original') return null;

  const ratios = {
    '9:16': 9 / 16,
    '16:9': 16 / 9,
    '1:1': 1,
    '4:5': 4 / 5,
  };
  const target = ratios[targetRatio];
  if (!target) return null;

  const inputRatio = inputWidth / inputHeight;
  let cropW;
  let cropH;
  if (inputRatio > target) {
    cropH = inputHeight;
    cropW = Math.round(inputHeight * target);
  } else {
    cropW = inputWidth;
    cropH = Math.round(inputWidth / target);
  }

  const x = Math.round((inputWidth - cropW) / 2);
  const y = Math.round((inputHeight - cropH) / 2);
  const output = getOutputDimensions(targetRatio, { width: inputWidth, height: inputHeight });
  return `crop=${cropW}:${cropH}:${x}:${y},scale=${output.width}:${output.height}`;
}

function getSpeedFilters(speed) {
  const safeSpeed = Math.max(0.25, Math.min(4.0, Number(speed) || 1.0));
  const videoFilter = `setpts=${(1 / safeSpeed).toFixed(4)}*PTS`;

  const audioFilters = [];
  let remaining = safeSpeed;
  while (remaining > 2.0) {
    audioFilters.push('atempo=2.0');
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    audioFilters.push('atempo=0.5');
    remaining /= 0.5;
  }
  audioFilters.push(`atempo=${remaining.toFixed(4)}`);

  return {
    video: videoFilter,
    audio: audioFilters.join(','),
  };
}

function getZoomFilter(zoom, clipDuration, width, height) {
  // Use scale+crop instead of zoompan to avoid frozen frame bug.
  // zoompan is designed for still images and causes frame freezes on video.
  // scale+crop operates on the actual video stream and preserves all frames.
  //
  // How it works:
  // 1. Scale the video up by a zoom factor (e.g., 1.0 -> 1.1 over time)
  // 2. Crop back to the original resolution, centered
  // This creates a smooth zoom effect on live video without any frame freezing.
  //
  // The zoom expression uses 'n' (frame number) and 'N' is computed from clip duration.
  // For slow zooms, we interpolate linearly from startZoom to endZoom over all frames.
  // For punch zooms, we ease-in quickly over the first ~10 frames then hold.
  const fps = 30;
  const totalFrames = Math.max(1, Math.round(clipDuration * fps));

  let scaleExpr;

  switch (zoom) {
    case 'slow_in': {
      // Zoom from 1.0 to 1.1 linearly over the clip duration.
      const startZ = 1.0;
      const endZ = 1.1;
      const delta = endZ - startZ;
      scaleExpr = `${startZ}+${delta}*n/${totalFrames}`;
      break;
    }
    case 'slow_out': {
      // Zoom from 1.1 to 1.0 linearly over the clip duration.
      const startZ = 1.1;
      const endZ = 1.0;
      const delta = endZ - startZ;
      scaleExpr = `${startZ}+${delta}*n/${totalFrames}`;
      break;
    }
    case 'punch_in': {
      // Quick zoom from 1.0 to 1.15 in first 10 frames, then hold at 1.15.
      scaleExpr = `if(lt(n\\,10)\\,1.0+0.15*n/10\\,1.15)`;
      break;
    }
    case 'punch_out': {
      // Quick zoom from 1.15 to 1.0 in first 10 frames, then hold at 1.0.
      scaleExpr = `if(lt(n\\,10)\\,1.15-0.15*n/10\\,1.0)`;
      break;
    }
    default:
      return null;
  }

  // Scale per-frame with eval=frame, then crop back to target resolution.
  // Even dimensions are enforced for yuv420p compatibility.
  const filter = `scale=w='trunc(iw*(${scaleExpr})/2)*2':h='trunc(ih*(${scaleExpr})/2)*2':eval=frame:flags=bilinear,crop=${width}:${height}`;
  return filter;
}

function getVignetteFilter(intensity) {
  switch (intensity) {
    case 'light':
      return 'vignette=angle=PI/5';
    case 'medium':
      return 'vignette=angle=PI/4';
    case 'strong':
      return 'vignette=angle=PI/3';
    default:
      return null;
  }
}

function getTransitionTimes(cuts) {
  const times = [];
  if (!Array.isArray(cuts) || cuts.length === 0) return times;
  let running = roundMs(((cuts[0].source_end || 0) - (cuts[0].source_start || 0)) / (cuts[0].speed || 1.0));
  for (let i = 0; i < cuts.length - 1; i++) {
    const transition = cuts[i]?.transition_out || 'clean_cut';
    const eventTime = Math.max(0, running - 0.15);
    times.push(roundMs(eventTime));
    const nextDuration = roundMs(((cuts[i + 1].source_end || 0) - (cuts[i + 1].source_start || 0)) / (cuts[i + 1].speed || 1.0));
    const overlap = transition !== 'clean_cut' ? 0.3 : 0;
    running = roundMs(running + nextDuration - overlap);
  }
  return times;
}

function getOutputClipRanges(cuts) {
  const ranges = [];
  if (!Array.isArray(cuts) || cuts.length === 0) return ranges;
  let cursor = 0;
  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i];
    const duration = ((cut.source_end || 0) - (cut.source_start || 0)) / (cut.speed || 1.0);
    const start = roundMs(cursor);
    const end = roundMs(cursor + duration);
    ranges.push({ start, end });
    const overlap = i < cuts.length - 1 && cut.transition_out !== 'clean_cut' ? 0.3 : 0;
    cursor = roundMs(end - overlap);
  }
  return ranges;
}

function projectWordsToOutput(transcript, cuts) {
  const words = Array.isArray(transcript?.words)
    ? transcript.words
    : (transcript?.results?.channels?.[0]?.alternatives?.[0]?.words || []);
  const projected = [];
  if (!words.length || !cuts?.length) return projected;

  let outputCursor = 0;
  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i];
    const cStart = cut.source_start;
    const cEnd = cut.source_end;
    for (const w of words) {
      const ws = Number(w.start);
      const we = Number(w.end);
      if (!Number.isFinite(ws) || !Number.isFinite(we)) continue;
      if (we <= cStart || ws >= cEnd) continue;
      const overlapStart = Math.max(ws, cStart);
      const overlapEnd = Math.min(we, cEnd);
      const speed = cut.speed || 1.0;
      projected.push({
        start: roundMs(outputCursor + ((overlapStart - cStart) / speed)),
        end: roundMs(outputCursor + ((overlapEnd - cStart) / speed)),
        word: w.punctuated_word || w.word || '',
      });
    }
    const cutDur = (cEnd - cStart) / (cut.speed || 1.0);
    const overlap = i < cuts.length - 1 && cut.transition_out !== 'clean_cut' ? 0.3 : 0;
    outputCursor = roundMs(outputCursor + cutDur - overlap);
  }
  return projected.filter((w) => w.end > w.start);
}

function formatAssTime(seconds) {
  const safe = Math.max(0, seconds || 0);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const cs = Math.round((safe % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function getMarginV(captionPosition, aspectRatio) {
  if (aspectRatio === '9:16') {
    switch (captionPosition) {
      case 'top': return 1500;
      case 'center': return 800;
      case 'lower-third': return 450;
      case 'bottom': return 100;
      default: return 450;
    }
  }

  switch (captionPosition) {
    case 'top': return 800;
    case 'center': return 400;
    case 'lower-third': return 150;
    case 'bottom': return 40;
    default: return 60;
  }
}

function generateSubtitleFile(transcript, captionStyle, cuts, outputRes, outputPath, captionPosition, aspectRatio, captionKeywords) {
  const styles = {
    standard: { fontsize: 42, fontname: 'Arial', bold: 0, alignment: 2, marginV: 60 },
    bold_centered: { fontsize: 56, fontname: 'Arial', bold: 1, alignment: 5, marginV: 0 },
    minimal_bottom: { fontsize: 36, fontname: 'Arial', bold: 0, alignment: 2, marginV: 30 },
    animated_word: { fontsize: 52, fontname: 'Arial', bold: 1, alignment: 5, marginV: 0 },
    bold_white: { fontsize: 58, fontname: 'Arial', bold: 1, alignment: 5, marginV: 0 },
    bold_yellow: { fontsize: 58, fontname: 'Arial', bold: 1, alignment: 5, marginV: 0 },
    keyword_pop: { fontsize: 52, fontname: 'Arial', bold: 1, alignment: 5, marginV: 0 },
    box_caption: { fontsize: 44, fontname: 'Arial', bold: 1, alignment: 2, marginV: 60 },
  };

  const style = styles[captionStyle] || styles.standard;
  const marginV = getMarginV(captionPosition || 'lower-third', aspectRatio || '9:16');
  const words = projectWordsToOutput(transcript, cuts);
  if (!words.length) return null;

  // ASS color format: &HAABBGGRR (alpha, blue, green, red — reversed from RGB!)
  // &H00FFFFFF = white, &H0000FFFF = yellow, &H0000FF00 = green
  // &H000000FF = red, &H00000000 = black, &H80000000 = 50% transparent black
  let primaryColour;
  let outlineColour;
  let backColour;
  let borderStyle;
  let outlineWidth;
  let shadowDepth;

  switch (captionStyle) {
    case 'bold_white':
      primaryColour = '&H00FFFFFF';
      outlineColour = '&H00000000';
      backColour = '&H80000000';
      borderStyle = 1;
      outlineWidth = 3;
      shadowDepth = 2;
      break;
    case 'bold_yellow':
      primaryColour = '&H0000FFFF';
      outlineColour = '&H00000000';
      backColour = '&H80000000';
      borderStyle = 1;
      outlineWidth = 3;
      shadowDepth = 2;
      break;
    case 'box_caption':
      primaryColour = '&H00FFFFFF';
      outlineColour = '&H00000000';
      backColour = '&HC0000000';
      borderStyle = 3;
      outlineWidth = 0;
      shadowDepth = 8;
      break;
    case 'keyword_pop':
      primaryColour = '&H00FFFFFF';
      outlineColour = '&H00000000';
      backColour = '&H80000000';
      borderStyle = 1;
      outlineWidth = 3;
      shadowDepth = 1;
      break;
    default:
      primaryColour = '&H00FFFFFF';
      outlineColour = '&H00000000';
      backColour = '&H80000000';
      borderStyle = 1;
      outlineWidth = 2;
      shadowDepth = 1;
      break;
  }

  let ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${outputRes.width || 1080}
PlayResY: ${outputRes.height || 1920}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontname},${style.fontsize},${primaryColour},&H000000FF,${outlineColour},${backColour},${style.bold},0,0,0,100,100,0,0,${borderStyle},${outlineWidth},${shadowDepth},${style.alignment},20,20,${marginV},1
`;

  if (captionStyle === 'keyword_pop') {
    ass += `Style: KeywordGreen,${style.fontname},${style.fontsize},&H0000FF00,&H000000FF,&H00000000,&H80000000,${style.bold},0,0,0,100,100,0,0,1,3,1,${style.alignment},20,20,${marginV},1\n`;
    ass += `Style: KeywordRed,${style.fontname},${style.fontsize},&H000055FF,&H000000FF,&H00000000,&H80000000,${style.bold},0,0,0,100,100,0,0,1,3,1,${style.alignment},20,20,${marginV},1\n`;
    ass += `Style: KeywordYellow,${style.fontname},${style.fontsize},&H0000FFFF,&H000000FF,&H00000000,&H80000000,${style.bold},0,0,0,100,100,0,0,1,3,1,${style.alignment},20,20,${marginV},1\n`;
  }

  ass += `
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  if (captionStyle === 'animated_word') {
    // Word-by-word: one word at a time
    for (const word of words) {
      ass += `Dialogue: 0,${formatAssTime(word.start)},${formatAssTime(word.end)},Default,,0,0,0,,${word.word}\n`;
    }
  } else if (captionStyle === 'keyword_pop') {
    // Group words into phrases, then highlight keywords with inline color overrides
    const keywordSet = new Set((captionKeywords || []).map((k) => k.toLowerCase()));
    // ASS color override tags: {\c&H00BBGGRR&}
    const highlightColors = [
      '\\c&H0000FF00&', // green
      '\\c&H000055FF&', // red-orange
      '\\c&H0000FFFF&', // yellow
    ];
    const resetColor = '\\c&H00FFFFFF&'; // back to white

    let group = [];
    for (let i = 0; i < words.length; i++) {
      const current = words[i];
      const next = words[i + 1];
      group.push(current);
      const pause = next ? (next.start - current.end) : 1;
      const hitLength = group.length >= 8;
      if (!next || pause > 0.35 || hitLength) {
        const start = group[0].start;
        const end = group[group.length - 1].end;
        let colorIndex = 0;
        const text = group.map((g) => {
          const cleanWord = g.word.replace(/[.,!?;:'"]/g, '').toLowerCase();
          if (keywordSet.has(cleanWord)) {
            const color = highlightColors[colorIndex % highlightColors.length];
            colorIndex++;
            return `{${color}\\b1}${g.word}{${resetColor}\\b1}`;
          }
          return g.word;
        }).join(' ');
        ass += `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${text}\n`;
        group = [];
      }
    }
  } else {
    // All other styles: group words into phrases
    let group = [];
    for (let i = 0; i < words.length; i++) {
      const current = words[i];
      const next = words[i + 1];
      group.push(current);
      const pause = next ? (next.start - current.end) : 1;
      const hitLength = group.length >= 8;
      if (!next || pause > 0.35 || hitLength) {
        const start = group[0].start;
        const end = group[group.length - 1].end;
        const text = group.map((g) => g.word).join(' ');
        ass += `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${text}\n`;
        group = [];
      }
    }
  }

  fs.writeFileSync(outputPath, ass, 'utf8');
  return outputPath;
}

function generateTextOverlays(textOverlays, cuts, sourceRes, outputPath) {
  if (!Array.isArray(textOverlays) || textOverlays.length === 0) return null;

  const styles = {
    title: { fontsize: 72, fontname: 'Arial', bold: 1, outline: 3 },
    callout: { fontsize: 48, fontname: 'Arial', bold: 1, outline: 2 },
    cta: { fontsize: 56, fontname: 'Arial', bold: 1, outline: 2 },
  };

  const positionMap = {
    top: 8,
    center: 5,
    bottom: 2,
  };

  const clipRanges = getOutputClipRanges(cuts);

  let ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${sourceRes.width || 1080}
PlayResY: ${sourceRes.height || 1920}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
`;

  for (let i = 0; i < textOverlays.length; i++) {
    const overlay = textOverlays[i] || {};
    const s = styles[overlay.style] || styles.callout;
    const align = positionMap[overlay.position] || 5;
    const marginV = overlay.position === 'top' ? 100 : overlay.position === 'bottom' ? 80 : 0;
    ass += `Style: Overlay${i},${s.fontname},${s.fontsize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,${s.bold},0,0,0,100,100,0,0,1,${s.outline},1,${align},20,20,${marginV},1\n`;
  }

  ass += `\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  let wroteAny = false;
  for (let i = 0; i < textOverlays.length; i++) {
    const overlay = textOverlays[i] || {};
    const clipIndex = Number(overlay.appear_at_clip) - 1;
    if (clipIndex < 0 || clipIndex >= clipRanges.length) continue;
    const text = String(overlay.text || '').trim();
    if (!text) continue;
    const start = clipRanges[clipIndex].start;
    const end = clipRanges[clipIndex].end;
    ass += `Dialogue: 1,${formatAssTime(start)},${formatAssTime(end)},Overlay${i},,0,0,0,,${text}\n`;
    wroteAny = true;
  }

  if (!wroteAny) return null;
  fs.writeFileSync(outputPath, ass, 'utf8');
  return outputPath;
}

function escapeFilterPath(p) {
  return String(p).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

const soundFallbacks = {
  click: 'pop',
  snap: 'pop',
  slide: 'swoosh',
  glitch: 'whoosh',
  tape_stop: 'rise',
  drop: 'boom',
};

const soundBaseVolumes = {
  pop: 0.25,
  ding: 0.22,
  rise: 0.20,
  whoosh: 0.18,
  swoosh: 0.18,
  boom: 0.12,
};

function getTransitionVolume(soundName, transitionTimestamp, speechSegments) {
  const baseVol = soundBaseVolumes[soundName] || 0.18;
  const duringSpeech = Array.isArray(speechSegments) && speechSegments.some((seg) =>
    transitionTimestamp >= Number(seg.start || 0) && transitionTimestamp <= Number(seg.end || 0)
  );
  const finalVol = duringSpeech ? baseVol * 0.6 : baseVol;
  console.log(
    `[ffmpeg] Sound "${soundName}" vol=${finalVol.toFixed(3)} (base=${baseVol}, ${duringSpeech ? 'during speech' : 'in gap'})`
  );
  return finalVol;
}

function getSoundPath(soundName, soundsDir) {
  if (!soundName || soundName === 'none') return null;

  const primary = path.join(soundsDir, `${soundName}.mp3`);
  if (fs.existsSync(primary)) return primary;

  const fallbackName = soundFallbacks[soundName];
  if (fallbackName) {
    const fallbackPath = path.join(soundsDir, `${fallbackName}.mp3`);
    if (fs.existsSync(fallbackPath)) {
      console.log(`[ffmpeg] Sound "${soundName}" not found, using fallback: ${fallbackName}`);
      return fallbackPath;
    }
  }

  console.log(`[ffmpeg] Transition sound missing and no fallback: ${soundName}`);
  return null;
}

function buildDuckingVolumeEnable(speechSegments, padding = 0.0) {
  if (!Array.isArray(speechSegments) || speechSegments.length === 0) return '';
  return speechSegments
    .map((s) => `between(t,${Math.max(0, (s.start || 0) - padding).toFixed(3)},${Math.max(0, (s.end || 0) + padding).toFixed(3)})`)
    .join('+');
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

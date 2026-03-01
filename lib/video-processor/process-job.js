const { analyzeVideo } = require('./analyze-video');
const { transcribeIfNeeded } = require('./transcribe');
const { generateEdit, expandVibeIntent } = require('./generate-edit');
const { renderVideo, preSplitSourceClips } = require('./render-ffmpeg');
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
    execFile('ffmpeg', ffmpegArgs, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }, (error, _stdout, stderr) => {
      // FFmpeg exits non-zero for null muxer runs in some builds, but stderr still has scdet output.
      if (error && !stderr) {
        reject(error);
        return;
      }
      resolve(stderr || '');
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

/**
 * Pre-download the source video to a local file.
 * This runs in parallel with Claude edit planning so the file
 * is already on disk when FFmpeg needs it.
 */
async function preDownloadVideo(videoUrl, jobId) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `promptly-src-${jobId}-`));
  const sourcePath = path.join(tmpDir, 'source.mp4');

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
  // Release response stream references once the file is on disk.
  response.data = null;
  response = null;

  return sourcePath;
}

async function processVideoJob({ videoUrl, vibeInput, jobId, userId, onProgress }) {
  console.log('\n' + '='.repeat(80));
  console.log(`🚀 JOB ${jobId}: "${vibeInput}"`);
  console.log('='.repeat(80));

  let preDownloadedPath = null;
  let brollTmpDir = null;

  try {
    const downloadPromise = preDownloadVideo(videoUrl, jobId);
    const scdetPromise = downloadPromise.then((localPath) => detectSceneCuts(localPath));
    const analysisPromise = analyzeVideo(videoUrl, onProgress);
    const transcriptPromise = transcribeIfNeeded(videoUrl, null, onProgress);
    const expandedVibePromise = expandVibeIntent(vibeInput);

    // Stage 1 + 2: Run Gemini, Deepgram, source download, scdet, and vibe expansion in parallel.
    const [analysis, transcript, downloadedPath, visualCuts, expandedVibe] = await Promise.all([
      analysisPromise,
      transcriptPromise,
      downloadPromise,
      scdetPromise,
      expandedVibePromise,
    ]);
    preDownloadedPath = downloadedPath;
    console.log(`[process-job] FFmpeg detected ${visualCuts.length} visual cuts`);
    gcHint('transcription and analysis');

    // Build speech data from Deepgram (accurate) instead of Gemini (unreliable).
    let { speech, safeCutPoints } = buildSpeechFromDeepgram(transcript, analysis.duration);
    analysis.speech = speech;
    const deepgramWords = Array.isArray(transcript?.words) ? transcript.words : [];
    const tightenResult = tightenTranscript(deepgramWords, { sceneCuts: visualCuts });
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
    await supabaseAdmin
      .from('video_jobs')
      .update({ analysis_data: analysis })
      .eq('id', jobId);
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

    const editPlan = await generateEdit(analysis, transcript, vibeInput, onProgress, expandedVibe);
    editPlan.analysis_data = analysis;
    gcHint('edit generation');

    // Run b-roll download and clip pre-split in parallel. They are independent
    // and both depend only on Claude's edit output + the source on disk.
    const brollRequests = Array.isArray(editPlan.broll) ? editPlan.broll.slice(0, 3) : [];
    const brollDownloadPromise = (async () => {
      const brollAssets = [];
      if (brollRequests.length > 0) {
        brollTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `promptly-broll-${jobId}-`));
        for (let i = 0; i < brollRequests.length; i++) {
          const req = brollRequests[i] || {};
          const keyword = String(req.keyword || '').trim();
          if (!keyword) continue;
          try {
            const clipInfo = await fetchBrollClip(keyword);
            if (!clipInfo) continue;
            const localPath = path.join(brollTmpDir, `broll_${i}.mp4`);
            await downloadBrollClip(clipInfo, localPath);
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
    const preSplitPromise = preSplitSourceClips(
      preDownloadedPath,
      Array.isArray(editPlan.cuts) ? editPlan.cuts : [],
      path.dirname(preDownloadedPath)
    );
    const [brollAssets, preSplitClipFiles] = await Promise.all([brollDownloadPromise, preSplitPromise]);
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
    // Clean up pre-downloaded file if renderVideo didn't already
    if (preDownloadedPath) {
      try {
        const dir = path.dirname(preDownloadedPath);
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`[process-job] Cleaned up pre-download: ${dir}`);
      } catch (e) {
        // May already be cleaned up by renderVideo, that's fine
      }
    }
    if (brollTmpDir) {
      try {
        fs.rmSync(brollTmpDir, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
}

module.exports = { processVideoJob };

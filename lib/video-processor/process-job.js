const { analyzeVideo } = require('./analyze-video');
const { transcribeIfNeeded } = require('./transcribe');
const { generateEdit } = require('./generate-edit');
const { renderVideo } = require('./render-ffmpeg');
const { supabaseAdmin } = require('../../services/supabase-admin');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Build speech segments, sentence boundaries, and cut points from Deepgram's
 * word-level timestamps. This replaces Gemini's unreliable speech data with
 * frame-accurate data from the audio transcription.
 */
function buildSpeechFromDeepgram(transcript, duration) {
  const words = transcript?.words || [];
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

/**
 * Pre-download the source video to a local file.
 * This runs in parallel with Claude edit planning so the file
 * is already on disk when FFmpeg needs it.
 */
async function preDownloadVideo(videoUrl, jobId) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `promptly-src-${jobId}-`));
  const sourcePath = path.join(tmpDir, 'source.mp4');

  const response = await axios({
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

  return sourcePath;
}

async function processVideoJob({ videoUrl, vibeInput, jobId, onProgress }) {
  console.log('\n' + '='.repeat(80));
  console.log(`🚀 JOB ${jobId}: "${vibeInput}"`);
  console.log('='.repeat(80));

  let preDownloadedPath = null;

  try {
    // Stage 1 + 2: Run Gemini analysis and Deepgram transcription in parallel
    // They don't depend on each other — this saves 10-15 seconds
    const [analysis, transcript] = await Promise.all([
      analyzeVideo(videoUrl, onProgress),
      transcribeIfNeeded(videoUrl, null, onProgress),
    ]);

    // Build speech data from Deepgram (accurate) instead of Gemini (unreliable).
    let { speech, safeCutPoints } = buildSpeechFromDeepgram(transcript, analysis.duration);
    analysis.speech = speech;

    // Add shot-change cut points from Gemini's visual analysis.
    if (Array.isArray(analysis.shots)) {
      for (let i = 0; i < analysis.shots.length - 1; i++) {
        const shotEnd = round3(analysis.shots[i].end);
        const alreadyExists = analysis.safe_cut_points.some((cp) => Math.abs(cp.time - shotEnd) < 0.5);
        if (!alreadyExists) {
          analysis.safe_cut_points.push({
            time: shotEnd,
            quality: 1.0,
            why: 'scene change',
          });
        }
      }
      safeCutPoints.sort((a, b) => a.time - b.time);
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

    // Stage 3: AI creative direction (Claude) + pre-download source video in parallel
    // Claude takes 10-20s to plan. The source download takes 5-15s.
    // Running them together means the file is ready when FFmpeg starts.
    const [editPlan, downloadedPath] = await Promise.all([
      generateEdit(analysis, transcript, vibeInput, onProgress),
      preDownloadVideo(videoUrl, jobId),
    ]);

    preDownloadedPath = downloadedPath;

    // Stage 4 + 5: Render with FFmpeg and upload to Supabase
    // Pass the pre-downloaded source path so renderVideo skips its own download
    const finalVideoUrl = await renderVideo(editPlan, videoUrl, jobId, onProgress, transcript, preDownloadedPath);

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
  }
}

module.exports = { processVideoJob };

const { downloadVideo, cleanupFile } = require('./download.js');
const { extractAudio, getVideoMetadata } = require('./extract-audio.js');
const { transcribeAudio } = require('./transcribe.js');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

/**
 * Simple beat detection for MVP. TODO: Replace with proper beat detection library
 * @param {number} duration - Clip duration in seconds.
 * @returns {number[]} Beat timestamps.
 */
function detectSimpleBeats(duration) {
  const beats = [];
  const beatInterval = 0.5;

  for (let t = 0; t <= duration; t += beatInterval) {
    beats.push(parseFloat(t.toFixed(2)));
  }

  return beats;
}

/**
 * Returns high-confidence words as emphasis moments.
 * @param {Array<{word:string,start:number,end:number,confidence:number}>} words - Word timings.
 * @returns {Array<{timestamp:number,word:string,confidence:number}>}
 */
function identifyEmphasis(words) {
  return (words || [])
    .filter((w) => w.confidence > 0.9)
    .map((w) => ({
      timestamp: w.start,
      word: w.word,
      confidence: w.confidence,
    }));
}

/**
 * Detect scene changes using ffprobe scene score filter.
 * Returns timestamps of likely shot changes.
 * @param {string} videoPath
 * @returns {Promise<number[]>}
 */
async function detectSceneChanges(videoPath) {
  if (!videoPath) return [];
  const escapedPath = String(videoPath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const command = `ffprobe -v error -show_frames -of json -f lavfi "movie='${escapedPath}',select='gt(scene,0.3)'"`;
  try {
    const { stdout } = await execAsync(command, { maxBuffer: 8 * 1024 * 1024 });
    const parsed = JSON.parse(stdout || '{}');
    const frames = Array.isArray(parsed?.frames) ? parsed.frames : [];
    return frames
      .map((frame) => Number(frame?.best_effort_timestamp_time))
      .filter((value) => Number.isFinite(value));
  } catch (error) {
    console.warn('Scene detection failed, continuing without scene data:', error?.message || error);
    return [];
  }
}

/**
 * Estimate motion level heuristically from beat density and scene change count.
 * @param {number} duration
 * @param {number} beatCount
 * @param {number} sceneChangeCount
 * @returns {'low'|'medium'|'high'}
 */
function estimateMotionLevel(duration, beatCount, sceneChangeCount) {
  const safeDuration = Math.max(Number(duration) || 0, 0.001);
  const beatDensity = beatCount / safeDuration;
  if (beatDensity > 2 || sceneChangeCount > 10) return 'high';
  if (beatDensity > 1 || sceneChangeCount > 5) return 'medium';
  return 'low';
}

/**
 * Runs the full analysis pipeline for a clip URL.
 * @param {string} videoUrl - Public URL of the source clip.
 * @returns {Promise<{duration:number,dimensions:{width:number,height:number},fps:number,audio:{transcript:Array,words:Array,fullText:string,beats:number[],emphasisMoments:Array,hasMusic:boolean,hasSpeech:boolean},visual:{hasAudio:boolean},video:{sceneChanges:number,motionLevel:'low'|'medium'|'high'}}>}
 */
async function analyzeClip(videoUrl) {
  let videoPath = null;
  let audioPath = null;

  try {
    console.log('Starting clip analysis...');

    videoPath = await downloadVideo(videoUrl);
    const metadata = await getVideoMetadata(videoPath);
    console.log('Video metadata:', metadata);

    audioPath = await extractAudio(videoPath);
    const transcript = await transcribeAudio(audioPath);

    const beats = detectSimpleBeats(metadata.duration);
    const emphasisMoments = identifyEmphasis(transcript.words);

    const sceneChangeTimestamps = await detectSceneChanges(videoPath);
    const motionLevel = estimateMotionLevel(metadata.duration, beats.length, sceneChangeTimestamps.length);

    const analysis = {
      duration: metadata.duration,
      dimensions: {
        width: metadata.width,
        height: metadata.height,
      },
      fps: metadata.fps,
      audio: {
        transcript: transcript.utterances,
        words: transcript.words,
        fullText: transcript.fullText,
        beats: beats,
        emphasisMoments: emphasisMoments,
        hasMusic: beats.length > metadata.duration * 0.5,
        hasSpeech: transcript.utterances.length > 0,
      },
      visual: {
        hasAudio: metadata.hasAudio,
      },
      video: {
        sceneChanges: sceneChangeTimestamps.length,
        sceneChangeTimestamps,
        motionLevel,
      },
    };

    console.log('Clip analysis complete');
    return analysis;
  } catch (error) {
    console.error('Clip analysis failed:', error);
    throw error;
  } finally {
    if (videoPath) {
      await cleanupFile(videoPath);
    }
    if (audioPath) {
      await cleanupFile(audioPath);
    }
  }
}

module.exports = {
  analyzeClip,
};
